/**
 * MCP stdio 연결 스모크: initialize → tools/list 까지 실제 프로세스와 주고받습니다.
 * 사용: 프로젝트 루트에서 `npm run mcp:smoke`
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

async function main() {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mcp-stdio-smoke", version: "1" },
    },
  });

  let phase = "init";
  let listRes;

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
      const name = msg.result?.serverInfo?.name ?? "(no name)";
      console.log(`[OK] initialize → server: ${name}`);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      phase = "tools";
      continue;
    }

    if (phase === "tools" && msg.id === 2) {
      listRes = msg;
      break;
    }
  }

  if (!listRes) throw new Error("no tools/list reply (stream ended)");
  if (listRes.error) throw new Error(`tools/list: ${JSON.stringify(listRes.error)}`);
  const names = (listRes.result?.tools ?? []).map((t) => t.name).join(", ");
  console.log(`[OK] tools/list → ${names || "(no tools)"}`);
  console.log("[OK] MCP stdio 연결 테스트 통과");
}

try {
  await main();
  process.exitCode = 0;
} catch (e) {
  console.error("[FAIL]", e instanceof Error ? e.message : e);
  if (stderrBuf.trim()) console.error("[server stderr]\n", stderrBuf.slice(-2000));
  process.exitCode = 1;
} finally {
  proc.kill("SIGTERM");
}
