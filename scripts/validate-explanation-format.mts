/**
 * 합본(또는 임의 md) **검수 게이트**(구조·정밀 LaTeX 잔존·고교 표기) 단독 실행.
 *
 *   npx tsx scripts/validate-explanation-format.mts --workdir "./해설 작업중/[TEST] TEST1.pdf"
 *   npx tsx scripts/validate-explanation-format.mts --file "./path/합본_편집용.md"
 *
 * 오류 시 exit 1.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const MERGED_NAME = "합본_편집용.md";

function parseArgs(argv: string[]) {
  let workdir: string | null = null;
  let file: string | null = null;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--workdir" && argv[i + 1]) {
      workdir = argv[i + 1];
      i += 1;
    } else if (a === "--file" && argv[i + 1]) {
      file = argv[i + 1];
      i += 1;
    }
  }
  return { workdir, file };
}

async function main() {
  const { workdir, file } = parseArgs(process.argv);
  const cwd = process.cwd();
  let bodyPath: string;
  if (file?.trim()) {
    bodyPath = path.isAbsolute(file) ? file : path.join(cwd, file);
  } else if (workdir?.trim()) {
    const wd = path.isAbsolute(workdir) ? workdir : path.join(cwd, workdir);
    bodyPath = path.join(wd, MERGED_NAME);
  } else {
    console.error("사용법: --workdir \"./해설 작업중/<폴더>\"  또는  --file \"./합본_편집용.md\"");
    process.exit(1);
  }

  let body: string;
  try {
    body = await fs.readFile(bodyPath, "utf8");
  } catch {
    console.error(`파일을 읽을 수 없습니다: ${bodyPath}`);
    process.exit(1);
  }

  const { validateExportReadiness, formatExportGateReport } = await import("../src/lib/explanationExportGate");
  const result = validateExportReadiness(body);
  console.error(formatExportGateReport(result));
  console.error(`대상: ${path.relative(cwd, bodyPath)}`);

  if (!result.ok) {
    console.error("\n검수 실패(exit 1). 합본을 수정한 뒤 다시 실행하세요.");
    process.exit(1);
  }
  console.error("\n검수 통과.");
}

void main();
