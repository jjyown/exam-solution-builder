/**
 * src/app/api/drive/analysis/backfill-pairing/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST: 기존 analysis_records 중 problem_no 가 null 인 row 에 대해
 *        content 에서 번호를 사후 추출해 update.
 *
 *        재OCR 없이 텍스트 분석만 — Mathpix/Gemini 호출 0, 비용 0.
 *
 *  body (JSON, 옵션):
 *    { dryRun: true|false }   기본 true (먼저 미리보기 권장)
 *    { maxApply: 5000 }       실제 update 안전 한도
 *
 *  응답:
 *    {
 *      ok, dryRun,
 *      result: { scanned, alreadyHadProblemNo, extracted, applied, samples[30], failures }
 *    }
 *
 *  GET: 빠른 미리보기 (dry-run 자동)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { backfillProblemNumbers } from "@/lib/analysisRecordsBackfill";

export async function GET() {
  const result = await backfillProblemNumbers({ dryRun: true });
  return NextResponse.json({ ok: true, dryRun: true, result });
}

export async function POST(req: Request) {
  let body: { dryRun?: boolean; maxApply?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const dryRun = body.dryRun !== false;  // 명시적 false 가 아니면 dry-run
  const maxApply = Math.max(1, Math.min(20000, Number(body.maxApply) || 5000));
  const result = await backfillProblemNumbers({ dryRun, maxApply });
  return NextResponse.json({ ok: true, dryRun, result });
}
