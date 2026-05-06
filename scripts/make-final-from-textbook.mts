import { spawnSync } from "node:child_process";
import path from "node:path";

type Cli = {
  inputDir: string;
  examName: string;
  baseUrl: string;
  fastMode: boolean;
  mathpixStrict: boolean;
  mathpixNoCache: boolean;
  disableMathpix: boolean;
};

function parseArgs(argv: string[]): Cli {
  let inputDir = "./크롭된 시험지";
  let examName = "";
  let baseUrl = "http://localhost:3000";
  let fastMode = false;
  let mathpixStrict = false;
  let mathpixNoCache = false;
  let disableMathpix = false;

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) {
      inputDir = argv[i + 1];
      i += 1;
    } else if (a === "--exam-name" && argv[i + 1]) {
      examName = argv[i + 1];
      i += 1;
    } else if (a === "--base-url" && argv[i + 1]) {
      baseUrl = argv[i + 1];
      i += 1;
    } else if (a === "--fast") {
      fastMode = true;
    } else if (a === "--mathpix-strict") {
      mathpixStrict = true;
    } else if (a === "--mathpix-no-cache") {
      mathpixNoCache = true;
    } else if (a === "--no-mathpix") {
      disableMathpix = true;
    }
  }

  return {
    inputDir,
    examName,
    baseUrl,
    fastMode,
    mathpixStrict,
    mathpixNoCache,
    disableMathpix,
  };
}

function main() {
  const cli = parseArgs(process.argv);
  const examName = cli.examName.trim() || "[TEXTBOOK] 교재해설";

  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const delegatedArgs = buildTextbookFinalFromInputArgs({
    inputDir: cli.inputDir,
    examName,
    baseUrl: cli.baseUrl,
    fastMode: cli.fastMode,
    mathpixStrict: cli.mathpixStrict,
    mathpixNoCache: cli.mathpixNoCache,
    disableMathpix: cli.disableMathpix,
  });

  console.log(
    `[textbook] input=${cli.inputDir} exam=${examName} gate=${cli.fastMode ? "fast" : "strict"} mathpix=${cli.disableMathpix ? "off" : "on(minConf=0.75)"}`,
  );

  const r = spawnSync(process.execPath, [tsxCli, ...delegatedArgs], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });
  if (r.error) {
    console.error(`[textbook] 실행 실패: ${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 0);
}

async function bootstrap() {
  const presetMod = await import("../src/lib/textbook/textbookPipelinePreset.ts");
  buildTextbookFinalFromInputArgs = presetMod.buildTextbookFinalFromInputArgs;
  main();
}

let buildTextbookFinalFromInputArgs: (
  params: Parameters<(typeof import("../src/lib/textbook/textbookPipelinePreset"))["buildTextbookFinalFromInputArgs"]>[0],
) => string[];

void bootstrap();
