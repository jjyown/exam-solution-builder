/**
 * 크롭 이미지 폴더 → (로컬 Next) `/api/generate-explanation` → `해설지 최종본` DOCX
 *
 * 전제: 프로젝트 루트에서 `npm run dev` 가 떠 있고 `.env.local` 에 Gemini 등이 설정됨.
 *
 * 사용:
 *   npm run batch:crops-to-docx
 *   npm run batch:crops-to-docx -- --input ./크롭된시험지다른경로
 *   npm run batch:crops-to-docx -- --base-url http://127.0.0.1:3000 --dry-run
 *   npm run batch:crops-to-docx -- --no-recursive
 *
 * 옵션:
 *   --input <dir>     기본: ./크롭된 시험지
 *   --base-url <url>  기본: http://localhost:3000
 *   --recursive|-r    하위 폴더 이미지 포함 (기본 true)
 *   --no-recursive    루트 한 단계만
 *   --delay-ms <n>    요청 사이 대기(ms), 기본 800
 *   --generation-mode test|final  기본 final
 *   --solver-profile easy|balanced|killer  기본 balanced
 *   --dry-run
 */
import { promises as fs } from "node:fs";
import path from "node:path";

/** `src/lib/outputPaths.ts` 의 `CROPPED_EXAMS_DIR_NAME` 과 동일 */
const CROPPED_EXAMS_DIR_NAME = "크롭된 시험지";
const FINAL_EXPLANATION_DIR_NAME = "해설지 최종본";

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

type Cli = {
  inputDir: string;
  baseUrl: string;
  recursive: boolean;
  dryRun: boolean;
  delayMs: number;
  generationMode: "test" | "final";
  solverProfile: "easy" | "balanced" | "killer";
};

function parseArgs(argv: string[]): Cli {
  let inputDir = "";
  let baseUrl = "http://localhost:3000";
  let recursive = true;
  let dryRun = false;
  let delayMs = 800;
  let generationMode: "test" | "final" = "final";
  let solverProfile: "easy" | "balanced" | "killer" = "balanced";

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) {
      inputDir = argv[i + 1];
      i += 1;
    } else if (a === "--base-url" && argv[i + 1]) {
      baseUrl = argv[i + 1].replace(/\/$/, "");
      i += 1;
    } else if (a === "--recursive" || a === "-r") {
      recursive = true;
    } else if (a === "--no-recursive") {
      recursive = false;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--delay-ms" && argv[i + 1]) {
      delayMs = Math.max(0, Number(argv[i + 1]) || 0);
      i += 1;
    } else if (a === "--generation-mode" && argv[i + 1]) {
      const v = argv[i + 1].toLowerCase();
      if (v === "test" || v === "final") generationMode = v;
      i += 1;
    } else if (a === "--solver-profile" && argv[i + 1]) {
      const v = argv[i + 1].toLowerCase();
      if (v === "easy" || v === "balanced" || v === "killer") solverProfile = v;
      i += 1;
    }
  }

  if (!inputDir.trim()) {
    inputDir = `./${CROPPED_EXAMS_DIR_NAME}`;
  }

  return { inputDir, baseUrl, recursive, dryRun, delayMs, generationMode, solverProfile };
}

function mimeForImage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function extractQuickAnswerFromBody(body: string): string {
  const m = body.match(/\[정답\]\s*([^\n\r]*)/i);
  const v = m?.[1]?.trim();
  return v && v.length > 0 ? v : "-";
}

function examNameFromImage(inputRoot: string, filePath: string): string {
  const rel = path.relative(path.resolve(inputRoot), filePath);
  const noExt = rel.replace(IMAGE_EXT, "");
  return noExt.split(path.sep).join("_") || path.parse(filePath).name;
}

async function collectImages(root: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (recursive) await walk(full);
        continue;
      }
      if (!IMAGE_EXT.test(e.name)) continue;
      out.push(full);
    }
  }

  await walk(path.resolve(root));
  return out.sort((a, b) => a.localeCompare(b, "ko"));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const cli = parseArgs(process.argv);
  const dir = path.resolve(process.cwd(), cli.inputDir);

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

  const images = await collectImages(dir, cli.recursive);
  if (images.length === 0) {
    console.error(
      `이미지 없음(.png/.jpg/.jpeg/.webp): ${dir}${cli.recursive ? " (하위 포함)" : ""}`,
    );
    process.exit(1);
  }

  console.log(
    `발견 ${images.length}개 이미지 — baseUrl=${cli.baseUrl} mode=${cli.generationMode} profile=${cli.solverProfile}${cli.dryRun ? " (dry-run)" : ""}`,
  );

  if (cli.dryRun) {
    for (const f of images) {
      const rel = path.relative(process.cwd(), f);
      const exam = examNameFromImage(dir, f);
      console.log(`  → ${rel}  (examName: ${exam})`);
    }
    console.log("종료(dry-run). dev 서버 없이 목록만 확인했습니다.");
    return;
  }

  const generateUrl = `${cli.baseUrl}/api/generate-explanation`;
  const { buildExamExplanationDocxBuffer } = await import("../src/lib/examExplanationDocx");
  const outDir = path.join(process.cwd(), FINAL_EXPLANATION_DIR_NAME);
  await fs.mkdir(outDir, { recursive: true });

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < images.length; i += 1) {
    const filePath = images[i];
    const rel = path.relative(process.cwd(), filePath);
    const examName = examNameFromImage(dir, filePath);

    if (i > 0 && cli.delayMs > 0) await sleep(cli.delayMs);

    let buf: Buffer;
    try {
      buf = await fs.readFile(filePath);
    } catch (e) {
      console.error(`읽기 실패: ${rel}`, e instanceof Error ? e.message : e);
      fail += 1;
      continue;
    }

    const imageBase64 = buf.toString("base64");
    const imageMimeType = mimeForImage(filePath);

    let res: Response;
    try {
      res = await fetch(generateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64,
          imageMimeType,
          generationMode: cli.generationMode,
          solverModelProfile: cli.solverProfile,
          includeDiagramExplanation: true,
          explanationSelectionMode: "core",
          showAllMethods: false,
        }),
      });
    } catch (e) {
      console.error(
        `요청 실패(서버가 켜져 있는지 확인): ${rel}`,
        e instanceof Error ? e.message : e,
      );
      fail += 1;
      continue;
    }

    const raw = await res.text();
    let data: { result?: string; error?: string; details?: unknown };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      console.error(`응답 파싱 실패 HTTP ${res.status}: ${rel} — ${raw.slice(0, 200)}`);
      fail += 1;
      continue;
    }

    if (!res.ok || !data.result?.trim()) {
      const detail =
        typeof data.error === "string"
          ? data.error
          : `HTTP ${res.status}`;
      const details = Array.isArray(data.details) ? data.details.join(" | ") : "";
      console.error(`해설 생성 실패: ${rel} — ${detail}${details ? ` (${details.slice(0, 400)})` : ""}`);
      fail += 1;
      continue;
    }

    const explanationBody = data.result.trim();
    const quickAnswer = extractQuickAnswerFromBody(explanationBody);

    try {
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

  console.log(`완료: 성공 ${ok}, 실패 ${fail} → ${outDir}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
