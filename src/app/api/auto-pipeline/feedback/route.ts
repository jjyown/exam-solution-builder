/**
 * src/app/api/auto-pipeline/feedback/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  자동 파이프라인 실행에 대한 사용자 피드백 영속화.
 *  POST { runId, userRating?, userFeedback?, finalBody? }
 *  GET  ?limit=30 → 최근 실행 이력
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { listRecentRuns, recordUserFeedback } from "@/lib/autoPipelineLog";

export async function POST(req: Request) {
  let body: {
    runId?: string;
    userRating?: number;
    userFeedback?: string;
    finalBody?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.runId) {
    return NextResponse.json({ ok: false, error: "runId is required" }, { status: 400 });
  }
  const result = await recordUserFeedback({
    runId: body.runId,
    userRating: body.userRating,
    userFeedback: body.userFeedback,
    finalBody: body.finalBody,
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 30)));
  const rows = await listRecentRuns(limit);
  return NextResponse.json({ ok: true, runs: rows });
}
