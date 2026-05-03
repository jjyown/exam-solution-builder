/**
 * gemini-explanation.mts 가 로드되기 전에 실행됩니다.
 * - 프로젝트 루트로 process.chdir (MCP cwd 가 어긋나도 동작하도록)
 * - .env.local 을 읽어 GEMINI_/OPENAI_ 만 process.env 에 보갑 (이미 있으면 유지)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

try {
  process.chdir(projectRoot);
} catch (e) {
  console.error("[mcp bootstrap] chdir failed:", projectRoot, e);
}

const envPath = path.join(projectRoot, ".env.local");
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    if (!/^(GEMINI_|OPENAI_)/.test(k)) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined || process.env[k] === "") {
      process.env[k] = v;
    }
  }
}
