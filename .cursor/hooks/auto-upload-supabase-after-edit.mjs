/**
 * afterFileEdit 훅:
 * - 저장된 파일이 `해설 작업중/<시험폴더>/*.md` 이면
 * - `npm run upload-solutions -- --only "<시험폴더>"` 를 백그라운드로 1회 실행
 *
 * 훅은 항상 fail-open 동작(오류가 나도 편집 자체는 막지 않음).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const hooksDir = path.dirname(__filename);
const projectRoot = path.resolve(hooksDir, "..", "..");
const stampFile = path.join(hooksDir, ".auto-upload-stamp.json");
const DEBOUNCE_MS = 4000;

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectStringsDeep(value, out) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStringsDeep(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectStringsDeep(v, out);
  }
}

function normalizeForMatch(p) {
  return p.replace(/\\/g, "/");
}

function pickExamNameFromPayload(payload) {
  const all = [];
  collectStringsDeep(payload, all);
  for (const s of all) {
    if (!s || !s.toLowerCase().endsWith(".md")) continue;
    const n = normalizeForMatch(s);
    const m = n.match(/(?:^|\/)해설 작업중\/([^/]+)\/[^/]+\.md$/);
    const exam = m?.[1]?.trim();
    if (exam) return exam;
  }
  return null;
}

function shouldSkipByDebounce(examName) {
  try {
    const raw = readFileSync(stampFile, "utf8");
    const j = safeJsonParse(raw);
    if (!j || typeof j !== "object") return false;
    const prevExam = typeof j.exam === "string" ? j.exam : "";
    const prevAt = Number.isFinite(j.at) ? j.at : 0;
    if (prevExam === examName && Date.now() - prevAt < DEBOUNCE_MS) return true;
    return false;
  } catch {
    return false;
  }
}

function writeDebounceStamp(examName) {
  try {
    writeFileSync(
      stampFile,
      JSON.stringify({ exam: examName, at: Date.now() }),
      "utf8",
    );
  } catch {
    // ignore
  }
}

function fireUpload(examName) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(
    npmCmd,
    ["run", "upload-solutions", "--", "--only", examName],
    {
      cwd: projectRoot,
      detached: true,
      stdio: "ignore",
      shell: false,
    },
  );
  child.unref();
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const payload = safeJsonParse(raw || "{}") ?? {};

  const examName = pickExamNameFromPayload(payload);
  if (!examName) {
    process.stdout.write("{}");
    process.exit(0);
  }

  if (shouldSkipByDebounce(examName)) {
    process.stdout.write("{}");
    process.exit(0);
  }
  writeDebounceStamp(examName);
  fireUpload(examName);

  process.stdout.write(
    JSON.stringify({
      additional_context: `[자동 업로드] 해설 작업중/${examName} 수정 감지 → Supabase 업로드 실행`,
    }),
  );
  process.exit(0);
}

main().catch(() => {
  process.stdout.write("{}");
  process.exit(0);
});

