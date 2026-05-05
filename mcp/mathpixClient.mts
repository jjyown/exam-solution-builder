/**
 * MCP 전용 Mathpix v3/text 클라이언트.
 * (`tsx`가 `../src/lib` 를 로드할 때 named export 해석이 깨지는 경우가 있어 MCP 폴더에 둔다.)
 * @see https://docs.mathpix.com/reference/post-v3-text
 */

export type MathpixV3TextJson = {
  request_id?: string;
  text?: string;
  latex_styled?: string;
  confidence?: number;
  confidence_rate?: number;
  error?: string;
  image_height?: number;
  image_width?: number;
};

const MATHPIX_ENDPOINT =
  process.env.MATHPIX_API_URL?.trim() || "https://api.mathpix.com/v3/text";

function buildSrcDataUrl(base64: string, mimeType: string): string {
  const mime = mimeType.trim().toLowerCase() || "image/png";
  const b64 = base64.replace(/\s/g, "");
  return `data:${mime};base64,${b64}`;
}

function base64WithinLimit(base64: string, maxBytes = 2 * 1024 * 1024): boolean {
  return Buffer.byteLength(base64, "utf8") <= maxBytes;
}

function resolveCredentials(): { appId: string; appKey: string } | null {
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

export async function recognizeMathpixFromImageBase64Mcp(
  imageBase64: string,
  imageMimeType: string,
): Promise<{ ok: true; data: MathpixV3TextJson } | { ok: false; status: number; message: string }> {
  const cred = resolveCredentials();
  if (!cred) {
    return {
      ok: false,
      status: 501,
      message:
        "MATHPIX_APP_ID / MATHPIX_APP_KEY 가 없습니다. Cursor MCP 서버 환경변수 또는 시스템 env에 설정하세요.",
    };
  }

  const clean = imageBase64.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
  if (!base64WithinLimit(clean)) {
    return {
      ok: false,
      status: 413,
      message: "base64 이미지가 Mathpix 한도(약 2MB)를 초과합니다.",
    };
  }

  const src = buildSrcDataUrl(clean, imageMimeType);
  const body = JSON.stringify({
    src,
    rm_spaces: true,
    math_inline_delimiters: ["$", "$"],
    math_display_delimiters: ["$$", "$$"],
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
    const msg = data.error || raw.slice(0, 400);
    return { ok: false, status: res.status, message: `Mathpix HTTP ${res.status}: ${msg}` };
  }

  if (data.error && !data.text?.trim()) {
    return { ok: false, status: 422, message: data.error };
  }

  return { ok: true, data };
}
