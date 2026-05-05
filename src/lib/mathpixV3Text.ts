/**
 * Mathpix OCR v3 `/v3/text` — 서버 전용.
 * MCP stdio는 `tsx`가 `../src/lib` named export를 불안정하게 로드하는 경우가 있어,
 * 동일 요청 옵션을 `mcp/mathpixClient.mts`에 복제해 두었으니 변경 시 둘을 맞출 것.
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
