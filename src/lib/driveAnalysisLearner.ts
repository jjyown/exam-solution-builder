/**
 * driveAnalysisLearner.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  Google Drive 「해설제작/분석용 자료」 폴더의 PDF/이미지를 읽어
 *  ReferenceRecord 배열로 변환한다. /auto 의 RAG 검색이 다음 호출부터
 *  이 자료를 자동으로 참고 예시로 활용한다.
 *
 *  추출은 Gemini multimodal (한국어 시험지 친화 프롬프트) 사용.
 *  파일별로 in-memory cache 를 두어, 같은 파일은 modifiedTime 변경 전까지
 *  재호출하지 않는다. (Railway 콜드 스타트 시 1회 비용 발생)
 *
 *  사용처: src/app/api/auto-pipeline/route.ts 의 getRetriever() — 첫 호출 시
 *           kb.jsonl 로드 후 이 모듈로 추가 자료를 합쳐 인덱싱.
 *  강제 재동기화: POST /api/drive/analysis/sync
 * ────────────────────────────────────────────────────────────────────────────
 */
import path from "node:path";
import {
  getDriveClient,
  isGoogleDriveConfigured,
  resolveDriveAnalysisFolderId,
  listDriveFolderFilesRecursive,
  downloadDriveFileById,
} from "./googleDrive";
import { isGeminiVisionAvailable } from "./geminiVisionExtract";
import { extractTextFromUploadedFile } from "./fileExtraction";
import { resolveMathpixCredentials, isMathpixUsableForOcr, isMathpixQuotaError, markMathpixExhausted } from "./mathpixV3Text";
import {
  recognizeMathpixPdf,
  submitMathpixPdf,
  getMathpixPdfStatus,
  getMathpixPdfLinesJson,
} from "./mathpixV3Pdf";
import {
  rebuildTextFromLineData,
  diagnoseLineData,
} from "./mathpixLineDataExtract";
import type { ReferenceRecord } from "./referenceRetriever";
import {
  fetchCachedRecords,
  persistRecordsForFile,
  pruneOrphanRecords,
} from "./analysisRecordsStore";
import { normalizeOcrTextForPairing } from "./analysisTextNormalizer";
import { checkIntegrity, type IntegrityIssue } from "./analysisIntegrityCheck";

type CacheEntry = {
  modifiedTime: string | null;
  records: ReferenceRecord[];
};

const fileCache = new Map<string, CacheEntry>(); // key = drive fileId

const ALLOWED_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

/**
 * 일반 파일(이미지) 최대 크기. 기본 35MB.
 * Gemini inlineData 한도(50MB) + base64 1.33배 OOM 마진. ANALYSIS_FILE_MAX_MB 로 오버라이드.
 */
const ANALYSIS_FILE_MAX_BYTES = (() => {
  const raw = Number(process.env.ANALYSIS_FILE_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 35;
  return mb * 1024 * 1024;
})();

/**
 * PDF 전용 최대 크기. 기본 200MB.
 * PDF 는 base64 변환 없이 Mathpix /v3/pdf 로 직접 multipart 업로드해 메모리 절약.
 * 답지+문제 병합본은 보통 100~300MB 라서 35MB 게이트로는 다 빠지므로 별도 한도.
 * 환경변수: ANALYSIS_PDF_MAX_MB (0 으로 두면 무제한, 기본 200).
 */
const ANALYSIS_PDF_MAX_BYTES = (() => {
  const raw = Number(process.env.ANALYSIS_PDF_MAX_MB);
  if (Number.isFinite(raw) && raw === 0) return Number.MAX_SAFE_INTEGER;
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 200;
  return mb * 1024 * 1024;
})();

/**
 * 너무 작은 파일은 의미 있는 텍스트가 없을 가능성 높음 — Mathpix 호출 절약.
 * 환경변수 ANALYSIS_FILE_MIN_KB 로 오버라이드 가능 (기본 30KB).
 */
const ANALYSIS_FILE_MIN_BYTES = (() => {
  const raw = Number(process.env.ANALYSIS_FILE_MIN_KB);
  const kb = Number.isFinite(raw) && raw >= 0 ? raw : 30;
  return kb * 1024;
})();

/**
 * 분석 대상 서브폴더 화이트리스트 — 「분석용 자료」 루트 직속 폴더 이름.
 * 다른 서브폴더(시험지 편집·휴지통 등) 의 파일은 분석 안 함 → Mathpix 호출 낭비 차단.
 *
 * **우선순위 순서**: 앞에 적힌 폴더 먼저 처리. 시중교재는 해설 제작 메인 참고자료이므로
 * 매쓰픽스 잔여가 떨어져도 먼저 끝나야 함.
 *
 * 환경변수: DRIVE_ANALYSIS_ALLOWED_ROOT_FOLDERS=시중교재,시험지 원안 (콤마 구분)
 */
const ALLOWED_ROOT_FOLDERS_PRIORITY: string[] = (() => {
  const env = process.env.DRIVE_ANALYSIS_ALLOWED_ROOT_FOLDERS?.trim();
  if (env) {
    return env.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return ["시중교재", "시험지 원안"]; // 디폴트: 시중교재 우선
})();
const ALLOWED_ROOT_FOLDERS = new Set(ALLOWED_ROOT_FOLDERS_PRIORITY);

/** Mathpix·Gemini 호출 동시 처리 수 — Hobby tier 안전 마진. */
const ANALYSIS_CONCURRENCY = (() => {
  const raw = Number(process.env.ANALYSIS_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 && raw <= 16 ? raw : 4;
})();

export type AnalysisLearnSummary = {
  configured: boolean;
  folderResolved: boolean;
  totalFiles: number;
  newOrChanged: number;
  records: number;
  errors: string[];
  /** 서브폴더(시중교재 / 개인자료 등) 별 파일 수 */
  bySubfolder: Record<string, number>;
  /** 1:1 매핑 (problem ↔ solution) 통계 — 운영 가시성 + 감독관 임계 검사용 */
  pairing: {
    /** 이번 동기화에서 새로 만들어진 record 중 problem_no 가 있는 것 */
    problemRecords: number;
    /** 그 중 solution_text 까지 가진(=페어 완성) record */
    pairedRecords: number;
    /** 페어 완성률 (paired / problem) — 0~1, 분모 0 이면 0 */
    pairingRate: number;
    /** 문제는 있지만 풀이가 없는 record (solution_text=null + problem_no 있음) */
    unpairedProblems: number;
    /** OCR 정규화 시 매칭된 룰 개수 (디버깅) */
    normalizedFiles: number;
    /**
     * 파일별 페어링률 — 임계치(<40%) 미달 PDF 만 모아 「bbox 재처리 권장 큐」 로 노출.
     * 텍스트 헤더 매칭이 깨졌다는 신호 → scripts/textbook_page_split_mathpix.py
     * (Mathpix include_line_data=true + bbox 분할) 로 재처리하면 살아남.
     * 임계치 이상 파일은 포함하지 않는다 (응답 비대 방지).
     */
    lowPairingFiles: Array<{
      fileId: string;        // bboxFallbackForFile() 호출에 사용
      source: string;        // "drive/분석용자료/시중교재/쎈_대수.pdf"
      problemRecords: number;
      pairedRecords: number;
      rate: number;          // 0~1
    }>;
  };
  /**
   * 화이트리스트 root 폴더(시중교재/시험지 원안 등) 별 처리 결과.
   * "시중교재 PDF가 0건 처리됐다" 같은 진단을 즉시 가능하게 함.
   */
  byRootFolder: Record<
    string,
    {
      filesFound: number;       // 폴더에서 발견된 파일 수 (사이즈 게이트 통과 후)
      sizeSkipped: number;      // 35MB 초과로 skip 된 파일 수
      ocrFailed: number;        // OCR 실패 카운트
      cacheHit: number;         // Supabase 캐시 적중
      newOrChanged: number;     // 새로/재 OCR 된 파일
    }
  >;
  /**
   * 시리즈 무결성 — 같은 series 안 problem_no 시퀀스의 누락·중복·페어 깨짐.
   * 학습 직후 규칙 기반(checkIntegrity)으로 계산. 비용 0.
   * 사용자에게 「쎈 대수 4번 누락」 「EBS 2024 7번 중복」 같은 알림을 보여주는 기반.
   */
  integrity: {
    issuesCount: number;
    counts: { missing: number; duplicate: number; unpaired: number };
    /** 너무 길어지면 응답 비대 — 상위 N개만 노출 */
    sampleIssues: IntegrityIssue[];
  };
};

/**
 * 분석용 자료 폴더의 모든 파일을 ReferenceRecord 로 변환해 반환.
 * 캐시된 파일은 재추출하지 않고 재사용.
 */
export async function loadDriveAnalysisRecords(): Promise<{
  records: ReferenceRecord[];
  summary: AnalysisLearnSummary;
}> {
  const summary: AnalysisLearnSummary = {
    configured: false,
    folderResolved: false,
    totalFiles: 0,
    newOrChanged: 0,
    records: 0,
    errors: [],
    bySubfolder: {},
    pairing: {
      problemRecords: 0,
      pairedRecords: 0,
      pairingRate: 0,
      unpairedProblems: 0,
      normalizedFiles: 0,
      lowPairingFiles: [],
    },
    byRootFolder: {},
    integrity: {
      issuesCount: 0,
      counts: { missing: 0, duplicate: 0, unpaired: 0 },
      sampleIssues: [],
    },
  };

  // 폴더별 카운트를 안전하게 누적하는 헬퍼
  const bumpRoot = (
    root: string,
    field: keyof AnalysisLearnSummary["byRootFolder"][string],
  ) => {
    const key = root || "(루트)";
    summary.byRootFolder[key] ??= {
      filesFound: 0,
      sizeSkipped: 0,
      ocrFailed: 0,
      cacheHit: 0,
      newOrChanged: 0,
    };
    summary.byRootFolder[key][field] += 1;
  };

  if (!isGoogleDriveConfigured()) {
    return { records: [], summary };
  }
  summary.configured = true;

  // OCR 백엔드: Mathpix 또는 Gemini 중 하나는 있어야 함 (Mathpix 우선, 소진 시 Gemini 자동 폴백)
  if (!isGeminiVisionAvailable() && !resolveMathpixCredentials()) {
    summary.errors.push(
      "OCR 백엔드 미설정 — GEMINI_API_KEY 또는 MATHPIX_APP_ID/KEY 가 필요합니다.",
    );
    return { records: [], summary };
  }

  let drive: ReturnType<typeof getDriveClient>;
  try {
    drive = getDriveClient();
  } catch (e) {
    summary.errors.push(`Drive 클라이언트 초기화 실패: ${(e as Error).message}`);
    return { records: [], summary };
  }

  const folderId = await resolveDriveAnalysisFolderId(drive);
  if (!folderId) {
    summary.errors.push("「분석용 자료」 폴더를 찾지 못했습니다 (선택 기능 — 만들지 않으면 동작 안 함).");
    return { records: [], summary };
  }
  summary.folderResolved = true;

  let allFiles;
  try {
    // textbook-drive-build 작업 폴더(시중교재/<책>/pages, .../ocr) 는 분석 OCR 대상에서 제외.
    // pages 하위의 PNG 들이 또 Mathpix OCR 되어 이중 비용 발생하는 것을 막는다.
    // ocr 하위의 .md 들은 어차피 ALLOWED_EXTS(.pdf/.png/.jpg/.jpeg/.webp) 에 안 잡히지만,
    // 명시적으로 walk 차단해 Drive API 호출도 절약.
    const skipFolderNames = new Set(["pages", "ocr"]);
    allFiles = await listDriveFolderFilesRecursive(folderId, ALLOWED_EXTS, 4, skipFolderNames);
  } catch (e) {
    summary.errors.push(`분석용 자료 폴더 목록 조회 실패: ${(e as Error).message}`);
    return { records: [], summary };
  }

  // 폴더 화이트리스트 적용 — 시중교재·시험지 원안 외 폴더 제외 (Mathpix 호출 절약)
  const allowedFiles = allFiles.filter((f) => {
    const root = f.pathSegments[0];
    return root && ALLOWED_ROOT_FOLDERS.has(root);
  });

  // ⚠️ 「분석용 자료」 폴더에 파일은 있는데 화이트리스트와 매칭이 0건인 경우 —
  //    사용자가 폴더명을 바꿨거나 (예: "시중교재" → "교재") 환경변수를 잘못 넣었을 가능성.
  //    조용히 빈 결과로 넘어가면 RAG 가 KB 53건만으로 동작해 디버깅이 어렵다.
  //    => summary.errors 에 명시적 경고 + 발견된 root 폴더 이름들 노출.
  if (allFiles.length > 0 && allowedFiles.length === 0) {
    const foundRoots = Array.from(
      new Set(allFiles.map((f) => f.pathSegments[0]).filter(Boolean)),
    );
    summary.errors.push(
      `화이트리스트 매칭 0건 — 「분석용 자료」 폴더에 ${allFiles.length}개 파일이 있지만 ` +
        `허용된 루트 폴더(${ALLOWED_ROOT_FOLDERS_PRIORITY.join(", ")})와 일치하지 않습니다. ` +
        `발견된 루트 폴더: [${foundRoots.join(", ")}]. ` +
        `폴더명을 맞추거나 DRIVE_ANALYSIS_ALLOWED_ROOT_FOLDERS 환경변수를 조정하세요.`,
    );
  }

  // 우선순위 정렬 — ALLOWED_ROOT_FOLDERS_PRIORITY 앞쪽 폴더 먼저 처리
  // (시중교재 우선 — 해설 제작 메인 참고자료)
  const priorityIndex = new Map<string, number>(
    ALLOWED_ROOT_FOLDERS_PRIORITY.map((name, i) => [name, i]),
  );
  allowedFiles.sort((a, b) => {
    const ra = priorityIndex.get(a.pathSegments[0] ?? "") ?? 999;
    const rb = priorityIndex.get(b.pathSegments[0] ?? "") ?? 999;
    if (ra !== rb) return ra - rb;
    // 같은 폴더 안에선 modifiedTime 최신 먼저 (변경분 우선 흡수)
    return (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "");
  });

  // 너무 작은 파일 스킵 — 의미 있는 본문이 거의 없을 확률 높음
  const files = allowedFiles.filter((f) => {
    if (typeof f.size === "number" && f.size < ANALYSIS_FILE_MIN_BYTES) {
      return false;
    }
    return true;
  });

  summary.totalFiles = files.length;
  // 서브폴더별 파일 수 집계 (필터 후 기준)
  for (const f of files) {
    const key = f.pathSegments.length === 0 ? "(루트)" : f.pathSegments.join(" / ");
    summary.bySubfolder[key] = (summary.bySubfolder[key] ?? 0) + 1;
  }

  type DriveFileMeta = (typeof files)[number];

  /**
   * 큰 PDF (이미지 한도 초과) 전용 경로.
   *  - base64 변환 우회 (메모리 1.33배 절약) → Buffer 직접 Mathpix /v3/pdf 업로드
   *  - 답지+문제 병합본(보통 100~300MB) 처리에 적합
   *  - Mathpix 사용 불가(키 없음·잔여 부족·백오프) 면 skip + errors 에 기록
   *  - 결과는 일반 흐름과 동일하게 splitTextIntoRecords → records 변환
   */
  async function processLargePdfFile(
    f: DriveFileMeta,
    root: string,
  ): Promise<ReferenceRecord[]> {
    if (!(await isMathpixUsableForOcr())) {
      bumpRoot(root, "ocrFailed");
      summary.errors.push(
        `${f.name}: 큰 PDF — Mathpix 사용 불가(키 없음/잔여 부족/백오프). 작게 분할 후 다시 업로드하거나 ANALYSIS_PDF_MAX_MB 조정 필요. (폴더: ${root})`,
      );
      return [];
    }
    const dl = await downloadDriveFileById(f.id);
    const buffer = dl.buffer;
    const mp = await recognizeMathpixPdf(buffer, f.name);
    if (!mp.ok) {
      if (isMathpixQuotaError(mp)) {
        markMathpixExhausted(`large-pdf HTTP ${mp.status}: ${mp.message.slice(0, 100)}`);
      }
      bumpRoot(root, "ocrFailed");
      summary.errors.push(`${f.name}: 큰 PDF Mathpix 실패 — ${mp.message} (폴더: ${root})`);
      return [];
    }
    const normalized = normalizeOcrTextForPairing(mp.text);
    if (normalized.appliedRules.length > 0) {
      summary.pairing.normalizedFiles += 1;
    }
    const records = splitTextIntoRecords(f.id, f.name, f.pathSegments, normalized.text);
    fileCache.set(f.id, { modifiedTime: f.modifiedTime, records });
    try {
      await persistRecordsForFile(f.id, f.modifiedTime, records);
    } catch {
      // silent
    }
    summary.newOrChanged += 1;
    bumpRoot(root, "newOrChanged");
    return records;
  }

  /** 단일 파일 처리 — 캐시 → 다운로드 → OCR → Supabase 저장. */
  async function processOneFile(f: DriveFileMeta): Promise<ReferenceRecord[]> {
    const root = f.pathSegments[0] ?? "(루트)";
    bumpRoot(root, "filesFound");
    // 1) in-memory 캐시 적중
    const cached = fileCache.get(f.id);
    if (cached && cached.modifiedTime === f.modifiedTime) {
      bumpRoot(root, "cacheHit");
      return cached.records;
    }
    // 2) Supabase 영구 캐시 적중 — 재배포·재시작 후에도 OCR 안 함
    const persisted = await fetchCachedRecords(f.id, f.modifiedTime);
    if (persisted && persisted.length > 0) {
      bumpRoot(root, "cacheHit");
      fileCache.set(f.id, { modifiedTime: f.modifiedTime, records: persisted });
      return persisted;
    }
    // 3) 사이즈 게이트 — PDF 와 이미지 분리.
    //    PDF 가 ANALYSIS_FILE_MAX_BYTES(이미지용 35MB) 초과 + ANALYSIS_PDF_MAX_BYTES(200MB) 이하면:
    //      → base64 변환 우회 + Mathpix /v3/pdf 직접 라우팅 (큰 답지 병합본 처리)
    //    이미지가 ANALYSIS_FILE_MAX_BYTES 초과면 그대로 skip (이미지 100MB 는 비현실적).
    const ext = path.extname(f.name).toLowerCase();
    const isPdf = ext === ".pdf";
    if (typeof f.size === "number") {
      const overImg = f.size > ANALYSIS_FILE_MAX_BYTES;
      const overPdf = f.size > ANALYSIS_PDF_MAX_BYTES;
      if (isPdf && overPdf) {
        bumpRoot(root, "sizeSkipped");
        const mb = (f.size / (1024 * 1024)).toFixed(1);
        const limit = (ANALYSIS_PDF_MAX_BYTES / 1024 / 1024) | 0;
        const msg = `${f.name}: ${mb}MB PDF — ANALYSIS_PDF_MAX_MB(${limit}MB) 초과로 OCR skip. (폴더: ${root})`;
        summary.errors.push(msg);
        console.warn(`[driveAnalysisLearner] pdf-size-skip: ${msg}`);
        return [];
      }
      if (!isPdf && overImg) {
        bumpRoot(root, "sizeSkipped");
        const mb = (f.size / (1024 * 1024)).toFixed(1);
        const limit = (ANALYSIS_FILE_MAX_BYTES / 1024 / 1024) | 0;
        const msg = `${f.name}: ${mb}MB — ANALYSIS_FILE_MAX_MB(${limit}MB) 초과로 OCR skip. (폴더: ${root})`;
        summary.errors.push(msg);
        console.warn(`[driveAnalysisLearner] size-skip: ${msg}`);
        return [];
      }
      // PDF 인데 이미지 한도(35MB) 초과 + PDF 한도(200MB) 이하 → 큰 PDF 우회 라우트로
      if (isPdf && overImg && !overPdf) {
        return await processLargePdfFile(f, root);
      }
    }
    // 4) 캐시 둘 다 miss → Mathpix 우선 → Gemini 폴백 OCR
    try {
      let buffer: Buffer | null = null;
      let base64: string | null = null;
      let effectiveMime: string;
      {
        const dl = await downloadDriveFileById(f.id);
        buffer = dl.buffer;
        const ext = path.extname(f.name).toLowerCase();
        effectiveMime =
          dl.mimeType ||
          (ext === ".pdf"
            ? "application/pdf"
            : ext === ".png"
              ? "image/png"
              : "image/jpeg");
        base64 = buffer.toString("base64");
        buffer = null; // GC 후보
      }
      const ext = path.extname(f.name).toLowerCase();
      const v = await extractTextFromUploadedFile({
        fileData: base64,
        fileName: f.name,
        fileType: effectiveMime || (ext === ".pdf" ? "application/pdf" : "image/jpeg"),
      });
      base64 = null;
      if (!v.ok) {
        bumpRoot(root, "ocrFailed");
        summary.errors.push(`${f.name}: ${v.error} (폴더: ${root})`);
        return [];
      }
      // OCR 결과를 표준 헤더로 사전 정규화 — 1:1 매핑 적중률 향상.
      // 부작용: 본문은 그대로, 마커만 표준화. 변환이 0건이면 그대로 통과.
      const normalized = normalizeOcrTextForPairing(v.text);
      if (normalized.appliedRules.length > 0) {
        summary.pairing.normalizedFiles += 1;
      }
      const records = splitTextIntoRecords(f.id, f.name, f.pathSegments, normalized.text);
      fileCache.set(f.id, { modifiedTime: f.modifiedTime, records });
      try {
        await persistRecordsForFile(f.id, f.modifiedTime, records);
      } catch {
        // silent
      }
      summary.newOrChanged += 1;
      bumpRoot(root, "newOrChanged");
      return records;
    } catch (e) {
      bumpRoot(root, "ocrFailed");
      summary.errors.push(`${f.name}: ${(e as Error).message} (폴더: ${root})`);
      return [];
    }
  }

  // ── 동시 처리 pool ────────────────────────────────────────────────
  // - 정렬된 순서(시중교재 우선)대로 worker 가 dequeue
  // - 작업자 N 개가 병렬로 다음 파일을 가져와 처리
  // - 결과는 입력 순서대로 누적 (시중교재 records 가 앞쪽)
  const all: ReferenceRecord[] = [];
  let nextIdx = 0;
  await Promise.all(
    Array.from({ length: Math.min(ANALYSIS_CONCURRENCY, files.length) }, async () => {
      while (true) {
        const idx = nextIdx;
        nextIdx += 1;
        if (idx >= files.length) return;
        const records = await processOneFile(files[idx]);
        for (const r of records) all.push(r);
      }
    }),
  );

  // 별도 PDF 페어 매칭 (예: "쎈_대수_문제.pdf" + "쎈_대수_해설.pdf")
  // 같은 series 의 문제 record · 풀이 record 를 problem_no 로 join 해서
  // 문제 record 에 solution_text 를 채워 넣는다.
  const merged = mergePairedSeparatePdfs(all);

  // Drive 에서 삭제된 파일의 Supabase row 정리 (best-effort).
  // 화이트리스트 외 폴더 파일도 「존재」 한다고 보고 prune 대상에서 제외 (= allFiles 전체 ID).
  // → 사용자가 화이트리스트 바꿔도 옛 OCR 결과 보존, Drive 에서 진짜 삭제된 것만 정리.
  try {
    await pruneOrphanRecords(allFiles.map((f) => f.id));
  } catch {
    // silent
  }

  summary.records = merged.length;

  // 매핑 통계 — problem_no 가 있는 record 중 solution_text 까지 가진 비율
  let problemRecs = 0;
  let pairedRecs = 0;
  // 파일별 집계 (페어링 깨진 PDF 식별용) — source 와 fileId 둘 다 보존
  const perFile = new Map<string, { fileId: string; problem: number; paired: number }>();
  for (const r of merged) {
    if (typeof r.problem_no !== "number") continue;
    problemRecs += 1;
    const fileKey = r.source; // "drive/분석용자료/시중교재/쎈_대수.pdf"
    // record id 형식 "drive:{fileId}#{problem_no}" 에서 fileId 추출
    const m = /^drive:([^#]+)#/.exec(r.id);
    const fileId = m ? m[1] : "";
    const slot = perFile.get(fileKey) ?? { fileId, problem: 0, paired: 0 };
    if (!slot.fileId && fileId) slot.fileId = fileId;
    slot.problem += 1;
    if (r.solution_text && r.solution_text.trim()) {
      pairedRecs += 1;
      slot.paired += 1;
    }
    perFile.set(fileKey, slot);
  }
  summary.pairing.problemRecords = problemRecs;
  summary.pairing.pairedRecords = pairedRecs;
  summary.pairing.unpairedProblems = problemRecs - pairedRecs;
  summary.pairing.pairingRate = problemRecs > 0 ? pairedRecs / problemRecs : 0;

  // 임계치(<40%) 미달 + 최소 표본(problem ≥ 5) 충족 파일만 큐에 — 노이즈 차단.
  // 페어링률 오름차순 → 가장 깨진 PDF 가 위쪽.
  const LOW_PAIRING_THRESHOLD = 0.4;
  const MIN_PROBLEM_SAMPLES = 5;
  const lowPairingFiles: AnalysisLearnSummary["pairing"]["lowPairingFiles"] = [];
  for (const [source, stat] of perFile.entries()) {
    if (stat.problem < MIN_PROBLEM_SAMPLES) continue;
    const rate = stat.problem > 0 ? stat.paired / stat.problem : 0;
    if (rate >= LOW_PAIRING_THRESHOLD) continue;
    lowPairingFiles.push({
      fileId: stat.fileId,
      source,
      problemRecords: stat.problem,
      pairedRecords: stat.paired,
      rate,
    });
  }
  lowPairingFiles.sort((a, b) => a.rate - b.rate);
  summary.pairing.lowPairingFiles = lowPairingFiles.slice(0, 30); // 응답 비대 방지

  // 무결성 검사 — 누락/중복/페어 깨짐. 비용 0 규칙 기반.
  const integrity = checkIntegrity(merged);
  summary.integrity = {
    issuesCount: integrity.issues.length,
    counts: integrity.counts,
    sampleIssues: integrity.issues.slice(0, 30),
  };
  if (integrity.issues.length > 0) {
    console.warn(
      `[driveAnalysisLearner] integrity: 누락 ${integrity.counts.missing}, 중복 ${integrity.counts.duplicate}, 페어 깨짐 ${integrity.counts.unpaired}`,
    );
  }

  return { records: merged, summary };
}

/**
 * "쎈_문제.pdf" + "쎈_해설.pdf" 처럼 별도 PDF 로 올라온 페어를 파일명 휴리스틱으로
 * 묶고, 문제 record 의 solution_text 를 풀이 record 에서 가져와 채운다.
 * 이미 1:1 매핑된 record (problem_no 와 solution_text 가 같이 있는) 는 그대로 둔다.
 */
function mergePairedSeparatePdfs(records: ReferenceRecord[]): ReferenceRecord[] {
  type Bucket = { series: string; kind: "problem" | "solution"; records: ReferenceRecord[] };
  const buckets = new Map<string, Bucket>();

  for (const r of records) {
    if (r.solution_text) continue; // 이미 합본 페어링
    if (typeof r.problem_no !== "number") continue; // 페어링 가능한 row 만 후보
    const meta = inferSeriesAndKindFromSource(r.source);
    if (!meta) continue;
    const key = `${meta.series}::${meta.kind}`;
    const bucket = buckets.get(key) ?? { series: meta.series, kind: meta.kind, records: [] };
    bucket.records.push(r);
    buckets.set(key, bucket);
  }

  // 같은 series 의 problem ↔ solution 매핑
  const result = records.slice();
  const indexById = new Map(result.map((r, i) => [r.id, i] as const));
  const seriesNames = new Set<string>();
  for (const b of buckets.values()) seriesNames.add(b.series);

  for (const series of seriesNames) {
    const problemBucket = buckets.get(`${series}::problem`);
    const solutionBucket = buckets.get(`${series}::solution`);
    if (!problemBucket || !solutionBucket) continue;
    const solByNo = new Map<number, ReferenceRecord>();
    for (const s of solutionBucket.records) {
      if (typeof s.problem_no !== "number") continue;
      const exist = solByNo.get(s.problem_no);
      if (!exist || (s.content?.length ?? 0) > (exist.content?.length ?? 0)) {
        solByNo.set(s.problem_no, s);
      }
    }
    for (const p of problemBucket.records) {
      if (typeof p.problem_no !== "number") continue;
      const sol = solByNo.get(p.problem_no);
      if (!sol) continue;
      const idx = indexById.get(p.id);
      if (idx === undefined) continue;
      result[idx] = {
        ...p,
        solution_text: sol.content,
        solution_equations: sol.equations,
        pair_series: series,
        problem_hint: `${p.problem_hint} (풀이 페어 ✓)`,
      };
    }
  }
  return result;
}

/** "drive/분석용자료/시중교재/쎈_대수_문제.pdf" → { series: "쎈 대수", kind: "problem" } */
function inferSeriesAndKindFromSource(
  source: string,
): { series: string; kind: "problem" | "solution" } | null {
  // 파일명만 추출
  const filename = source.split("/").pop() ?? source;
  const lower = filename.toLowerCase();
  const isSolution = /해설|정답|answer|solution/.test(lower) || /해설|정답/.test(filename);
  const isProblem = /문제|기출|워크북|problem|question/.test(lower) || /문제|기출|워크북/.test(filename);
  if (!isSolution && !isProblem) return null;
  // 시리즈 이름 = 파일명에서 키워드/확장자/구분자 떼어낸 것
  let series = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_\s\-]?(문제|기출|워크북|problem|question|해설|정답|answer|solution)[_\s\-]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!series) return null;
  return { series, kind: isSolution ? "solution" : "problem" };
}

/** 캐시 강제 무효화 — sync 엔드포인트가 사용 */
export function invalidateAnalysisCache(): void {
  fileCache.clear();
}

/**
 * bbox(line_data) 폴백 재처리 — 페어링률 <40% PDF 한 개에 대해
 * Mathpix `lines.json` 응답으로 좌표 기반 segment 분할 → 표준 헤더 텍스트 재구성
 * → splitTextIntoRecords 재호출 → 페어링률 비교 → 향상되면 records 영속화.
 *
 *  - 일반 sync 와 분리된 명시적 호출 (POST /api/drive/analysis/bbox-fallback).
 *  - 비용: Mathpix /v3/pdf 1회 추가 호출 + lines.json 다운로드.
 *  - 향상이 없으면 옛 records 보존 (롤백 안전).
 */
export type BboxFallbackResult =
  | {
      ok: true;
      fileId: string;
      fileName: string;
      before: { problem: number; paired: number; rate: number };
      after: { problem: number; paired: number; rate: number };
      improved: boolean;
      diagnostics: {
        totalLines: number;
        problemHeaderCount: number;
        hasSolutionSection: boolean;
      };
      pdfId: string;
    }
  | { ok: false; fileId: string; status: number; message: string };

export async function bboxFallbackForFile(fileId: string): Promise<BboxFallbackResult> {
  // 1) Drive 메타·다운로드 + 기존 records 페어링률 측정
  let dl: { buffer: Buffer; mimeType: string; name: string };
  try {
    dl = await downloadDriveFileById(fileId);
  } catch (e) {
    return { ok: false, fileId, status: 502, message: `Drive 다운로드 실패: ${(e as Error).message}` };
  }
  const fileName = dl.name;

  // 기존 캐시된 records — 비교 기준선
  const cached = fileCache.get(fileId);
  const beforeStat = measurePairing(cached?.records ?? []);

  // 2) Mathpix submit (lines.json 포함)
  const sub = await submitMathpixPdf(dl.buffer, fileName, { includeLineData: true });
  if (!sub.ok) {
    return { ok: false, fileId, status: sub.status, message: `Mathpix 제출 실패: ${sub.message}` };
  }
  const pdfId = sub.pdfId;

  // 3) 폴링 — recognizeMathpixPdf 와 동일 정책, 단 결과는 lines.json 으로 받음
  const startedAt = Date.now();
  const maxWaitMs = 5 * 60 * 1000;
  let pollIntervalMs = 3000;
  while (Date.now() - startedAt < maxWaitMs) {
    const st = await getMathpixPdfStatus(pdfId);
    if (!st.ok) {
      if (st.status >= 500 && st.status < 600) {
        await sleep(pollIntervalMs);
        pollIntervalMs = Math.min(10000, Math.floor(pollIntervalMs * 1.3));
        continue;
      }
      return { ok: false, fileId, status: st.status, message: `Mathpix 상태 조회 실패: ${st.message}` };
    }
    if (st.body.status === "completed") break;
    if (st.body.status === "error") {
      return {
        ok: false,
        fileId,
        status: 422,
        message: st.body.error ?? "Mathpix 처리 실패",
      };
    }
    await sleep(pollIntervalMs);
    pollIntervalMs = Math.min(10000, Math.floor(pollIntervalMs * 1.3));
  }

  // 4) lines.json 다운로드
  const ld = await getMathpixPdfLinesJson(pdfId);
  if (!ld.ok) {
    return { ok: false, fileId, status: ld.status, message: `lines.json 다운로드 실패: ${ld.message}` };
  }
  const diag = diagnoseLineData(ld.data);

  // 헤더로 식별 가능한 줄이 너무 적으면 폴백 효과 없음 — 조기 종료
  if (diag.problemHeaderCount < 3) {
    return {
      ok: true,
      fileId,
      fileName,
      before: beforeStat,
      after: beforeStat,
      improved: false,
      diagnostics: diag,
      pdfId,
    };
  }

  // 5) 표준 헤더 텍스트 재구성 → records 재계산
  const rebuilt = rebuildTextFromLineData(ld.data);
  const meta = cached
    ? null
    : await (async () => {
        // pathSegments 는 캐시가 없으면 추정 — Drive listing 재실행은 비싸므로 단순화.
        // source path 가 없어도 splitTextIntoRecords 는 fileName 만으로 동작.
        return null;
      })();
  void meta;
  const records = splitTextIntoRecords(fileId, fileName, [], rebuilt);
  const afterStat = measurePairing(records);
  const improved = afterStat.rate > beforeStat.rate + 0.05; // 5%p 이상 향상돼야 채택

  // 6) 향상되면 영속화 + 캐시 갱신. 아니면 그대로 둠.
  if (improved) {
    try {
      // modifiedTime 은 알 수 없을 수 있으므로 현재 시각으로 갱신 — 다음 sync 가
      // 진짜 modifiedTime 으로 다시 덮어씀.
      const now = new Date().toISOString();
      await persistRecordsForFile(fileId, now, records);
      fileCache.set(fileId, { modifiedTime: now, records });
    } catch (e) {
      console.warn(`[bboxFallback] persist 실패: ${(e as Error).message}`);
    }
  }

  return {
    ok: true,
    fileId,
    fileName,
    before: beforeStat,
    after: afterStat,
    improved,
    diagnostics: diag,
    pdfId,
  };
}

function measurePairing(records: ReferenceRecord[]): { problem: number; paired: number; rate: number } {
  let problem = 0;
  let paired = 0;
  for (const r of records) {
    if (typeof r.problem_no !== "number") continue;
    problem += 1;
    if (r.solution_text && r.solution_text.trim()) paired += 1;
  }
  return { problem, paired, rate: problem > 0 ? paired / problem : 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 추출된 텍스트를 적당한 단위로 잘라 ReferenceRecord 로 만든다.
 *
 * 우선순위:
 *  1) [문항 N] + [해설 N] 또는 [해설] 섹션이 동시에 있으면 → 1:1 매핑된 페어 record
 *  2) 문항 번호 헤더만 있으면 → 문항 단위 chunk (풀이 없음)
 *  3) 둘 다 없으면 → 1500자 단위 chunk
 */
function splitTextIntoRecords(
  fileId: string,
  fileName: string,
  pathSegments: string[],
  text: string,
): ReferenceRecord[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  const subPath = pathSegments.length > 0 ? `${pathSegments.join("/")}/` : "";
  const sourcePath = `drive/분석용자료/${subPath}${fileName}`;

  // 1) 1:1 매핑 시도
  const paired = parseProblemSolutionPairs(cleaned);
  if (paired.length >= 2) {
    return paired.map((p) => ({
      id: `drive:${fileId}#${p.problem_no}`,
      source: sourcePath,
      answer: p.answer,
      problem_hint: `${subPath}${fileName} ${p.problem_no}번${p.solution ? " (풀이 포함)" : ""}`,
      content: p.question,
      equations: extractEquationsHeuristic(p.question),
      problem_no: p.problem_no,
      solution_text: p.solution || undefined,
      solution_equations: p.solution ? extractEquationsHeuristic(p.solution) : undefined,
    }));
  }

  // 2) 문항 헤더만 있는 경우 — 문항 단위 chunk
  const labeled = cleaned.match(/\[문항\s*\d+\][\s\S]*?(?=\[문항\s*\d+\]|$)/g);
  if (labeled && labeled.length >= 2) {
    return labeled.map((chunk, idx) =>
      buildRecord(fileId, fileName, pathSegments, idx, chunk.trim()),
    );
  }

  // 3) 헤더 없음 — 1500자 단위 chunk (옛 흐름)
  const chunks: string[] = [];
  const MAX = 1500;
  let buf = "";
  for (const para of cleaned.split(/\n\s*\n+/)) {
    if (!para.trim()) continue;
    if ((buf + "\n\n" + para).length > MAX && buf) {
      chunks.push(buf.trim());
      buf = para;
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  if (chunks.length === 0) return [];
  return chunks.map((chunk, idx) => buildRecord(fileId, fileName, pathSegments, idx, chunk));
}

/**
 * 텍스트에서 문항 N 과 해설 N 을 짝지어 추출.
 * 인식 헤더:
 *  - `[문항 N]`, `[해설 N]`
 *  - "1.", "1)", "1번" (앞 줄 시작에 위치)
 *  - "[해설]", "[정답 및 해설]", "정답 및 해설", "해설" 단독 줄 → 풀이 섹션 시작
 *
 * 빈 페이지·중복 페이지 안전:
 *  - 같은 N 의 풀이 여러 개면 가장 긴 것을 선택 (빈 페이지 무시)
 *  - 빈 풀이는 undefined 처리
 */
type Pair = {
  problem_no: number;
  question: string;
  solution: string;
  answer: string;
};

function parseProblemSolutionPairs(fullText: string): Pair[] {
  // 풀이 섹션 시작 마커 — 첫 번째 매치 위치를 분리점으로 사용
  const solutionSectionRe =
    /(?:^|\n)\s*(?:\[정답\s*및\s*해설\]|\[해설\]|정답\s*및\s*해설|해설)\s*\n/m;
  const solStartMatch = fullText.match(solutionSectionRe);
  let problemSection = fullText;
  let solutionSection = "";
  if (solStartMatch && solStartMatch.index !== undefined) {
    problemSection = fullText.slice(0, solStartMatch.index);
    solutionSection = fullText.slice(solStartMatch.index + solStartMatch[0].length);
  }

  const problems = parseNumberedItems(problemSection);
  if (problems.length < 2) return []; // 매핑 의미 없음 → 옛 흐름으로

  // 풀이 섹션이 없으면 — `[해설 N]` 인라인 마커가 본문에 흩어진 케이스 시도
  let solutions: { no: number; text: string }[] = [];
  if (solutionSection) {
    solutions = parseNumberedItems(solutionSection);
  } else {
    solutions = parseInlineSolutionMarkers(fullText);
  }

  // 같은 N 여러 개면 가장 긴 것 선택 (빈 페이지·중복 페이지 안전)
  const solMap = new Map<number, string>();
  for (const s of solutions) {
    const t = s.text.trim();
    if (!t) continue;
    const existing = solMap.get(s.no);
    if (!existing || t.length > existing.length) {
      solMap.set(s.no, t);
    }
  }

  return problems.map((p) => {
    const sol = solMap.get(p.no) || "";
    // 풀이에서 [정답] 라인 추출
    const answerMatch = sol.match(/\[정답\]\s*([^\n]+)/);
    return {
      problem_no: p.no,
      question: p.text,
      solution: sol,
      answer: answerMatch ? answerMatch[1].trim() : "",
    };
  });
}

/** "1.", "1)", "[문항 1]", "1번" 같은 번호 헤더로 문항을 분리. */
function parseNumberedItems(text: string): { no: number; text: string }[] {
  const re = /(?:^|\n)\s*(?:\[문항\s*(\d{1,3})\]|\[해설\s*(\d{1,3})\]|(\d{1,3})\s*[\.\)]|(\d{1,3})\s*번\s)/g;
  const matches: { no: number; start: number; headerEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const noStr = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!noStr) continue;
    const no = Number(noStr);
    if (!Number.isFinite(no) || no <= 0 || no > 100) continue;
    matches.push({ no, start: m.index, headerEnd: m.index + m[0].length });
  }
  if (matches.length === 0) return [];

  // 단조 증가 시퀀스 우선 (1, 2, 3, ...) 선택해 노이즈 제거
  const filtered = filterMonotonic(matches);

  const items: { no: number; text: string }[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const start = filtered[i].headerEnd;
    const end = i + 1 < filtered.length ? filtered[i + 1].start : text.length;
    items.push({ no: filtered[i].no, text: text.slice(start, end).trim() });
  }
  return items;
}

/** [해설 N] 마커가 본문 안에 흩어져 있는 케이스. 별도 풀이 섹션 없을 때 fallback. */
function parseInlineSolutionMarkers(text: string): { no: number; text: string }[] {
  const re = /\[해설\s*(\d{1,3})\]/g;
  const matches: { no: number; start: number; headerEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const no = Number(m[1]);
    if (!Number.isFinite(no) || no <= 0 || no > 100) continue;
    matches.push({ no, start: m.index, headerEnd: m.index + m[0].length });
  }
  return matches.map((mt, i) => {
    const start = mt.headerEnd;
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    return { no: mt.no, text: text.slice(start, end).trim() };
  });
}

/** 가장 긴 단조 증가 부분수열 선택 (1,2,3,... 흐름 우선). */
function filterMonotonic(
  list: { no: number; start: number; headerEnd: number }[],
): { no: number; start: number; headerEnd: number }[] {
  if (list.length === 0) return [];
  // DP: longest non-decreasing subsequence by no, position-ordered
  const n = list.length;
  const lengths = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  let bestEnd = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (list[j].no <= list[i].no && lengths[j] + 1 > lengths[i]) {
        lengths[i] = lengths[j] + 1;
        prev[i] = j;
      }
    }
    if (lengths[i] > lengths[bestEnd]) bestEnd = i;
  }
  const out: typeof list = [];
  for (let i = bestEnd; i !== -1; i = prev[i]) out.push(list[i]);
  out.reverse();
  return out;
}

function buildRecord(
  fileId: string,
  fileName: string,
  pathSegments: string[],
  idx: number,
  content: string,
): ReferenceRecord {
  // 서브폴더(시중교재 / 개인자료 등)는 출처에 명시해 RAG 디버깅 시 어디서 매칭됐는지 추적 가능
  const subPath = pathSegments.length > 0 ? `${pathSegments.join("/")}/` : "";
  return {
    id: `drive:${fileId}#${idx}`,
    source: `drive/분석용자료/${subPath}${fileName}`,
    answer: "",
    problem_hint: `${subPath}${fileName} (참고자료 #${idx + 1})`,
    content,
    equations: extractEquationsHeuristic(content),
  };
}

function extractEquationsHeuristic(text: string): string[] {
  const out: string[] = [];
  const blockRe = /\$\$([\s\S]+?)\$\$/g;
  const inlineRe = /\$([^$\n]+)\$/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) out.push(m[1].trim());
  while ((m = inlineRe.exec(text)) !== null) out.push(m[1].trim());
  return Array.from(new Set(out)).slice(0, 12);
}
