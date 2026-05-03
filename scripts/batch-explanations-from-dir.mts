/**
 * 지정 폴더의 .md / .txt 를 각각 하나의 해설 본문으로 보고
 * `해설지 최종본` 에 DOCX를 연속 생성합니다. (LLM 호출 없음 — 본문은 미리 준비)
 *
 * 사용:
 *   npm run batch:from-dir -- --input ./입력해설
 *   npm run batch:from-dir -- --input ./입력해설 --recursive
 *   npm run batch:from-dir -- --input ./입력해설 --dry-run
 *
 * 규칙:
 * - 파일명(확장자 제외) → 시험지 이름(examName)
 * - 본문은 `/api/generate-explanation` 과 동일하게 `[정답]` / `[해설]` 포함
 * - 첫 `[정답]` 줄 값을 quickAnswer 로 넘김(없으면 `-`)
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FINAL_EXPLANATION_DIR_NAME = "해설지 최종본";

type Cli = {
  inputDir: string;
  recursive: boolean;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Cli {
  let inputDir = "";
  let recursive = false;
  let dryRun = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) {
      inputDir = argv[i + 1];
      i += 1;
    } else if (a === "--recursive" || a === "-r") {
      recursive = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    }
  }
  return { inputDir, recursive, dryRun };
}

function extractQuickAnswerFromBody(body: string): string {
  const m = body.match(/\[정답\]\s*([^\n\r]*)/i);
  const v = m?.[1]?.trim();
  return v && v.length > 0 ? v : "-";
}

function looksLikeExplanationBody(body: string): boolean {
  const head = body.replace(/^\uFEFF/, "").trimStart();
  /** 해설 원고는 보통 맨 앞이 `[문제]` 또는 `[정답]`(README·계획 문서 제외) */
  if (!/^\[(문제|정답)\]/i.test(head)) return false;
  const em = body.match(/\[해설\]\s*([\s\S]+)/i);
  const rest = em?.[1]?.trim() ?? "";
  return rest.length >= 40;
}

async function collectMarkdownTextFiles(root: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (recursive) await walk(full);
        continue;
      }
      if (!/\.(md|txt)$/i.test(e.name)) continue;
      out.push(full);
    }
  }

  await walk(path.resolve(root));
  return out.sort((a, b) => a.localeCompare(b, "ko"));
}

async function main() {
  const { inputDir, recursive, dryRun } = parseArgs(process.argv);
  if (!inputDir.trim()) {
    console.error("필수: --input <폴더경로>");
    process.exit(1);
  }
  const dir = path.resolve(process.cwd(), inputDir);
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) {
      console.error(`폴더가 아닙니다: ${dir}`);
      process.exit(1);
    }
  } catch {
    console.error(`폴더를 찾을 수 없습니다: ${dir}`);
    process.exit(1);
  }

  const files = await collectMarkdownTextFiles(dir, recursive);
  if (files.length === 0) {
    console.error(`대상 파일 없음(.md/.txt): ${dir}${recursive ? " (하위 포함)" : ""}`);
    process.exit(1);
  }

  console.log(`발견 ${files.length}개(.md/.txt)${dryRun ? " (dry-run)" : ""}`);

  if (dryRun) {
    let would = 0;
    for (const f of files) {
      const rel = path.relative(process.cwd(), f);
      let body = "";
      try {
        body = await fs.readFile(f, "utf8");
      } catch {
        console.log(`  ! 읽기 실패: ${rel}`);
        continue;
      }
      if (looksLikeExplanationBody(body)) {
        console.log(`  → DOCX 대상: ${rel}`);
        would += 1;
      } else {
        console.log(`  (건너뜀: 원고 형식 아님 — 맨 앞 [문제]/[정답] + [해설] 본문) ${rel}`);
      }
    }
    console.log(`종료(dry-run). DOCX 대상 ${would}개.`);
    return;
  }

  const { buildExamExplanationDocxBuffer } = await import("../src/lib/examExplanationDocx");
  const outDir = path.join(process.cwd(), FINAL_EXPLANATION_DIR_NAME);
  await fs.mkdir(outDir, { recursive: true });

  let ok = 0;
  let fail = 0;
  let skipped = 0;
  for (const filePath of files) {
    const examName = path.parse(filePath).name;
    let explanationBody: string;
    try {
      explanationBody = await fs.readFile(filePath, "utf8");
    } catch (e) {
      console.error(`읽기 실패: ${filePath}`, e instanceof Error ? e.message : e);
      fail += 1;
      continue;
    }
    if (!explanationBody.trim()) {
      console.error(`비어 있음: ${filePath}`);
      fail += 1;
      continue;
    }
    if (!looksLikeExplanationBody(explanationBody)) {
      console.warn(`건너뜀(원고 형식 아님): ${path.relative(process.cwd(), filePath)}`);
      skipped += 1;
      continue;
    }
    try {
      const quickAnswer = extractQuickAnswerFromBody(explanationBody);
      const { buffer, docxFileName } = await buildExamExplanationDocxBuffer({
        examName,
        explanationBody,
        quickAnswer,
      });
      const docxPath = path.join(outDir, docxFileName);
      await fs.writeFile(docxPath, buffer);
      console.log(`저장: ${docxPath}`);
      ok += 1;
    } catch (e) {
      console.error(`DOCX 실패: ${examName}`, e instanceof Error ? e.message : e);
      fail += 1;
    }
  }

  console.log(`완료: 성공 ${ok}, 건너뜀 ${skipped}, 실패 ${fail} → ${outDir}`);
  if (fail > 0) process.exit(1);
  if (ok === 0) {
    console.error("저장된 DOCX가 없습니다. 입력 폴더에 [정답]/[해설]이 포함된 원고만 두었는지 확인하세요.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
