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

    // Supabase 의 모든 analysis_records 를 한번에 받아 무결성 검사 — 비용 0.
    // 누락/중복/페어 깨짐을 한 응답에 같이 담아 사용자가 한 페이지에서 진단 가능.
    let integritySummary: {
      totalRecords: number;
      totalSeries: number;
      counts: { missing: number; duplicate: number; unpaired: number };
      issues: ReturnType<typeof checkIntegrity>["issues"];
    } | null = null;
    try {
      const allRecords = await fetchAllRecords();
      const ig = checkIntegrity(allRecords);
      integritySummary = {
        totalRecords: ig.totalRecords,
        totalSeries: ig.totalSeries,
        counts: ig.counts,
        // 응답 비대 방지 — 100건만
        issues: ig.issues.slice(0, 100),
      };
    } catch (e) {
      integritySummary = null;
    }

    return NextResponse.json({
      ok: true,
      driveAnalysisFolderId: folderId,
      rootFolders: byRoot,
      noRootFilesCount: noRootFiles.length,
      sizeLimitMb,
      minKb,
      config: { allowedRoots, sizeLimitMb, minKb },
      integrity: integritySummary,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
