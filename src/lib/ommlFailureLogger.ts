/**
 * src/lib/ommlFailureLogger.ts
 *
 * OMML 변환 실패 자동 로그 (fire-and-forget) — PR-1 Commit 3.
 *
 * 명시적 정확도 개선 사이클의 데이터 소스:
 *   1) 의뢰인이 'X문제 수식 깨짐' 보고
 *   2) 시스템이 자동으로 어떤 LaTeX 토큰이 실패했는지 본 모듈을 통해 Supabase 에 누적
 *   3) 주 1회 또는 5건 누적 시 변환기(`latexToOmml.ts`) 에 해당 토큰 추가 commit
 *
 * 호출 흐름:
 *   examExplanationDocx.ts (sync) — catch 안에서
 *     logOmmlFailure(latex, e).catch(() => {});  // fire-and-forget, await 불가
 *
 * 안전 가드:
 *   - 절대 throw 안 함 (sync 호출처 안전망)
 *   - Supabase client null 이면 silent skip
 *   - INSERT 실패도 silent
 *   - owner_id 분당 100건 cap (in-memory rate limit) — DoS 자가 보호
 *   - 시스템 sentinel owner_id (호출처에서 ownerId 못 받을 때) 도 cap 적용
 *
 * Memory 정합:
 *   - `feedback_safety_guards_for_automation` (toggle/한도/모니터링 3종)
 *   - `feedback_sync_dynamic_import` — sync 호출처 fire-and-forget 정합
 */
import { getSupabaseServiceClient } from "@/lib/supabaseServiceClient";

const SYSTEM_OWNER_SENTINEL = "00000000-0000-0000-0000-000000000000";
const RATE_CAP_PER_MINUTE = 100;
const RATE_WINDOW_MS = 60_000;

type RateBucket = { windowStart: number; count: number };
const rateBuckets = new Map<string, RateBucket>();

function isRateLimited(ownerId: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ownerId);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    rateBuckets.set(ownerId, { windowStart: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_CAP_PER_MINUTE;
}

export type OmmlFailureErrorType = "unsupported_token" | "parse_error" | "tree_invalid";

function classifyError(error: unknown): OmmlFailureErrorType {
  const msg = (error as { message?: string })?.message?.toLowerCase() ?? "";
  if (msg.includes("unsupported")) return "unsupported_token";
  if (msg.includes("tree") || msg.includes("invalid")) return "tree_invalid";
  return "parse_error";
}

export async function logOmmlFailure(
  rawLatex: string,
  error: unknown,
  options?: { ownerId?: string; examPaperId?: string },
): Promise<void> {
  try {
    const ownerId = options?.ownerId ?? SYSTEM_OWNER_SENTINEL;
    if (isRateLimited(ownerId)) return;

    const client = getSupabaseServiceClient();
    if (!client) return;

    await client.from("omml_conversion_failures").insert({
      owner_id: ownerId,
      raw_latex: rawLatex.slice(0, 2000),
      error_type: classifyError(error),
      exam_paper_id: options?.examPaperId ?? null,
    });
  } catch {
    // best-effort fire-and-forget — INSERT 실패도 silent.
    // 호출처는 sync 함수 catch 안에서 `.catch(() => {})` 로 본 Promise 를 잡는다.
  }
}
