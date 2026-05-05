/**
 * `.env.local` 의 Gemini / OpenAI / Mathpix 키가 API에 통하는지 확인합니다. 키 값은 출력하지 않습니다.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";

function parseDotEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

async function checkGemini(apiKey: string): Promise<{ ok: boolean; detail: string }> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const errors: string[] = [];
  for (const model of ["gemini-2.5-flash-lite", "gemini-2.5-flash"] as const) {
    try {
      const m = genAI.getGenerativeModel({ model });
      const res = await m.generateContent('Reply with exactly one word: "pong"');
      const text = res.response.text()?.trim() ?? "";
      if (text) return { ok: true, detail: `model=${model} response_len=${text.length}` };
      errors.push(`${model}: empty`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${model}: ${msg.slice(0, 120)}`);
    }
  }
  return { ok: false, detail: errors.join(" | ") };
}

async function checkOpenAI(apiKey: string): Promise<{ ok: boolean; detail: string }> {
  const model = "gpt-4o-mini";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: 'Reply with exactly one word: "pong"' }],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status} ${raw.slice(0, 200)}` };
    }
    const data = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) return { ok: false, detail: "empty choices" };
    return { ok: true, detail: `model=${model} response_len=${text.length}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: msg.slice(0, 200) };
  }
}

/** 공식 예제 URL로 자격 증명만 검증(본문은 출력하지 않음) */
async function checkMathpix(appId: string, appKey: string): Promise<{ ok: boolean; detail: string }> {
  const endpoint = process.env.MATHPIX_API_URL?.trim() || "https://api.mathpix.com/v3/text";
  const exampleUrl = "https://mathpix-ocr-examples.s3.amazonaws.com/cases_hw.jpg";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        app_id: appId,
        app_key: appKey,
      },
      body: JSON.stringify({
        src: exampleUrl,
        rm_spaces: true,
        math_inline_delimiters: ["$", "$"],
        math_display_delimiters: ["$$", "$$"],
      }),
    });
    const raw = await res.text();
    let data: { error?: string; text?: string; request_id?: string };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      return { ok: false, detail: `HTTP ${res.status} (JSON 아님) ${raw.slice(0, 160)}` };
    }
    if (!res.ok) {
      return {
        ok: false,
        detail: `HTTP ${res.status} ${data.error || raw.slice(0, 200)}`,
      };
    }
    if (data.error && !data.text?.trim()) {
      return { ok: false, detail: data.error };
    }
    const rid = data.request_id ? `request_id=${data.request_id.slice(0, 8)}…` : "request_id=(없음)";
    const len = data.text?.length ?? 0;
    return { ok: true, detail: `${rid}, text_chars≈${len}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: msg.slice(0, 200) };
  }
}

const root = process.cwd();
const envPath = path.join(root, ".env.local");
const env = parseDotEnv(envPath);

const geminiKey = env.GEMINI_API_KEY?.trim() ?? "";
const openaiKey = env.OPENAI_API_KEY?.trim() ?? "";
const mathpixId =
  env.MATHPIX_APP_ID?.trim() ||
  env.MATHPIX_APPID?.trim() ||
  env.MATHPIX_ID?.trim() ||
  "";
const mathpixKey =
  env.MATHPIX_APP_KEY?.trim() ||
  env.MATHPIX_KEY?.trim() ||
  env.MATHPIX_API_KEY?.trim() ||
  "";

console.log(`[env] 파일: ${envPath}`);
console.log(
  `[env] GEMINI_API_KEY: ${geminiKey ? `설정됨 (길이 ${geminiKey.length})` : "없음 또는 비어 있음"}`,
);
console.log(
  `[env] OPENAI_API_KEY: ${openaiKey ? `설정됨 (길이 ${openaiKey.length})` : "없음 또는 비어 있음"}`,
);
console.log(
  `[env] MATHPIX_APP_ID / MATHPIX_APP_KEY: ${
    mathpixId && mathpixKey
      ? `둘 다 설정됨 (id 길이 ${mathpixId.length}, key 길이 ${mathpixKey.length})`
      : mathpixId || mathpixKey
        ? "한쪽만 설정됨 — 둘 다 필요합니다"
        : "없음(선택)"
  }`,
);

let exit = 0;

if (!geminiKey) {
  console.log("[gemini] SKIP (키 없음)");
  exit = 1;
} else {
  const r = await checkGemini(geminiKey);
  console.log(r.ok ? `[gemini] OK — ${r.detail}` : `[gemini] FAIL — ${r.detail}`);
  if (!r.ok) exit = 1;
}

if (!openaiKey) {
  console.log("[openai] SKIP (키 없음)");
} else {
  const r = await checkOpenAI(openaiKey);
  console.log(r.ok ? `[openai] OK — ${r.detail}` : `[openai] FAIL — ${r.detail}`);
  if (!r.ok) exit = 1;
}

if (!mathpixId || !mathpixKey) {
  console.log("[mathpix] SKIP (MATHPIX_APP_ID / MATHPIX_APP_KEY 둘 다 필요)");
} else {
  const r = await checkMathpix(mathpixId, mathpixKey);
  console.log(r.ok ? `[mathpix] OK — ${r.detail}` : `[mathpix] FAIL — ${r.detail}`);
  if (!r.ok) exit = 1;
}

if (!geminiKey && !openaiKey) {
  console.log("\n둘 다 없으면 .env.local 형식을 확인하세요: GEMINI_API_KEY=... / OPENAI_API_KEY=...");
}

process.exit(exit);
