import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import path from "node:path";

config({ path: path.join(process.cwd(), ".env.local") });
config({ path: path.join(process.cwd(), ".env") });

const DRAFT_ROOT = "해설 작업중";
const MERGED_NAME = "합본_편집용.md";
const QUESTION_FILE_RE = /^문항(\d{1,2})_API초안\.md$/i;

type Cli = {
  examName: string;
  workdir: string | null;
  outFile: string | null;
};

type LocalRow = {
  questionNo: string;
  sourceFile: string;
  body: string;
};

type DbRow = {
  question_no: string;
  source_filename: string | null;
  body: string;
  updated_at: string;
};

function parseArgs(argv: string[]): Cli {
  let examName = "";
  let workdir: string | null = null;
  let outFile: string | null = null;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--exam-name" && argv[i + 1]) {
      examName = argv[i + 1]!;
      i += 1;
    } else if (a === "--workdir" && argv[i + 1]) {
      workdir = argv[i + 1]!;
      i += 1;
    } else if (a === "--out-file" && argv[i + 1]) {
      outFile = argv[i + 1]!;
      i += 1;
    }
  }
  return { examName, workdir, outFile };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeForCompare(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t\f\v]+/g, " ").trim();
}

function firstDiffIndex(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}

function excerptAt(text: string, idx: number, radius = 36): string {
  if (idx < 0) return "";
  const s = Math.max(0, idx - radius);
  const e = Math.min(text.length, idx + radius);
  return text.slice(s, e).replace(/\n/g, "\\n");
}

async function collectLocalRows(workdirAbs: string): Promise<LocalRow[]> {
  const names = await fs.readdir(workdirAbs);
  const out: LocalRow[] = [];
  for (const name of names) {
    if (name === MERGED_NAME) {
      const body = (await fs.readFile(path.join(workdirAbs, name), "utf8")).trim();
      if (body) out.push({ questionNo: "합본", sourceFile: name, body });
      continue;
    }
    const m = QUESTION_FILE_RE.exec(name);
    if (!m?.[1]) continue;
    const questionNo = String(Number.parseInt(m[1], 10));
    const body = (await fs.readFile(path.join(workdirAbs, name), "utf8")).trim();
    if (!body) continue;
    out.push({ questionNo, sourceFile: name, body });
  }
  out.sort((a, b) => {
    if (a.questionNo === "합본") return 1;
    if (b.questionNo === "합본") return -1;
    return Number(a.questionNo) - Number(b.questionNo);
  });
  return out;
}

function requireSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim() || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!url || !key) {
    throw new Error(
      ".env.local에 NEXT_PUBLIC_SUPABASE_URL(또는 SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY가 필요합니다.",
    );
  }
  return { url, key };
}

async function main() {
  const cli = parseArgs(process.argv);
  const cwd = process.cwd();

  const workdirAbs =
    cli.workdir ?
      path.isAbsolute(cli.workdir) ? cli.workdir
      : path.join(cwd, cli.workdir)
    : null;
  const inferredExamName = workdirAbs ? path.basename(workdirAbs) : "";
  const examName = (cli.examName || inferredExamName).trim();
  if (!examName) {
    console.error("사용법: --exam-name <시험명> 또는 --workdir <해설 작업중/시험폴더>");
    process.exit(1);
  }

  const resolvedWorkdir = workdirAbs ?? path.join(cwd, DRAFT_ROOT, examName);
  if (!(await isDirectory(resolvedWorkdir))) {
    console.error(`workdir를 찾을 수 없습니다: ${resolvedWorkdir}`);
    process.exit(1);
  }

  const localRows = await collectLocalRows(resolvedWorkdir);
  if (localRows.length === 0) {
    console.error(`비교할 로컬 본문이 없습니다: ${resolvedWorkdir}`);
    process.exit(1);
  }

  const { url, key } = requireSupabaseConfig();
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase
    .from("exam_solutions")
    .select("question_no, source_filename, body, updated_at")
    .eq("exam_name", examName)
    .order("question_no");
  if (error) {
    console.error(`Supabase 조회 실패: ${error.message}`);
    process.exit(1);
  }

  const dbRows = ((data ?? []) as DbRow[]).map((r) => ({
    ...r,
    question_no: String(r.question_no),
    body: String(r.body ?? ""),
  }));

  const localMap = new Map(localRows.map((r) => [r.questionNo, r]));
  const dbMap = new Map(dbRows.map((r) => [r.question_no, r]));
  const unionKeys = Array.from(new Set([...localMap.keys(), ...dbMap.keys()])).sort((a, b) => {
    if (a === "합본") return 1;
    if (b === "합본") return -1;
    return Number(a) - Number(b);
  });

  const lines: string[] = [];
  lines.push(`# Supabase 스냅샷 비교`);
  lines.push(``);
  lines.push(`- exam_name: \`${examName}\``);
  lines.push(`- workdir: \`${path.relative(cwd, resolvedWorkdir)}\``);
  lines.push(`- 로컬 건수: ${localRows.length}`);
  lines.push(`- DB 건수: ${dbRows.length}`);
  lines.push(``);
  lines.push(`| 문항 | 상태 | 로컬 파일 | DB 파일 | 비고 |`);
  lines.push(`|---|---|---|---|---|`);

  let sameCount = 0;
  let diffCount = 0;
  let missingLocalCount = 0;
  let missingDbCount = 0;

  for (const keyNo of unionKeys) {
    const local = localMap.get(keyNo);
    const db = dbMap.get(keyNo);
    if (!local) {
      missingLocalCount += 1;
      lines.push(`| ${keyNo} | DB만 존재 | - | ${db?.source_filename ?? "-"} | 로컬 누락 |`);
      continue;
    }
    if (!db) {
      missingDbCount += 1;
      lines.push(`| ${keyNo} | 로컬만 존재 | ${local.sourceFile} | - | DB 누락 |`);
      continue;
    }

    const a = normalizeForCompare(local.body);
    const b = normalizeForCompare(db.body);
    if (a === b) {
      sameCount += 1;
      lines.push(`| ${keyNo} | 동일 | ${local.sourceFile} | ${db.source_filename ?? "-"} | - |`);
    } else {
      diffCount += 1;
      const idx = firstDiffIndex(a, b);
      lines.push(
        `| ${keyNo} | 불일치 | ${local.sourceFile} | ${db.source_filename ?? "-"} | 첫 차이 인덱스 ${idx} |`,
      );
      lines.push(``);
      lines.push(`### 문항 ${keyNo} 불일치 샘플`);
      lines.push(`- local: \`${excerptAt(a, idx)}\``);
      lines.push(`- db   : \`${excerptAt(b, idx)}\``);
      lines.push(``);
    }
  }

  lines.push(`## 요약`);
  lines.push(`- 동일: ${sameCount}`);
  lines.push(`- 불일치: ${diffCount}`);
  lines.push(`- 로컬만 존재: ${missingDbCount}`);
  lines.push(`- DB만 존재: ${missingLocalCount}`);
  lines.push(``);

  const outFile =
    cli.outFile ?
      path.isAbsolute(cli.outFile) ? cli.outFile
      : path.join(cwd, cli.outFile)
    : path.join(resolvedWorkdir, "supabase_snapshot_compare.md");
  await fs.writeFile(outFile, `${lines.join("\n")}\n`, "utf8");

  console.log(`완료: ${path.relative(cwd, outFile) || outFile}`);
  if (diffCount > 0 || missingDbCount > 0 || missingLocalCount > 0) {
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

