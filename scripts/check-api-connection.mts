/**
 * `.env.local` 의 Gemini / OpenAI 키가 API에 통하는지 확인합니다. 키 값은 출력하지 않습니다.
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
  for (const model of ["gemini-2.5-flash-lite", "gemini-2.0-flash-lite"] as const) {
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

const root = process.cwd();
const envPath = path.join(root, ".env.local");
const env = parseDotEnv(envPath);

const geminiKey = env.GEMINI_API_KEY?.trim() ?? "";
const openaiKey = env.OPENAI_API_KEY?.trim() ?? "";

console.log(`[env] 파일: ${envPath}`);
console.log(
  `[env] GEMINI_API_KEY: ${geminiKey ? `설정됨 (길이 ${geminiKey.length})` : "없음 또는 비어 있음"}`,
);
console.log(
  `[env] OPENAI_API_KEY: ${openaiKey ? `설정됨 (길이 ${openaiKey.length})` : "없음 또는 비어 있음"}`,
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

if (!geminiKey && !openaiKey) {
  console.log("\n둘 다 없으면 .env.local 형식을 확인하세요: GEMINI_API_KEY=... / OPENAI_API_KEY=...");
}

process.exit(exit);
