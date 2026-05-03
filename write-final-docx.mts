/**
 * 최종 해설 DOCX를 `해설지 최종본`에 씁니다 (/api/save-result 와 동일 로직).
 * Cursor가 MCP로 받은 해설을 정리한 뒤 이 스크립트로 내보낼 때 사용합니다.
 *
 * 사용 예:
 *   npm run write-final-docx -- --exam-name "2026 모의고사" --quick-answer "1~5 전부 ③" --body-file ./해설.txt
 *
 * `buildExamExplanationDocxBuffer` 는 동적 import 로 불러옵니다(tsx 엔트리 번들 시 named export 깨짐 방지).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** `src/lib/outputPaths.ts` 의 `FINAL_EXPLANATION_DIR_NAME` 과 동일 */
const FINAL_EXPLANATION_DIR_NAME = "해설지 최종본";

function parseArgs(argv: string[]) {
  let examName = "미지정시험지";
  let quickAnswer = "-";
  let bodyFile: string | null = null;
  let body: string | null = null;

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
    }
  }

  return { examName, quickAnswer, bodyFile, body };
}

async function main() {
  const { buildExamExplanationDocxBuffer } = await import("./src/lib/examExplanationDocx");
  const { examName, quickAnswer, bodyFile, body } = parseArgs(process.argv);

  let explanationBody = body ?? "";
  if (bodyFile) {
    const p = path.isAbsolute(bodyFile) ? bodyFile : path.join(process.cwd(), bodyFile);
    explanationBody = await fs.readFile(p, "utf8");
  }

  if (!explanationBody.trim()) {
    console.error("본문이 비었습니다. --body 또는 --body-file 을 지정하세요.");
    process.exit(1);
  }

  const outDir = path.join(process.cwd(), FINAL_EXPLANATION_DIR_NAME);
  const { buffer, docxFileName } = await buildExamExplanationDocxBuffer({
    examName,
    explanationBody,
    quickAnswer,
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
