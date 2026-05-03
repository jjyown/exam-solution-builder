/**
 * 해설 작업중/<시험지 폴더>/ 문항##_API초안.md · 합본_편집용.md → Supabase `exam_solutions` upsert
 *
 * 사용:
 *   npm run db-push
 *   npm run db-push -- --only "[TEST] TEST1.pdf"   (특정 시험 폴더만)
 *
 * 필수 환경변수(.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--only" && argv[i + 1]) {
      onlyExam = argv[i + 1];
      i += 1;
    }
  }
  return { onlyExam };
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

async function main() {
  const { onlyExam } = parseArgs(process.argv);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    console.error(
      "NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 가 없습니다. .env.local 을 확인하세요.",
    );
    process.exit(1);
  }

  const draftAbs = path.join(process.cwd(), DRAFT_ROOT);
  if (!(await isDirectory(draftAbs))) {
    console.error(`폴더가 없습니다: ${draftAbs}`);
    process.exit(1);
  }

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

  if (allRows.length === 0) {
    console.error("업로드할 행이 없습니다. 문항##_API초안.md 또는 합본_편집용.md 가 있는지 확인하세요.");
    process.exit(1);
  }

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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
      process.exit(1);
    }
  }

  console.log(`완료: exam_solutions 에 ${allRows.length}행 upsert (${[...new Set(allRows.map((r) => r.exam_name))].join(", ")})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
