/**
 * GET /api/health
 * ────────────────────────────────────────────────────────────────────────────
 *  가벼운 healthcheck — Railway 의 deploy.healthcheckPath 가 호출.
 *  의존성 없이 즉시 200 응답 → 콜드스타트 시 30초 timeout 안에 안전하게 통과.
 *
 *  무거운 work (kb.jsonl 로드, retriever 초기화) 은 첫 사용자 요청 때 처리.
 *  /api/auto-pipeline 의 GET (kb_size 반환) 은 진단용으로 별도 유지.
 */
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "highroad-math-solution",
    ts: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
  });
}
