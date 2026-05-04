/**
 * AST(구조 토큰) 기반 + 기존보내기 게이트 이중 검수.
 *
 *   npm run validate:format -- --workdir "./해설 작업중/[TEST] TEST1.pdf"
 *   npm run validate:format -- --file "./합본_편집용.md"
 *   npm run validate:format -- --file "./합본.md" --strict-numbered-headers
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const MERGED_NAME = "합본_편집용.md";

function parseArgs(argv: string[]) {
  let workdir: string | null = null;
  let file: string | null = null;
  let strictNumbered = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--workdir" && argv[i + 1]) {
      workdir = argv[i + 1];
      i += 1;
    } else if (a === "--file" && argv[i + 1]) {
      file = argv[i + 1];
      i += 1;
    } else if (a === "--strict-numbered-headers") {
      strictNumbered = true;
    }
  }
  return { workdir, file, strictNumbered };
}

async function main() {
  const { workdir, file, strictNumbered } = parseArgs(process.argv);
  const cwd = process.cwd();
  let bodyPath: string;
  if (file?.trim()) {
    bodyPath = path.isAbsolute(file) ? file : path.join(cwd, file);
  } else if (workdir?.trim()) {
    const wd = path.isAbsolute(workdir) ? workdir : path.join(cwd, workdir);
    bodyPath = path.join(wd, MERGED_NAME);
  } else {
    console.error(
      "사용법: npm run validate:format -- --workdir \"./해설 작업중/<폴더>\"  또는  --file \"./합본_편집용.md\" [--strict-numbered-headers]",
    );
    process.exit(1);
  }

  let body: string;
  try {
    body = await fs.readFile(bodyPath, "utf8");
  } catch {
    console.error(`파일을 읽을 수 없습니다: ${bodyPath}`);
    process.exit(1);
  }

  if (strictNumbered) {
    console.error("── AST 엄격 헤더(n) [문제] …) 검사 ──");
    const { validateStrictNumberedTripleChunks } = await import(
      "../src/lib/explanationMarkdownStructureAst.ts"
    );
    const astIssues = validateStrictNumberedTripleChunks(body);
    for (const it of astIssues) {
      console.error(`${it.level === "error" ? "■" : "△"} ${it.message}`);
    }
    const astFail = astIssues.some((x) => x.level === "error");
    if (astFail) {
      console.error("\nAST 검수 실패(exit 1).");
      process.exit(1);
    }
  }

  const { validateExportReadiness, formatExportGateReport } = await import("../src/lib/explanationExportGate");
  const result = validateExportReadiness(body);
  console.error(formatExportGateReport(result));
  console.error(`대상: ${path.relative(cwd, bodyPath)}`);

  if (!result.ok) {
    console.error("\n검수 실패(exit 1).");
    process.exit(1);
  }
  console.error("\n검수 통과.");
}

void main();
