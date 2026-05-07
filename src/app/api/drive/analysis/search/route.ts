/**
 * src/app/api/drive/analysis/search/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  GET /api/drive/analysis/search?q=조건부확률&limit=20
 *    분석용 자료(시중교재/개인자료) 영구 캐시(Supabase analysis_records)
 *    안에서 키워드 검색. problem_hint + content trigram 부분일치.
 *    응답: { ok, results: [{ id, source, problem_hint, snippet, ... }] }
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { searchAnalysisRecords } from "@/lib/analysisRecordsStore";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(100, Math.max(1, Number(limitParam) || 20));
  if (!q) return NextResponse.json({ ok: true, results: [] });
  const results = await searchAnalysisRecords(q, limit);
  return NextResponse.json({ ok: true, query: q, count: results.length, results });
}
