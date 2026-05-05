/**
 * afterAgentResponse 훅:
 * - 변경 파일이 있으면 docs/worklog.md 에 자동 로그 1줄 추가
 * - 동일 변경 집합 반복 응답에서는 중복 기록 방지
 *
 * 주의: fail-open. 기록 실패가 에이전트 동작을 막지 않음.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const hooksDir = path.dirname(__filename);
const projectRoot = path.resolve(hooksDir, "..", "..");
const docsDir = path.join(projectRoot, "docs");
const worklogPath = path.join(docsDir, "worklog.md");
const stampPath = path.join(hooksDir, ".worklog-auto-stamp.json");

function getChangedFiles() {
  const raw = execSync("git status --porcelain", {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const files = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter((f) => f && !f.startsWith(".env"))
    .filter((f) => !f.startsWith(".cursor/hooks/.worklog-auto-stamp"))
    .filter((f) => f !== "docs/worklog.md");
  return Array.from(new Set(files)).sort();
}

function fingerprint(files) {
  return files.join("|");
}

function loadStamp() {
  try {
    return JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return null;
  }
}

function saveStamp(data) {
  try {
    writeFileSync(stampPath, JSON.stringify(data), "utf8");
  } catch {
    // ignore
  }
}

function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function appendWorklog(files) {
  if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
  const line =
    `\n| ${nowLocal()} | 자동 기록 | 작업 중 변경 감지 (임시/미커밋) | ` +
    `${files.slice(0, 8).map((f) => `\`${f}\``).join(", ")}${files.length > 8 ? ", ..." : ""} |`;
  const body = existsSync(worklogPath) ? readFileSync(worklogPath, "utf8") : "# 작업 로그\n";
  if (!/\|\s*일시\(로컬\)\s*\|/.test(body)) {
    const seed =
      "# 하이로드 수학 해설지 제작기 — 작업 로그\n\n" +
      "- 문서 기준일: 2026-05-04\n\n" +
      "## 자동 누적 로그\n\n| 일시(로컬) | 작업 | 핵심 변경 | 영향 파일 |\n|---|---|---|---|\n";
    writeFileSync(worklogPath, seed + line, "utf8");
    return;
  }
  writeFileSync(worklogPath, body + line, "utf8");
}

function main() {
  try {
    const files = getChangedFiles();
    if (files.length === 0) return;
    const fp = fingerprint(files);
    const prev = loadStamp();
    if (prev && prev.fp === fp) return;
    appendWorklog(files);
    saveStamp({ fp, at: Date.now() });
  } catch {
    // fail-open
  }
}

main();
process.stdout.write("{}");
process.exit(0);

