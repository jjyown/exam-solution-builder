/**
 * 해설 작업중/<시험지 폴더>/ 문항##_API초안.md · 합본_편집용.md → Supabase `exam_solutions` upsert
 *
 * 사용:
 *   npm run db-push
 *   npm run upload-solutions
 *   npm run upload-solutions -- --only "[TEST] TEST1.pdf"   (특정 시험 폴더만)
 *
 * 필수 환경변수(.env.local):
 *   - URL: NEXT_PUBLIC_SUPABASE_URL (또는 SUPABASE_URL)
 *   - 키: SUPABASE_SERVICE_ROLE_KEY (anon 키로는 RLS·upsert 실패 가능)
 * 테이블 DDL: supabase/exam_solutions.sql
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

config({ path: path.join(process.cwd(), ".env.local") });
config({ path: path.join(process.cwd(), ".env") });

const DRAFT_ROOT = "해설 작업중";
const QUESTION_FILE_RE = /^문항(\d{1,2})_API초안\.md$/i;
const MERGED_NAME = "합본_편집용.md";

type Row = {
  exam_name: string;
  question_no: string;
  body: string;
  source_filename: string;
  updated_at: string;
};

function parseArgs(argv: string[]) {
  let onlyExam: string | null = null;
  let watch = false;
  let intervalMs = 3000;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--only" && argv[i + 1]) {
      onlyExam = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--watch") {
      watch = true;
    } else if (argv[i] === "--interval-ms" && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n >= 1000) intervalMs = n;
      i += 1;
    }
  }
  return { onlyExam, watch, intervalMs };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function collectFromExamFolder(examFolderAbs: string, examName: string): Promise<Row[]> {
  const rows: Row[] = [];
  const names = await readdir(examFolderAbs);
  const now = new Date().toISOString();

  for (const name of names) {
    const abs = path.join(examFolderAbs, name);
    const st = await stat(abs);
    if (!st.isFile() || !name.toLowerCase().endsWith(".md")) continue;

    if (name === MERGED_NAME) {
      const body = await readFile(abs, "utf8");
      if (!body.trim()) continue;
      rows.push({
        exam_name: examName,
        question_no: "합본",
        body: body.trim(),
        source_filename: name,
        updated_at: now,
      });
      continue;
    }

    const m = QUESTION_FILE_RE.exec(name);
    if (!m) continue;
    const qNum = String(Number.parseInt(m[1], 10));
    const body = await readFile(abs, "utf8");
    if (!body.trim()) {
      console.warn(`건너뜀(비어 있음): ${examName} / ${name}`);
      continue;
    }
    rows.push({
      exam_name: examName,
      question_no: qNum,
      body: body.trim(),
      source_filename: name,
      updated_at: now,
    });
  }

  return rows;
}

async function collectRowsFromDraftRoot(
  draftAbs: string,
  onlyExam: string | null,
): Promise<Row[]> {
  const examDirs = await readdir(draftAbs);
  const allRows: Row[] = [];

  for (const dirName of examDirs) {
    if (onlyExam && dirName !== onlyExam) continue;

    const examAbs = path.join(draftAbs, dirName);
    if (!(await isDirectory(examAbs))) continue;

    const rows = await collectFromExamFolder(examAbs, dirName);
    if (rows.length === 0) {
      console.log(`스킵(대상 .md 없음): ${dirName}`);
      continue;
    }
    allRows.push(...rows);
    console.log(`수집: ${dirName} → ${rows.length}건`);
  }
  return allRows;
}

async function upsertRows(
  supabase: ReturnType<typeof createClient>,
  allRows: Row[],
): Promise<void> {
  if (allRows.length === 0) {
    console.error("업로드할 행이 없습니다. 문항##_API초안.md 또는 합본_편집용.md 가 있는지 확인하세요.");
    return;
  }

  const chunkSize = 50;
  for (let i = 0; i < allRows.length; i += chunkSize) {
    const chunk = allRows.slice(i, i + chunkSize);
    const { error } = await supabase.from("exam_solutions").upsert(chunk, {
      onConflict: "exam_name,question_no",
    });
    if (error) {
      console.error("Supabase upsert 오류:", error.message);
      console.error(
        "테이블·unique 인덱스(exam_name, question_no)가 없으면 supabase/exam_solutions.sql 을 실행하세요.",
      );
      throw new Error(error.message);
    }
  }
  console.log(`완료: exam_solutions 에 ${allRows.length}행 upsert (${[...new Set(allRows.map((r) => r.exam_name))].join(", ")})`);
}

async function latestDraftMtimeMs(rootAbs: string, onlyExam: string | null): Promise<number> {
  let max = 0;
  const dirs = await readdir(rootAbs);
  for (const dirName of dirs) {
    if (onlyExam && dirName !== onlyExam) continue;
    const examAbs = path.join(rootAbs, dirName);
    if (!(await isDirectory(examAbs))) continue;
    const names = await readdir(examAbs);
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      const abs = path.join(examAbs, name);
      try {
        const st = await stat(abs);
        if (st.isFile() && st.mtimeMs > max) max = st.mtimeMs;
      } catch {
        // ignore
      }
    }
  }
  return max;
}

async function main() {
  const { onlyExam, watch, intervalMs } = parseArgs(process.argv);

  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    process.env.SUPABASE_URL?.trim() ||
    "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";

  if (!url || !serviceKey) {
    const hasUrl = Boolean(url);
    const hasService = Boolean(serviceKey);
    const hasAnon = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim());
    console.error(".env.local 에 아래 두 줄이 필요합니다 (이름 정확히):");
    console.error("  NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co");
    console.error("  SUPABASE_SERVICE_ROLE_KEY=eyJ...   ← Settings → API 의 service_role (anon 아님)");
    console.error(
      `현재: URL=${hasUrl ? "있음" : "없음"}, SERVICE_ROLE=${hasService ? "있음" : "없음"}${hasAnon ? ", ANON_KEY만 있음(부족)" : ""}`,
    );
    process.exit(1);
  }

  const draftAbs = path.join(process.cwd(), DRAFT_ROOT);
  if (!(await isDirectory(draftAbs))) {
    console.error(`폴더가 없습니다: ${draftAbs}`);
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const runOnce = async () => {
    const allRows = await collectRowsFromDraftRoot(draftAbs, onlyExam);
    await upsertRows(supabase, allRows);
  };

  await runOnce();
  if (!watch) return;

  console.log(`[watch] 변경 감시 시작: ${draftAbs}${onlyExam ? ` (only=${onlyExam})` : ""}`);
  let last = await latestDraftMtimeMs(draftAbs, onlyExam);
  let running = false;
  setInterval(async () => {
    if (running) return;
    try {
      const cur = await latestDraftMtimeMs(draftAbs, onlyExam);
      if (cur <= last) return;
      last = cur;
      running = true;
      console.log(`[watch] 변경 감지 → 재업로드 (${new Date().toLocaleString()})`);
      await runOnce();
    } catch (e) {
      console.error("[watch] 업로드 실패:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
    }
  }, intervalMs);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
