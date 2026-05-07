/**
 * src/app/api/drive/analysis/sync/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST /api/drive/analysis/sync
 *    Drive 「해설제작/분석용 자료」 폴더를 다시 읽어 KB 캐시를 갱신.
 *    응답: { ok, summary: AnalysisLearnSummary }
 *
 *  GET  /api/drive/analysis/sync
 *    캐시 비우지 않고 현재 상태만 조회 (시운전·디버그용).
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import {
  invalidateAnalysisCache,
  loadDriveAnalysisRecords,
} from "@/lib/driveAnalysisLearner";
import { resetAutoPipelineRetriever } from "@/lib/autoPipelineRetriever";

export async function POST() {
  invalidateAnalysisCache();
  resetAutoPipelineRetriever();
  const { records, summary } = await loadDriveAnalysisRecords();
  return NextResponse.json({ ok: true, summary, recordCount: records.length });
}

export async function GET() {
  const { records, summary } = await loadDriveAnalysisRecords();
  return NextResponse.json({ ok: true, summary, recordCount: records.length });
}
