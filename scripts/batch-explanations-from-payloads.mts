/**
 * _mcp_payloads.json(또는 동형 배열)을 읽어 Gemini 비전으로 문항별 해설을 생성합니다.
 * MCP `generate_math_explanation`과 동일한 시스템 프롬프트(buildMcpSystemInstruction)를 사용합니다.
 *
 * 사용:
 *   npx tsx scripts/batch-explanations-from-payloads.mts "해설 작업중/[TEST] TEST1.pdf/_mcp_payloads.json"
 *
 * 필수: .env.local 에 GEMINI_API_KEY
 */
import { config } from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

config({ path: path.join(process.cwd(), ".env.local") });
config({ path: path.join(process.cwd(), ".env") });

const DEFAULT_GEMINI_COST_MODELS: readonly string[] = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

type Payload = {
  questionNo: string;
  pageLabel?: string;
  imageBase64: string;
  imageMimeType?: string;
  sourceFiles?: string[];
};

function mcpSolverProfile(): "easy" | "balanced" | "killer" {
  const raw = process.env.GEMINI_MCP_SOLVER_PROFILE?.trim().toLowerCase();
  if (raw === "easy" || raw === "killer" || raw === "balanced") return raw;
  return "balanced";
}

function normalizeB64(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^data:[^;]+;base64,(.+)$/i);
  return (m?.[1] ?? t).replace(/\s/g, "");
}

function buildUserTask(qn: string, pageLabel: string): string {
  return `이미지에 보이는 것은 시험의 **단일 문항**이다. 본문과 그래프·도형이 함께 있으면, 그래프의 눈금·교점·함수 관계를 정확히 읽어 반영한다.

문항 번호는 반드시 **${qn}번**으로 맞춘다.

출력 형식(반드시 이 헤더 사용 — [문제]만 쓰지 말 것):
[문항 ${qn}]
(발문·조건만 1~3문장. 객관식이면 **빈 줄 한 줄** 뒤에 ①~⑤를 **각각 한 줄에 하나씩** 세로로 적는다. 이미지에서 선지가 질문 옆에 붙어 있어도 출력에서는 발문 아래에 배치한다. 한 줄에 「…은? ① … ② …」 형태 금지.)
[정답]
(최종 답만 명확히. 객관식이면 번호.)
[해설]
(단계별로 논리적으로. 필요 시 소제목 없이 문단으로. 최종에 정답과 일치함을 확인.)

출처 페이지 힌트: ${pageLabel || "(없음)"}`;
}

async function generateOne(
  genAI: GoogleGenerativeAI,
  buildMcp: (profile?: "easy" | "balanced" | "killer") => string,
  payload: Payload,
): Promise<string> {
  const qn = String(Number.parseInt(payload.questionNo, 10));
  const systemInstruction = buildMcp(mcpSolverProfile());
  const task = buildUserTask(qn, payload.pageLabel ?? "");
  const b64 = normalizeB64(payload.imageBase64);
  const mime = payload.imageMimeType?.startsWith("image/") ? payload.imageMimeType : "image/png";
  const parts = [
    { text: task },
    { inlineData: { mimeType: mime, data: b64 } },
  ] as const;

  const failures: string[] = [];
  let lastErr: Error | null = null;
  for (const model of DEFAULT_GEMINI_COST_MODELS) {
    try {
      const m = genAI.getGenerativeModel({ model, systemInstruction });
      const res = await m.generateContent(parts as never);
      const text = res.response.text();
      if (text?.trim()) return text.trim();
      failures.push(`${model}: 빈 응답`);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      failures.push(`${model}: ${lastErr.message}`);
    }
  }
  throw new Error(`문항 ${qn} 생성 실패: ${failures.join(" | ")}`);
}

async function main() {
  const jsonPath = process.argv[2]?.trim();
  if (!jsonPath) {
    console.error('필수: JSON 경로 (예: "해설 작업중/[TEST] TEST1.pdf/_mcp_payloads.json")');
    process.exit(1);
  }
  const abs = path.resolve(process.cwd(), jsonPath);
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    console.error(".env.local 에 GEMINI_API_KEY 가 필요합니다.");
    process.exit(1);
  }

  const raw = await readFile(abs, "utf8");
  const payloads = JSON.parse(raw) as Payload[];
  if (!Array.isArray(payloads) || payloads.length === 0) {
    console.error("payloads 비어 있음");
    process.exit(1);
  }

  const outDir = path.dirname(abs);
  const genAI = new GoogleGenerativeAI(key);
  const promptsUrl = pathToFileURL(
    path.join(process.cwd(), "src/app/api/generate-explanation/prompts.ts"),
  ).href;
  const { buildMcpSystemInstruction } = await import(promptsUrl);

  const pieces: string[] = [];
  for (const p of payloads) {
    const n = Number.parseInt(p.questionNo, 10);
    const pad = String(n).padStart(2, "0");
    const fname = `문항${pad}_API초안.md`;
    console.log(`생성 중: ${fname} …`);
    const text = await generateOne(genAI, buildMcpSystemInstruction, p);
    await writeFile(path.join(outDir, fname), `${text}\n`, "utf8");
    pieces.push(text.trimEnd());
    await new Promise((r) => setTimeout(r, 800));
  }

  const merged = `${pieces.join("\n\n")}\n`;
  await writeFile(path.join(outDir, "합본_편집용.md"), merged, "utf8");
  console.log(`완료: ${payloads.length}개 문항 → ${outDir}`);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
