/**
 * Cursor MCP stdio 서버: Gemini / OpenAI 로 수학 해설 초안 텍스트만 반환합니다.
 * 최종 검수·DOCX 저장은 Cursor 또는 `npm run write-final-docx`가 담당합니다.
 */
import "./0-bootstrap.mjs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.0-flash-lite"] as const;

type OpenAiChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
};

async function generateWithGemini(prompt: string, modelOverride?: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY가 없습니다. Cursor 설정 → MCP → 해당 서버에 환경변수로 넣거나, 시스템 환경에 설정하세요.",
    );
  }

  const genAI = new GoogleGenerativeAI(key);
  const candidates = modelOverride?.trim()
    ? [modelOverride.trim()]
    : [...DEFAULT_GEMINI_MODELS];

  let lastErr: Error | null = null;
  for (const model of candidates) {
    try {
      const m = genAI.getGenerativeModel({ model });
      const res = await m.generateContent(prompt);
      const text = res.response.text();
      if (text?.trim()) return text.trim();
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error("Gemini 응답이 비었습니다.");
}

async function generateWithOpenAI(task: string, modelOverride?: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY가 없습니다. Cursor 설정 → MCP → 해당 서버에 환경변수로 넣거나, 시스템 환경에 설정하세요.",
    );
  }
  const model =
    modelOverride?.trim() ||
    process.env.OPENAI_MODEL_GENERATE_FALLBACK?.trim() ||
    "gpt-4o-mini";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: task }],
      temperature: 0.35,
    }),
  });

  const raw = await res.text();
  let data: OpenAiChatResponse;
  try {
    data = JSON.parse(raw) as OpenAiChatResponse;
  } catch {
    throw new Error(`OpenAI 응답 파싱 실패 (HTTP ${res.status}): ${raw.slice(0, 400)}`);
  }

  if (!res.ok) {
    const msg = data.error?.message || raw.slice(0, 400);
    throw new Error(`OpenAI HTTP ${res.status}: ${msg}`);
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenAI 응답 본문이 비었습니다.");
  return text;
}

const server = new McpServer(
  { name: "highroad-gemini-explanation", version: "1.1.0" },
  {
    instructions:
      "하이로드 수학 시험 해설 초안 생성(Gemini·OpenAI). 출력은 DOCX 빌더와 맞추려면 [문항 n], [정답], [해설] 블록 형식을 task에 요청하세요. 각 도구에 맞는 API 키가 MCP 환경에 있어야 합니다.",
  },
);

server.registerTool(
  "generate_math_explanation",
  {
    description:
      "한국 고등 수학·미적분 등 시험 문항용 해설 텍스트를 Gemini로 생성합니다. 반환값은 원문 그대로 두고, Cursor가 형식·오타를 다듬은 뒤 로컬에 저장합니다.",
    inputSchema: z.object({
      task: z
        .string()
        .describe("문항 전체 지시: 문제 텍스트, 출력 형식([문항]/[정답]/[해설]), 난이도·톤"),
      model: z.string().optional().describe("Gemini 모델 ID. 비우면 flash-lite 후보를 순차 시도"),
    }),
  },
  async ({ task, model }) => {
    const text = await generateWithGemini(task, model);
    return { content: [{ type: "text" as const, text }] };
  },
);

server.registerTool(
  "generate_math_explanation_openai",
  {
    description:
      "한국 고등 수학·미적분 등 시험 문항용 해설 텍스트를 OpenAI(Chat Completions)로 생성합니다. 모델을 비우면 OPENAI_MODEL_GENERATE_FALLBACK(없으면 gpt-4o-mini)을 씁니다.",
    inputSchema: z.object({
      task: z
        .string()
        .describe("문항 전체 지시: 문제 텍스트, 출력 형식([문항]/[정답]/[해설]), 난이도·톤"),
      model: z
        .string()
        .optional()
        .describe("OpenAI 채팅 모델 ID(예: gpt-4o-mini). 비우면 env 폴백 또는 gpt-4o-mini"),
    }),
  },
  async ({ task, model }) => {
    const text = await generateWithOpenAI(task, model);
    return { content: [{ type: "text" as const, text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
