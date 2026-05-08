/**
 * GET /api/mathpix-status
 * ────────────────────────────────────────────────────────────────────────────
 *  매쓰픽스 사용량 + 자동 폴백 상태 조회 — 브라우저에서 잔여 크레딧 확인용.
 *  실제 호출 비용 (5분 캐시 무효화 시 1회 호출)
 *
 *  응답:
 *    {
 *      ok: true,
 *      configured: bool,
 *      exhausted: bool,                  // 1시간 백오프 중인지
 *      exhaustedUntilMs: number,         // 백오프 만료 timestamp (0 = 백오프 없음)
 *      exhaustedUntilIso: string | null,
 *      usage: {
 *        callsThisPeriod: number | null,
 *        callsRemaining: number | null,
 *        billingPeriodEnd: string | null,
 *      } | null,
 *      lowThreshold: number,             // 잔여 ≤ 이 값이면 즉시 백오프
 *      primary: "gemini" | "mathpix",    // EXTRACTION_PRIMARY
 *    }
 */
import { NextResponse } from "next/server";
import {
  getMathpixAccountUsage,
  isMathpixExhausted,
  getMathpixExhaustedUntilMs,
  resolveMathpixCredentials,
} from "@/lib/mathpixV3Text";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = /^(1|true)$/i.test(url.searchParams.get("force") ?? "");

  const configured = !!resolveMathpixCredentials();
  const exhausted = isMathpixExhausted();
  const exhaustedUntilMs = getMathpixExhaustedUntilMs();
  const usage = configured ? await getMathpixAccountUsage({ force }) : null;
  const lowThreshold = (() => {
    const raw = Number(process.env.MATHPIX_LOW_THRESHOLD);
    return Number.isFinite(raw) && raw > 0 ? raw : 50;
  })();
  const primary = (() => {
    const v = (process.env.EXTRACTION_PRIMARY || "").trim().toLowerCase();
    return v === "mathpix" ? "mathpix" : "gemini";
  })();

  return NextResponse.json({
    ok: true,
    configured,
    exhausted,
    exhaustedUntilMs,
    exhaustedUntilIso: exhaustedUntilMs ? new Date(exhaustedUntilMs).toISOString() : null,
    usage: usage
      ? {
          callsThisPeriod: usage.callsThisPeriod,
          callsRemaining: usage.callsRemaining,
          billingPeriodEnd: usage.billingPeriodEnd,
        }
      : null,
    lowThreshold,
    primary,
  });
}
