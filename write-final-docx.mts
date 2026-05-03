/**
 * 최종 해설 DOCX를 `해설지 최종본`에 씁니다 (/api/save-result 와 동일 로직).
 *
 * 본문 지정 방법(하나만 쓰면 됨 — 우선순위 위에서 아래):
 *   --body "…"              인라인
 *   --body-file <파일>      md 전체 경로
 *   --workdir <폴더>        그 안의 `합본_편집용.md` 사용 (시험지별 작업 폴더만 넘기면 됨)
 *   --latest                `해설 작업중/` 이하에서 수정 시각이 가장 최근인 `합본_편집용.md`
 *
 * 사용 예:
 *   npm run write-final-docx -- --workdir "./해설 작업중/[TEST] TEST1.pdf"
 *   npm run write-final-docx -- --latest
 *   npm run write-final-docx -- --exam-name "표제만 바꿈" --workdir "./해설 작업중/모의고사"
 *
 * 표제(exam-name): 생략 시 `--workdir` 폴더 이름 또는 합본 파일이 있는 폴더 이름을 씁니다.
 * 빠른정답: 같은 폴더에 `빠른정답_요약.txt`가 있으면 자동으로 읽습니다. 없으면 `--quick-answer` 또는 `-`.
 *
 * 그림: 합본 md와 같은 폴더를 asset 기준으로 씁니다. 다른 폴더면 `--asset-dir <dir>`.
 *
 * 구성 검사: 기본적으로 문제+[정답]+[해설] 구조를 검사하고, 오류가 있으면 DOCX를 만들지 않습니다.
 *   --skip-structure-check   검사 생략(비권장)
 *
 * `buildExamExplanationDocxBuffer` 는 동적 import 로 불러옵니다.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FINAL_EXPLANATION_DIR_NAME = "해설지 최종본";
const DRAFT_WORK_ROOT = "해설 작업중";
const MERGED_NAME = "합본_편집용.md";
const QUICK_SUMMARY_NAME = "빠른정답_요약.txt";

function parseArgs(argv: string[]) {
  let examName: string | null = null;
  let quickAnswer: string | null = null;
  let bodyFile: string | null = null;
  let body: string | null = null;
  let assetDir: string | null = null;
  let workdir: string | null = null;
  let latest = false;
  let skipStructureCheck = false;

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--exam-name" && argv[i + 1]) {
      examName = argv[i + 1];
      i += 1;
    } else if (a === "--quick-answer" && argv[i + 1]) {
      quickAnswer = argv[i + 1];
      i += 1;
    } else if (a === "--body-file" && argv[i + 1]) {
      bodyFile = argv[i + 1];
      i += 1;
    } else if (a === "--body" && argv[i + 1]) {
      body = argv[i + 1];
      i += 1;
    } else if (a === "--asset-dir" && argv[i + 1]) {
      assetDir = argv[i + 1];
      i += 1;
    } else if (a === "--workdir" && argv[i + 1]) {
      workdir = argv[i + 1];
      i += 1;
    } else if (a === "--latest") {
      latest = true;
    } else if (a === "--skip-structure-check") {
      skipStructureCheck = true;
    }
  }

  return { examName, quickAnswer, bodyFile, body, assetDir, workdir, latest, skipStructureCheck };
}

async function findAllMergedUnder(rootAbs: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name === MERGED_NAME) out.push(full);
    }
  }
  await walk(rootAbs);
  return out;
}

async function pickLatestMergedMd(cwd: string): Promise<string | null> {
  const root = path.join(cwd, DRAFT_WORK_ROOT);
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  const files = await findAllMergedUnder(root);
  if (files.length === 0) return null;
  let best = files[0]!;
  let bestM = -1;
  for (const f of files) {
    const st = await fs.stat(f);
    if (st.mtimeMs > bestM) {
      bestM = st.mtimeMs;
      best = f;
    }
  }
  return best;
}

async function tryReadQuickSummary(dir: string): Promise<string | null> {
  const p = path.join(dir, QUICK_SUMMARY_NAME);
  try {
    const t = (await fs.readFile(p, "utf8")).trim();
    return t || null;
  } catch {
    return null;
  }
}

async function main() {
  const { buildExamExplanationDocxBuffer } = await import("./src/lib/examExplanationDocx");
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const { skipStructureCheck } = args;

  let explanationBody = args.body ?? "";
  let resolvedBodyPath: string | null = null;

  if (explanationBody.trim()) {
    /* --body only */
  } else if (args.bodyFile) {
    resolvedBodyPath = path.isAbsolute(args.bodyFile)
      ? args.bodyFile
      : path.join(cwd, args.bodyFile);
    explanationBody = await fs.readFile(resolvedBodyPath, "utf8");
  } else if (args.workdir) {
    const wd = path.isAbsolute(args.workdir) ? args.workdir : path.join(cwd, args.workdir);
    resolvedBodyPath = path.join(wd, MERGED_NAME);
    try {
      explanationBody = await fs.readFile(resolvedBodyPath, "utf8");
    } catch {
      console.error(`합본을 찾을 수 없습니다: ${resolvedBodyPath}`);
      console.error(`--workdir 에는 ${MERGED_NAME} 가 들어 있는 시험 폴더를 지정하세요.`);
      process.exit(1);
    }
  } else if (args.latest) {
    const picked = await pickLatestMergedMd(cwd);
    if (!picked) {
      console.error(
        `${DRAFT_WORK_ROOT}/ 이하에 ${MERGED_NAME} 이 없습니다. --workdir 로 폴더를 지정하거나 --body-file 을 쓰세요.`,
      );
      process.exit(1);
    }
    resolvedBodyPath = picked;
    explanationBody = await fs.readFile(picked, "utf8");
    console.log(`선택된 합본(최근 수정): ${path.relative(cwd, picked)}`);
  }

  if (!explanationBody.trim()) {
    console.error(
      [
        "본문이 비었습니다. 아래 중 하나를 지정하세요.",
        "  --workdir \"./해설 작업중/<시험폴더>\"   ← 가장 간단",
        "  --latest                              ← 해설 작업중에서 가장 최근 합본",
        "  --body-file <합본_편집용.md>",
        "  --body \"…\"",
      ].join("\n"),
    );
    process.exit(1);
  }

  if (!skipStructureCheck) {
    const { validateMergedExplanationMarkdown, formatStructureCheckReport } = await import(
      "./src/lib/mergedExplanationStructureCheck"
    );
    const check = validateMergedExplanationMarkdown(explanationBody);
    console.error(formatStructureCheckReport(check));
    if (!check.ok) {
      console.error(
        "\nDOCX를 생성하지 않았습니다. 위 오류를 수정한 뒤 다시 실행하세요. (긴급 시에만 --skip-structure-check)",
      );
      process.exit(1);
    }
    if (check.warnings.length > 0) {
      console.error("(경고가 있어도 DOCX는 생성합니다. 내용을 한 번 더 확인하세요.)\n");
    } else {
      console.error("");
    }
  }

  const bodyDir = resolvedBodyPath ? path.dirname(resolvedBodyPath) : null;
  const fromFlag = args.assetDir
    ? path.isAbsolute(args.assetDir)
      ? args.assetDir
      : path.join(cwd, args.assetDir)
    : null;
  const assetBaseDir = fromFlag ?? bodyDir ?? undefined;

  const quickFromFile = bodyDir ? await tryReadQuickSummary(bodyDir) : null;
  const quickAnswer = args.quickAnswer ?? quickFromFile ?? "-";

  const inferredExamName =
    args.examName?.trim() ||
    (bodyDir ? path.basename(bodyDir) : null) ||
    "미지정시험지";

  const outDir = path.join(cwd, FINAL_EXPLANATION_DIR_NAME);
  const { buffer, docxFileName } = await buildExamExplanationDocxBuffer({
    examName: inferredExamName,
    explanationBody,
    quickAnswer,
    assetBaseDir,
  });
  const docxPath = path.join(outDir, docxFileName);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(docxPath, buffer);

  console.log(`저장 완료: ${docxPath}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
