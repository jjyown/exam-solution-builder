/**
 * MCP 도구로 Gemini / OpenAI 실제 호출 스모크 (tools/call).
 * 키는 mcp/0-bootstrap.mjs 가 .env.local 에서 읽습니다.
 * 사용: `npm run mcp:test-llm`
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules/tsx/dist/cli.mjs");
const serverEntry = path.join(root, "mcp/gemini-explanation.mts");

const proc = spawn(process.execPath, [tsxCli, serverEntry], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let stderrBuf = "";
proc.stderr.on("data", (c) => {
  stderrBuf += c.toString();
});

function send(obj) {
  proc.stdin.write(`${JSON.stringify(obj)}\n`);
}

const rl = readline.createInterface({ input: proc.stdout });

const miniTask =
  "한 줄로만 답하세요. 질문: 삼각형의 내각의 합은 몇 도인가요? (숫자만)";

function summarizeToolResult(msg) {
  if (msg.error) return { ok: false, detail: JSON.stringify(msg.error) };
  const r = msg.result;
  if (r?.isError) {
    const t = r.content?.map((c) => c.text).join("\n") || JSON.stringify(r);
    return { ok: false, detail: t.slice(0, 400) };
  }
  const text = (r?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (!text) return { ok: false, detail: "(empty content)" };
  return { ok: true, preview: text.slice(0, 120).replace(/\s+/g, " ") };
}

async function main() {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mcp-llm-smoke", version: "1" },
    },
  });

  let phase = "init";
  let geminiRes;
  let openaiRes;

  for await (const line of rl) {
    const t = (line || "").trim();
    if (!t) continue;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      continue;
    }

    if (phase === "init" && msg.id === 1) {
      if (msg.error) throw new Error(`initialize: ${JSON.stringify(msg.error)}`);
      console.log("[OK] initialize");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "generate_math_explanation",
          arguments: { task: miniTask },
        },
      });
      phase = "gemini";
      continue;
    }

    if (phase === "gemini" && msg.id === 2) {
      geminiRes = msg;
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "generate_math_explanation_openai",
          arguments: { task: miniTask },
        },
      });
      phase = "openai";
      continue;
    }

    if (phase === "openai" && msg.id === 3) {
      openaiRes = msg;
      break;
    }
  }

  if (!geminiRes) throw new Error("no Gemini tools/call reply");
  const g = summarizeToolResult(geminiRes);
  console.log(g.ok ? `[OK] Gemini 응답 미리보기: ${g.preview}` : `[FAIL] Gemini: ${g.detail}`);

  if (!openaiRes) throw new Error("no OpenAI tools/call reply");
  const o = summarizeToolResult(openaiRes);
  console.log(o.ok ? `[OK] OpenAI 응답 미리보기: ${o.preview}` : `[FAIL] OpenAI: ${o.detail}`);

  if (!g.ok || !o.ok) process.exitCode = 1;
  else {
    console.log("[OK] Gemini + OpenAI MCP 호출 테스트 통과");
    process.exitCode = 0;
  }
}

try {
  await main();
} catch (e) {
  console.error("[FAIL]", e instanceof Error ? e.message : e);
  if (stderrBuf.trim()) console.error("[server stderr]\n", stderrBuf.slice(-2500));
  process.exitCode = 1;
} finally {
  proc.kill("SIGTERM");
}
