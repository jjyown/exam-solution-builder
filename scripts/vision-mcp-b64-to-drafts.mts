/**
 * 크롭 묶음 폴더의 manifest.json + _mcp_b64_n.txt 를 읽어
 * Gemini 비전(MCP `generate_math_explanation` 과 동일 스택)으로
 * `해설 작업중/<시험명>/문항NN_API초안.md` 를 생성합니다.
 *
 * 사용:
 *   npx tsx scripts/vision-mcp-b64-to-drafts.mts "<크롭묶음폴더절대경로>"
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenerativeAI } from "@google/generative-ai";

function parseDotEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const DEFAULT_GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"] as const;

type Manifest = {
  examName?: string;
  itemCount?: number;
  items?: Array<{ questionNo?: string }>;
};

function buildTask(examName: string, questionNo: string): string {
  return `시험: ${examName} 문항 ${questionNo}. 이미지에 보이는 단일 수학 문항만 풀어라.
출력 형식만 사용:
[문항 ${questionNo}]
[정답]
[해설]
객관식(①~⑤)이면 [정답]은 번호 1~5 한 자리만. 수식은 LaTeX $...$ 사용.`;
}

async function main() {
  const cropFolder = process.argv[2]?.trim();
  if (!cropFolder) {
    console.error('필수 인자: 크롭 묶음 폴더 경로 (manifest.json, _mcp_b64_*.txt 가 있는 곳)');
    process.exit(1);
  }
  const folder = path.resolve(cropFolder);
  if (!existsSync(folder)) {
    console.error(`폴더 없음: ${folder}`);
    process.exit(1);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, "..");
  const envPath = path.join(projectRoot, ".env.local");
  const env = parseDotEnv(envPath);
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v;
  }
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    console.error("GEMINI_API_KEY 없음 (.env.local 확인)");
    process.exit(1);
  }

  const manifestPath = path.join(folder, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`manifest.json 없음: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const examName = (manifest.examName ?? "미지정").trim();
  const items = manifest.items ?? [];
  if (items.length === 0) {
    console.error("manifest.items 비어 있음");
    process.exit(1);
  }

  const outDir = path.join(projectRoot, "해설 작업중", examName);
  mkdirSync(outDir, { recursive: true });

  const genAI = new GoogleGenerativeAI(key);

  for (let i = 0; i < items.length; i += 1) {
    const qNo = (items[i]?.questionNo ?? String(i + 1)).trim();
    const b64Path = path.join(folder, `_mcp_b64_${i + 1}.txt`);
    if (!existsSync(b64Path)) {
      console.error(`건너뜀: ${b64Path} 없음`);
      continue;
    }
    const imageBase64 = readFileSync(b64Path, "utf8").trim().replace(/\s/g, "");
    const task = buildTask(examName, qNo);
    let text = "";
    let lastErr: Error | null = null;
    for (const modelId of DEFAULT_GEMINI_MODELS) {
      try {
        const model = genAI.getGenerativeModel({ model: modelId });
        const res = await model.generateContent([
          task,
          { inlineData: { mimeType: "image/png", data: imageBase64 } },
        ] as never);
        text = res.response.text()?.trim() ?? "";
        if (text) break;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
    if (!text) {
      console.error(`문항 ${qNo} 실패: ${lastErr?.message ?? "빈 응답"}`);
      continue;
    }
    const nn = qNo.padStart(2, "0");
    const outFile = path.join(outDir, `문항${nn}_API초안.md`);
    writeFileSync(outFile, `${text}\n`, "utf8");
    console.log(`[ok] ${outFile}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
