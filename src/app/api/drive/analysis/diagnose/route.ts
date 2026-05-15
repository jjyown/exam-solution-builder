/**
 * src/app/api/drive/analysis/diagnose/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  GET /api/drive/analysis/diagnose
 *    Drive 「분석용 자료」 폴더의 모든 파일을 화이트리스트별·사이즈별로 집계해
 *    "왜 시중교재가 처리 안 됐나" 같은 진단을 즉시 보여준다.
 *
 *  응답 예:
 *  {
 *    ok: true,
 *    rootFolders: {
 *      "시중교재": {
 *        totalFiles: 12,
 *        sizeBuckets: { "0-30KB": 0, "30KB-1MB": 0, "1-35MB": 2, "35MB+": 10 },
 *        sizeSkipExpected: 10,         // 35MB 초과 = OCR skip 예상
 *        sampleSkips: ["...mb수학_답지포함.pdf 152.4MB", ...]
 *      },
 *      "시험지 원안": { ... }
 *    },
 *    sizeLimitMb: 35,
 *    config: { allowedRoots: [...], minKb: 30 }
 *  }
 *
 *  ⚠️ Drive list API 만 호출 (다운로드/OCR 안 함) — 가벼운 진단.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import {
  getDriveClient,
  isGoogleDriveConfigured,
  listDriveFolderFilesRecursive,
  resolveDriveAnalysisFolderId,
} from "@/lib/googleDrive";
import { fetchAllRecords } from "@/lib/analysisRecordsStore";
import { checkIntegrity } from "@/lib/analysisIntegrityCheck";

const ALLOWED_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

/**
 * 시스템 폴더 — 학습 대상이 아니라 시험지 편집 워크플로 용 입력/출력/휴지통.
 * 화이트리스트에 안 들어가는 게 정상이므로 추천 액션에서 「화이트리스트 추가」 권유 X.
 */
const SYSTEM_FOLDERS = new Set([
  "시험지 편집",
  "시험지 편집 전",
  "시험지 편집 후",
  "휴지통",
  "_archive",
]);

function bucket(sizeBytes: number | null): string {
  if (sizeBytes === null) return "size-unknown";
  if (sizeBytes < 30 * 1024) return "0-30KB";
  if (sizeBytes < 1024 * 1024) return "30KB-1MB";
  if (sizeBytes < 35 * 1024 * 1024) return "1-35MB";
  return "35MB+";
}

export async function GET() {
  try {
    if (!isGoogleDriveConfigured()) {
      return NextResponse.json({ ok: false, error: "Google Drive 환경변수 미설정" }, { status: 400 });
    }
    const drive = getDriveClient();
    const folderId = await resolveDriveAnalysisFolderId(drive);
    if (!folderId) {
      return NextResponse.json({ ok: false, error: "「분석용 자료」 폴더를 찾을 수 없음" }, { status: 404 });
    }
    const all = await listDriveFolderFilesRecursive(folderId, ALLOWED_EXTS);

    // 화이트리스트 (env or 기본) — driveAnalysisLearner 와 같은 동선
    const envRoots = process.env.DRIVE_ANALYSIS_ALLOWED_ROOT_FOLDERS?.trim();
    const allowedRoots = envRoots
      ? envRoots.split(",").map((s) => s.trim()).filter(Boolean)
      : ["시중교재", "시험지 원안"];
    const allowedSet = new Set(allowedRoots);

    const sizeLimitMb = (() => {
      const raw = Number(process.env.ANALYSIS_FILE_MAX_MB);
      return Number.isFinite(raw) && raw > 0 ? raw : 35;
    })();
    const minKb = (() => {
      const raw = Number(process.env.ANALYSIS_FILE_MIN_KB);
      return Number.isFinite(raw) && raw >= 0 ? raw : 30;
    })();
    const sizeLimitBytes = sizeLimitMb * 1024 * 1024;
    const minBytes = minKb * 1024;

    type FolderStat = {
      totalFiles: number;
      whitelisted: boolean;
      isSystem: boolean;            // 시험지 편집/휴지통 등 시스템 폴더(학습 대상 X)
      sizeBuckets: Record<string, number>;
      sizeSkipExpected: number;     // > sizeLimit 초과로 OCR skip 예상
      tooSmallExpected: number;     // < minKb 미만으로 skip 예상
      sampleSkips: Array<{ name: string; sizeMB: string }>;
      sampleEligible: Array<{ name: string; sizeMB: string }>;
    };

    const byRoot: Record<string, FolderStat> = {};
    const noRootFiles: typeof all = [];

    for (const f of all) {
      const root = f.pathSegments[0] ?? "(루트)";
      if (root === "(루트)") {
        noRootFiles.push(f);
        continue;
      }
      byRoot[root] ??= {
        totalFiles: 0,
        whitelisted: allowedSet.has(root),
        isSystem: SYSTEM_FOLDERS.has(root),
        sizeBuckets: { "0-30KB": 0, "30KB-1MB": 0, "1-35MB": 0, "35MB+": 0, "size-unknown": 0 },
        sizeSkipExpected: 0,
        tooSmallExpected: 0,
        sampleSkips: [],
        sampleEligible: [],
      };
      const stat = byRoot[root];
      stat.totalFiles += 1;
      const b = bucket(f.size ?? null);
      stat.sizeBuckets[b] = (stat.sizeBuckets[b] ?? 0) + 1;
      if (typeof f.size === "number") {
        const mb = (f.size / (1024 * 1024)).toFixed(1);
        if (f.size > sizeLimitBytes) {
          stat.sizeSkipExpected += 1;
          if (stat.sampleSkips.length < 5) stat.sampleSkips.push({ name: f.name, sizeMB: mb });
        } else if (f.size < minBytes) {
          stat.tooSmallExpected += 1;
        } else {
          if (stat.sampleEligible.length < 3) stat.sampleEligible.push({ name: f.name, sizeMB: mb });
        }
      }
    }

    // Supabase 의 모든 analysis_records 를 한번에 받아 무결성 검사 + series 별 통계.
    // 누락/중복/페어 깨짐 + 폴더별 record 수를 한 응답에 같이 담아 한 페이지 진단.
    type SeriesStat = {
      series: string;
      rootFolder: string;          // "시중교재" / "시험지 원안" / 기타
      sourceFile: string;          // 마지막 source 파일명
      totalRecords: number;
      withProblemNo: number;
      paired: number;              // problem_no + solution_text 둘 다 있음
      pairingRate: number;
      problemNos: { min: number | null; max: number | null; count: number };
    };
    let integritySummary: {
      totalRecords: number;
      totalSeries: number;
      counts: { missing: number; duplicate: number; unpaired: number };
      issues: ReturnType<typeof checkIntegrity>["issues"];
      seriesStats: SeriesStat[];
      perRootRecordCounts: Record<string, number>;
    } | null = null;
    try {
      const allRecords = await fetchAllRecords();
      const ig = checkIntegrity(allRecords);

      // series 별 통계 집계
      const seriesMap = new Map<string, SeriesStat>();
      const perRoot: Record<string, number> = {};
      for (const r of allRecords) {
        const src = r.source || "";
        // "drive/분석용자료/시중교재/EBS_2024.pdf" → root="시중교재", file="EBS_2024.pdf"
        const segs = src.split("/").filter(Boolean);
        const rootFolder = segs.length >= 3 ? segs[2] : "(기타)";
        const sourceFile = segs[segs.length - 1] || src;
        perRoot[rootFolder] = (perRoot[rootFolder] ?? 0) + 1;

        const seriesKey = (r.pair_series && r.pair_series.trim()) || sourceFile;
        const stat = seriesMap.get(seriesKey) ?? {
          series: seriesKey,
          rootFolder,
          sourceFile,
          totalRecords: 0,
          withProblemNo: 0,
          paired: 0,
          pairingRate: 0,
          problemNos: { min: null as number | null, max: null as number | null, count: 0 },
        };
        stat.totalRecords += 1;
        if (typeof r.problem_no === "number") {
          stat.withProblemNo += 1;
          stat.problemNos.count += 1;
          if (stat.problemNos.min === null || r.problem_no < stat.problemNos.min) {
            stat.problemNos.min = r.problem_no;
          }
          if (stat.problemNos.max === null || r.problem_no > stat.problemNos.max) {
            stat.problemNos.max = r.problem_no;
          }
          if (r.solution_text && r.solution_text.trim()) {
            stat.paired += 1;
          }
        }
        seriesMap.set(seriesKey, stat);
      }
      // 페어링률 계산
      for (const stat of seriesMap.values()) {
        stat.pairingRate = stat.withProblemNo > 0 ? stat.paired / stat.withProblemNo : 0;
      }
      const seriesStats = Array.from(seriesMap.values()).sort((a, b) => b.totalRecords - a.totalRecords);

      integritySummary = {
        totalRecords: ig.totalRecords,
        totalSeries: ig.totalSeries,
        counts: ig.counts,
        issues: ig.issues.slice(0, 100),
        seriesStats: seriesStats.slice(0, 200),  // 응답 비대 방지
        perRootRecordCounts: perRoot,
      };
    } catch (e) {
      integritySummary = null;
    }

    // ── 자동 추천 액션 ─────────────────────────────────────────────
    // 진단 결과를 보고 사용자가 다음에 할 일을 한 줄씩 제시. 운영자 친화적.
    const recommendations: Array<{
      priority: "high" | "medium" | "low";
      action: string;
      detail: string;
    }> = [];

    // 화이트리스트 미매칭 폴더 — 시스템 폴더는 자동 제외 (시험지 편집·휴지통 등은 학습 대상 X)
    for (const root of Object.keys(byRoot)) {
      if (SYSTEM_FOLDERS.has(root)) continue;  // 시스템 폴더는 추천 안 함
      if (!byRoot[root].whitelisted && byRoot[root].totalFiles > 0) {
        recommendations.push({
          priority: "high",
          action: `폴더 「${root}」 화이트리스트 추가`,
          detail: `${byRoot[root].totalFiles}개 파일이 화이트리스트(${allowedRoots.join(", ")})에 없어 학습 안 됨. ` +
            `Railway Variables 에 DRIVE_ANALYSIS_ALLOWED_ROOT_FOLDERS=${[...allowedRoots, root].join(",")} 추가. ` +
            `학습 대상이 아니라면 그대로 두어도 무방.`,
        });
      }
    }

    // 사이즈 초과 PDF — 이미 PDF 라우트가 200MB 까지 흡수. 그래도 200MB 초과면 분할 권장.
    let totalSizeSkipExpected = 0;
    for (const stat of Object.values(byRoot)) totalSizeSkipExpected += stat.sizeSkipExpected;
    if (totalSizeSkipExpected > 0) {
      recommendations.push({
        priority: "medium",
        action: `사이즈 초과 PDF 처리 — ${totalSizeSkipExpected}건`,
        detail: `이미지 한도(${sizeLimitMb}MB) 초과 PDF 는 자동으로 Mathpix /v3/pdf 라우트로 처리됩니다 (PDF 한도 ANALYSIS_PDF_MAX_MB 기본 200MB 안에서). ` +
          `200MB 초과 PDF 가 있다면 Drive 에서 페이지 단위로 분할해 다시 업로드하거나 ANALYSIS_PDF_MAX_MB 환경변수를 상향.`,
      });
    }

    // 시중교재 폴더가 있는데 처리됨이 0인 케이스
    const sijungStat = byRoot["시중교재"];
    if (sijungStat && sijungStat.totalFiles > 0 && integritySummary) {
      const sijungInDb = (integritySummary.issues || []).filter(
        (i) => i.series.includes("시중교재") || (i as { source?: string }).source?.includes?.("시중교재"),
      ).length;
      if (sijungInDb === 0 && sijungStat.totalFiles > 0) {
        recommendations.push({
          priority: "high",
          action: "시중교재 처리 미진행 — 다음 자동 동기화 또는 즉시 「분석자료 새로 학습」 클릭",
          detail: `Drive 「시중교재」 폴더에 ${sijungStat.totalFiles}개 PDF 가 있지만 analysis_records 에 데이터가 없습니다. ` +
            `백그라운드 동기화(4시간 주기)가 아직 안 돌았거나 큰 PDF 라 처리 시간이 걸리는 중일 수 있음. 즉시 트리거하려면 /auto 헤더 「분석자료 새로 학습」 버튼.`,
        });
      }
    }

    // 무결성 이슈 자동 추천
    if (integritySummary) {
      if (integritySummary.counts.missing > 0) {
        recommendations.push({
          priority: "medium",
          action: `누락된 문항 ${integritySummary.counts.missing}건 검출`,
          detail: "같은 series 안 problem_no 시퀀스에 빈 번호가 있습니다 — Drive 에서 답지·문제집 PDF 페이지 누락 또는 OCR 실패 가능. " +
            "응답의 integrity.issues[kind=missing] 항목을 확인해 어느 PDF 인지 식별 후 재업로드.",
        });
      }
      if (integritySummary.counts.duplicate > 0) {
        recommendations.push({
          priority: "low",
          action: `중복 문항 ${integritySummary.counts.duplicate}건 검출`,
          detail: "같은 (series, problem_no) 가 두 번 이상 나타남 — 같은 페이지가 두 번 OCR 됐거나 다른 페이지가 같은 번호 라벨. " +
            "integrity.issues[kind=duplicate] 의 contentDigests 비교로 진짜 중복인지 판단.",
        });
      }
      if (integritySummary.counts.unpaired > 0) {
        recommendations.push({
          priority: "high",
          action: `페어 깨진 record ${integritySummary.counts.unpaired}건 — AI 보조 정제 권장`,
          detail: "문제는 있는데 풀이가 없거나 반대. ASSISTED_PAIRING_ENABLED=true 설정 후 " +
            "POST /api/drive/analysis/refine-pairing { \"apply\": false } 로 dry-run → { \"apply\": true } 로 적용.",
        });
      }
    }

    // 화이트리스트 폴더의 파일별 처리 상태 — DB record 와 join 해서
    // 사용자가 「시중교재 8개 PDF 중 5개는 사이즈 초과, 2개는 처리 진행 중, 1개는 캐시 됨」 식으로 즉시 파악 가능.
    type FileStatus = {
      name: string;
      sizeMB: string;
      mimeType: string;
      modifiedTime: string | null;
      hasDbRecord: boolean;       // analysis_records 에 source 매칭 row 있음
      recordCount: number;
      status:
        | "processed"             // OCR + DB 저장 완료
        | "size-skipped-image"    // 이미지 한도 초과로 skip
        | "size-skipped-pdf"      // PDF 한도 초과로 skip
        | "too-small"             // 30KB 미만 — 의미 없는 파일
        | "pending";              // 학습 안 됐지만 사이즈 OK (다음 동기화 대기)
      reason: string;
    };
    const filesPerWhitelist: Record<string, FileStatus[]> = {};
    if (integritySummary) {
      // source path 끝의 파일명을 기준으로 record 카운트 매핑
      const recordCountByFile = new Map<string, number>();
      for (const [, count] of Object.entries(integritySummary.perRootRecordCounts)) {
        // perRootRecordCounts 는 폴더 단위 — 파일 단위는 seriesStats 에 있음
        void count;
      }
      for (const stat of integritySummary.seriesStats) {
        recordCountByFile.set(stat.sourceFile, stat.totalRecords);
      }
      // 화이트리스트 폴더만 자세히
      for (const f of all) {
        const root = f.pathSegments[0];
        if (!root || !allowedSet.has(root)) continue;
        const sizeBytes = typeof f.size === "number" ? f.size : 0;
        const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
        const ext = (f.name.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
        const isPdf = ext === ".pdf";
        const recordCount = recordCountByFile.get(f.name) ?? 0;
        const hasDbRecord = recordCount > 0;
        const pdfMax = (Number(process.env.ANALYSIS_PDF_MAX_MB) || 200) * 1024 * 1024;
        let status: FileStatus["status"];
        let reason: string;
        if (hasDbRecord) {
          status = "processed";
          reason = `DB 안 ${recordCount}개 record`;
        } else if (sizeBytes < minBytes) {
          status = "too-small";
          reason = `${minKb}KB 미만 — 자동 skip`;
        } else if (isPdf && sizeBytes > pdfMax) {
          status = "size-skipped-pdf";
          reason = `${sizeMB}MB > PDF 한도 ${(pdfMax / 1024 / 1024) | 0}MB`;
        } else if (!isPdf && sizeBytes > sizeLimitBytes) {
          status = "size-skipped-image";
          reason = `${sizeMB}MB > 이미지 한도 ${sizeLimitMb}MB`;
        } else {
          status = "pending";
          reason = isPdf && sizeBytes > sizeLimitBytes
            ? `다음 동기화 대기 — 큰 PDF (${sizeMB}MB) Mathpix /v3/pdf 라우트로 처리 예정`
            : `다음 동기화 대기 — 백그라운드 4시간 주기 또는 「분석자료 새로 학습」 버튼으로 즉시`;
        }
        filesPerWhitelist[root] ??= [];
        filesPerWhitelist[root].push({
          name: f.name,
          sizeMB,
          mimeType: f.mimeType,
          modifiedTime: f.modifiedTime,
          hasDbRecord,
          recordCount,
          status,
          reason,
        });
      }
      // 각 폴더별 status desc 순으로 정렬 (pending 먼저 — 사용자 관심사)
      const order = ["pending", "size-skipped-pdf", "size-skipped-image", "too-small", "processed"];
      for (const root of Object.keys(filesPerWhitelist)) {
        filesPerWhitelist[root].sort((a, b) => {
          const ai = order.indexOf(a.status);
          const bi = order.indexOf(b.status);
          if (ai !== bi) return ai - bi;
          return a.name.localeCompare(b.name);
        });
      }
    }

    // Mathpix 폐기 — Gemini 단일 OCR 정책. 호환을 위해 필드는 null 유지.
    const mathpixStatus = null;

    return NextResponse.json({
      ok: true,
      driveAnalysisFolderId: folderId,
      rootFolders: byRoot,
      noRootFilesCount: noRootFiles.length,
      sizeLimitMb,
      pdfLimitMb: Number(process.env.ANALYSIS_PDF_MAX_MB) || 200,
      minKb,
      config: { allowedRoots, sizeLimitMb, minKb },
      integrity: integritySummary,
      filesPerWhitelist,
      mathpixStatus,
      recommendations,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
