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
  resetMathpixExhausted,
} from "@/lib/mathpixV3Text";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = /^(1|true)$/i.test(url.searchParams.get("force") ?? "");
  // 충전 후 매쓰픽스 다시 활성화 — ?resetExhaustion=1
  const resetExhaustion = /^(1|true)$/i.test(url.searchParams.get("resetExhaustion") ?? "");
  if (resetExhaustion) {
    resetMathpixExhausted();
  }

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

  // exhaustedUntilMs 가 MAX_SAFE_INTEGER 이면 ISO 변환 X (Date 가 invalid)
  const isPermanent = exhaustedUntilMs >= Number.MAX_SAFE_INTEGER;
  const exhaustedUntilIso =
    !exhaustedUntilMs || isPermanent
      ? null
      : new Date(exhaustedUntilMs).toISOString();

  return NextResponse.json({
    ok: true,
    configured,
    exhausted,
    exhaustedUntilMs,
    exhaustedUntilIso,
    exhaustedPermanent: isPermanent,
    resetPerformed: resetExhaustion,
    usage: usage
      ? {
          callsThisPeriod: usage.callsThisPeriod,
          callsRemaining: usage.callsRemaining,
          billingPeriodEnd: usage.billingPeriodEnd,
        }
      : null,
    lowThreshold,
    primary,
    hint: isPermanent && exhausted
      ? "매쓰픽스 영구 비활성 상태. 충전 후 다시 쓰려면 ?resetExhaustion=1 또는 서버 재시작."
      : undefined,
  });
}
