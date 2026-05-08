/**
 * Mathpix OCR v3 `/v3/text` — 서버 전용. Gemini multimodal 의 폴백.
 * @see https://docs.mathpix.com/reference/post-v3-text
 */

export type MathpixV3TextJson = {
  request_id?: string;
  text?: string;
  latex_styled?: string;
  confidence?: number;
  confidence_rate?: number;
  error?: string;
  error_info?: { id?: string; message?: string };
  image_height?: number;
  image_width?: number;
  version?: string;
  is_printed?: boolean;
  is_handwritten?: boolean;
};

const MATHPIX_ENDPOINT =
  process.env.MATHPIX_API_URL?.trim() || "https://api.mathpix.com/v3/text";

/** KaTeX 프롬프트와 맞추기 위해 인라인/디스플레이 구분자를 $ / $$ 로 요청 */
export function defaultMathpixRequestOptions(): Record<string, unknown> {
  return {
    rm_spaces: true,
    math_inline_delimiters: ["$", "$"],
    math_display_delimiters: ["$$", "$$"],
  };
}

export function buildMathpixSrcDataUrl(base64: string, mimeType: string): string {
  const mime = mimeType.trim().toLowerCase() || "image/png";
  const b64 = base64.replace(/\s/g, "");
  return `data:${mime};base64,${b64}`;
}

/** Mathpix 문서: base64 인코딩 이미지는 약 2MB 상한 */
export function mathpixBase64WithinLimit(base64: string, maxBytes = 2 * 1024 * 1024): boolean {
  return Buffer.byteLength(base64, "utf8") <= maxBytes;
}

export function resolveMathpixCredentials(): { appId: string; appKey: string } | null {
  const appId =
    process.env.MATHPIX_APP_ID?.trim() ||
    process.env.MATHPIX_APPID?.trim() ||
    process.env.MATHPIX_ID?.trim() ||
    "";
  const appKey =
    process.env.MATHPIX_APP_KEY?.trim() ||
    process.env.MATHPIX_KEY?.trim() ||
    process.env.MATHPIX_API_KEY?.trim() ||
    "";
  if (!appId || !appKey) return null;
  return { appId, appKey };
}

export async function postMathpixV3Text(params: {
  src: string;
  extraOptions?: Record<string, unknown>;
}): Promise<{ ok: true; data: MathpixV3TextJson } | { ok: false; status: number; message: string }> {
  const cred = resolveMathpixCredentials();
  if (!cred) {
    return {
      ok: false,
      status: 501,
      message:
        "MATHPIX_APP_ID / MATHPIX_APP_KEY 가 설정되지 않았습니다. console.mathpix.com 에서 발급한 값을 .env.local 에 넣으세요.",
    };
  }

  const body = JSON.stringify({
    src: params.src,
    ...defaultMathpixRequestOptions(),
    ...(params.extraOptions ?? {}),
  });

  let res: Response;
  try {
    res = await fetch(MATHPIX_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        app_id: cred.appId,
        app_key: cred.appKey,
      },
      body,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, message: `Mathpix 네트워크 오류: ${msg}` };
  }

  const raw = await res.text();
  let data: MathpixV3TextJson;
  try {
    data = JSON.parse(raw) as MathpixV3TextJson;
  } catch {
    return {
      ok: false,
      status: res.status || 502,
      message: `Mathpix 응답 파싱 실패 (HTTP ${res.status}): ${raw.slice(0, 400)}`,
    };
  }

  if (!res.ok) {
    const msg =
      data.error ||
      data.error_info?.message ||
      (typeof raw === "string" ? raw.slice(0, 400) : "알 수 없는 오류");
    return { ok: false, status: res.status, message: `Mathpix HTTP ${res.status}: ${msg}` };
  }

  if (data.error && !data.text?.trim()) {
    return { ok: false, status: 422, message: data.error };
  }

  return { ok: true, data };
}

export async function recognizeMathpixFromImageBase64(
  imageBase64: string,
  imageMimeType: string,
  extraOptions?: Record<string, unknown>,
): Promise<{ ok: true; data: MathpixV3TextJson } | { ok: false; status: number; message: string }> {
  const clean = imageBase64.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
  if (!mathpixBase64WithinLimit(clean)) {
    return {
      ok: false,
      status: 413,
      message:
        "이미지가 Mathpix base64 한도(약 2MB)를 초과합니다. 더 작은 크롭을 사용하거나 해상도를 낮추세요.",
    };
  }
  const src = buildMathpixSrcDataUrl(clean, imageMimeType);
  return postMathpixV3Text({ src, extraOptions });
}

// ─── 사용량 추적 + 자동 폴백 (사용자 $20 크레딧 소진 후 Gemini 자동 전환) ──
//
// 동작:
//  1. `getMathpixAccountUsage()` — `/v3/account` 폴링 (5분 캐시)
//     · `calls_remaining` 확인하여 50 이하면 「조만간 소진」 으로 판단
//  2. `isMathpixExhausted()` — 마지막으로 잔여 부족·credit error 감지된 후 1시간 동안 true
//  3. OCR 호출 측에서 `isMathpixUsableForOcr()` 로 체크 → false 면 Mathpix skip 하고 Gemini 호출
//  4. Mathpix HTTP 402/403 또는 응답에 「out of credits」 류 메시지 보이면 즉시 exhausted 마킹
//  5. 1시간 지나면 자동 재시도 (충전됐을 가능성 가정)

export type MathpixAccountUsage = {
  callsThisPeriod: number | null;
  callsRemaining: number | null;
  billingPeriodEnd: string | null;
  /** 응답 raw — 디버깅용 */
  raw: Record<string, unknown> | null;
};

let exhaustedUntilMs = 0;
let cachedUsage: { fetchedAtMs: number; data: MathpixAccountUsage | null } | null = null;

const USAGE_CACHE_MS = 5 * 60 * 1000; // 5분 캐시

/**
 * 소진 감지 후 비활성 시간 (ms).
 *  - 디폴트: `Number.MAX_SAFE_INTEGER` = 영구 (프로세스 재시작 전까지 매쓰픽스 안 씀)
 *  - 사용자 의도: 「소진하면 이제 사용 안 함」
 *  - 충전 후 다시 쓰고 싶으면:
 *      1) 서버 재시작 (Railway 재배포 시 자동 초기화)
 *      2) 또는 GET /api/mathpix-status?resetExhaustion=1 호출
 *      3) 또는 MATHPIX_RETRY_AFTER_EXHAUSTION_MIN env 로 자동 재시도 분 설정
 */
const EXHAUSTED_BACKOFF_MS = (() => {
  const raw = Number(process.env.MATHPIX_RETRY_AFTER_EXHAUSTION_MIN);
  if (Number.isFinite(raw) && raw > 0) return raw * 60 * 1000;
  return Number.MAX_SAFE_INTEGER;
})();
const MATHPIX_LOW_THRESHOLD = (() => {
  const raw = Number(process.env.MATHPIX_LOW_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : 50;
})();

const MATHPIX_ACCOUNT_ENDPOINT =
  process.env.MATHPIX_ACCOUNT_URL?.trim() || "https://api.mathpix.com/v3/account";

/** Mathpix 계정 사용량 조회 — 5분 캐시. 자격증명 없으면 null. */
export async function getMathpixAccountUsage(
  opts?: { force?: boolean },
): Promise<MathpixAccountUsage | null> {
  if (
    !opts?.force &&
    cachedUsage &&
    Date.now() - cachedUsage.fetchedAtMs < USAGE_CACHE_MS
  ) {
    return cachedUsage.data;
  }
  const cred = resolveMathpixCredentials();
  if (!cred) {
    cachedUsage = { fetchedAtMs: Date.now(), data: null };
    return null;
  }
  try {
    const res = await fetch(MATHPIX_ACCOUNT_ENDPOINT, {
      method: "GET",
      headers: { app_id: cred.appId, app_key: cred.appKey },
    });
    if (!res.ok) {
      // 401/403 등 — 자격증명 문제로 간주
      cachedUsage = { fetchedAtMs: Date.now(), data: null };
      return null;
    }
    const json = (await res.json()) as Record<string, unknown>;
    // 스키마 방어적 파싱 — 필드명·중첩이 변할 수 있어 여러 위치 탐색
    const usageObj =
      (json?.usage as Record<string, unknown> | undefined) ??
      (json?.account as Record<string, unknown> | undefined) ??
      json;
    const callsThisPeriod =
      coerceNumber(usageObj?.calls_this_period) ??
      coerceNumber(usageObj?.api_calls) ??
      null;
    const callsRemaining =
      coerceNumber(usageObj?.calls_remaining) ??
      coerceNumber(usageObj?.requests_remaining) ??
      coerceNumber(usageObj?.remaining) ??
      null;
    const billingPeriodEnd =
      typeof usageObj?.billing_period_end === "string"
        ? (usageObj.billing_period_end as string)
        : null;
    const data: MathpixAccountUsage = {
      callsThisPeriod,
      callsRemaining,
      billingPeriodEnd,
      raw: json,
    };
    cachedUsage = { fetchedAtMs: Date.now(), data };
    return data;
  } catch {
    cachedUsage = { fetchedAtMs: Date.now(), data: null };
    return null;
  }
}

export function isMathpixExhausted(): boolean {
  return Date.now() < exhaustedUntilMs;
}

export function markMathpixExhausted(reason?: string): void {
  // EXHAUSTED_BACKOFF_MS 가 MAX_SAFE_INTEGER 면 사실상 영구. 그대로 더하면 overflow → 그대로 사용.
  exhaustedUntilMs =
    EXHAUSTED_BACKOFF_MS >= Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : Date.now() + EXHAUSTED_BACKOFF_MS;
  if (reason) {
    const dur =
      EXHAUSTED_BACKOFF_MS >= Number.MAX_SAFE_INTEGER
        ? "영구 (재시작 또는 reset 까지)"
        : `${(EXHAUSTED_BACKOFF_MS / 60000) | 0}분`;
    console.log(`[mathpix] marked exhausted (${reason}) — disabled for ${dur}`);
  }
}

/**
 * 소진 마킹을 수동 해제. 매쓰픽스 충전 후 다시 사용하려는 경우 호출.
 * Usage 캐시도 같이 무효화하여 다음 호출에서 최신 잔여 재조회.
 */
export function resetMathpixExhausted(): void {
  exhaustedUntilMs = 0;
  cachedUsage = null;
  console.log(`[mathpix] exhaustion reset — Mathpix re-enabled`);
}

export function getMathpixExhaustedUntilMs(): number {
  return exhaustedUntilMs;
}

/**
 * Mathpix 응답이 「크레딧 소진」 류 에러인지 판별.
 * 402(Payment Required), 403(Forbidden), 또는 메시지에 credit/balance/quota/payment 단어가 있으면 true.
 */
export function isMathpixQuotaError(r: {
  ok: false;
  status: number;
  message: string;
}): boolean {
  if (r.status === 402 || r.status === 403) return true;
  return /out\s*of\s*credit|credits?\s*exhausted|insufficient\s*credit|payment\s*required|insufficient\s*balance|quota\s*exceeded|forbidden/i.test(
    r.message ?? "",
  );
}

/**
 * OCR 호출 직전 체크 — Mathpix 사용 가능?
 *  - 자격증명 없으면 false
 *  - 1시간 백오프 중이면 false
 *  - 사용량 조회 결과 잔여 ≤ MATHPIX_LOW_THRESHOLD 면 즉시 exhausted 마킹 후 false
 *  - 사용량 정보 없거나 잔여 충분하면 true
 */
export async function isMathpixUsableForOcr(): Promise<boolean> {
  if (!resolveMathpixCredentials()) return false;
  if (isMathpixExhausted()) return false;
  const usage = await getMathpixAccountUsage();
  if (
    usage &&
    typeof usage.callsRemaining === "number" &&
    usage.callsRemaining <= MATHPIX_LOW_THRESHOLD
  ) {
    markMathpixExhausted(
      `잔여 호출 ${usage.callsRemaining} ≤ 임계 ${MATHPIX_LOW_THRESHOLD}`,
    );
    return false;
  }
  return true;
}

function coerceNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}
