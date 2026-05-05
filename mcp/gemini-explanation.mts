/**
 * Cursor MCP stdio 서버: Gemini / OpenAI 로 수학 해설 초안 텍스트만 반환합니다.
 * 최종 검수·DOCX 저장은 Cursor 또는 `npm run write-final-docx`가 담당합니다.
 *
 * 시스템 지시: MCP 런타임 번들 안정성을 위해 로컬 빌더를 사용합니다.
 * (Next 라우트 모듈 export 변화의 영향을 받지 않도록 분리)
 */
import "./0-bootstrap.mjs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recognizeMathpixFromImageBase64Mcp } from "./mathpixClient.mts";
/** `src/lib/geminiDefaultModels.ts` 와 동일한 값. tsx MCP 엔트리 번들 시 `../src/lib/...` import 가 실패하므로 여기서 복제. */
const DEFAULT_GEMINI_COST_MODELS: readonly string[] = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
];

type OpenAiChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
};

/** data:image/png;base64,... 또는 순수 base64 */
function normalizeImageBase64(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^data:[^;]+;base64,(.+)$/i);
  return (m?.[1] ?? t).replace(/\s/g, "");
}

type VisionPart = { base64: string; mimeType: string };

function mcpSolverProfile(): "easy" | "balanced" | "killer" {
  const raw = process.env.GEMINI_MCP_SOLVER_PROFILE?.trim().toLowerCase();
  if (raw === "easy" || raw === "killer" || raw === "balanced") return raw;
  return "balanced";
}

function buildMcpSystemInstruction(profile: "easy" | "balanced" | "killer"): string {
  const profileHint =
    profile === "easy"
      ? "난이도: easy(핵심 계산 위주, 과전개 금지)"
      : profile === "killer"
        ? "난이도: killer(핵심 논리 유지, 장황함 금지)"
        : "난이도: balanced(정석 전개, 간결 유지)";
  return [
    "당신은 한국 고교 수학 해설 편집자입니다.",
    "출력 형식은 반드시 [문제] [빠른 정답] [해설] 순서를 지킵니다.",
    "객관식이면 [빠른 정답]은 1~5 번호만 쓰고 해설 결론과 일치시킵니다.",
    "포기/회피 문장(판독불가/풀 수 없음/오류 추정 등)은 금지합니다.",
    "해설은 식 중심으로 쓰되 불필요한 장황함을 줄입니다.",
    "문항 하나만 처리하고, 다른 문항을 섞지 않습니다.",
    profileHint,
  ].join("\n");
}

async function generateWithGemini(
  userTask: string,
  modelOverride: string | undefined,
  image: VisionPart | undefined,
): Promise<string> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY가 없습니다. Cursor 설정 → MCP → 해당 서버에 환경변수로 넣거나, 시스템 환경에 설정하세요.",
    );
  }

  const genAI = new GoogleGenerativeAI(key);
  const candidates = modelOverride?.trim()
    ? [modelOverride.trim()]
    : [...DEFAULT_GEMINI_COST_MODELS];

  const systemInstruction = buildMcpSystemInstruction(mcpSolverProfile());
  const parts: unknown[] = image
    ? [
        { text: userTask },
        {
          inlineData: {
            mimeType: image.mimeType || "image/png",
            data: image.base64,
          },
        },
      ]
    : [{ text: userTask }];

  const failures: string[] = [];
  let lastErr: Error | null = null;
  for (const model of candidates) {
    try {
      const m = genAI.getGenerativeModel({ model, systemInstruction });
      const res = await m.generateContent(parts as never);
      const text = res.response.text();
      if (text?.trim()) return text.trim();
      failures.push(`${model}: 빈 응답`);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      failures.push(`${model}: ${lastErr.message.slice(0, 240)}`);
    }
  }
  const summary = failures.length ? `\n시도 내역:\n${failures.join("\n")}` : "";
  throw new Error(
    (lastErr?.message ?? "Gemini 응답이 비었습니다.") + summary,
  );
}

async function generateWithOpenAI(
  userTask: string,
  modelOverride: string | undefined,
  image: VisionPart | undefined,
): Promise<string> {
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

  const systemInstruction = buildMcpSystemInstruction(mcpSolverProfile());
  const userContent = image
    ? [
        { type: "text" as const, text: userTask },
        {
          type: "image_url" as const,
          image_url: {
            url: `data:${image.mimeType || "image/png"};base64,${image.base64}`,
          },
        },
      ]
    : userTask;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userContent },
      ],
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
  { name: "highroad-gemini-explanation", version: "1.5.0" },
  {
    instructions:
      "하이로드 수학 시험 해설 초안(Gemini·OpenAI·Mathpix). 해설 도구: task+선택 이미지 → [정답]/[해설]. Mathpix: mathpix_recognize 도구로 OCR만(키는 MATHPIX_APP_ID/KEY). 이미지: imageBase64+imageMimeType. 객관식 [정답]은 1~5만. 프로필: GEMINI_MCP_SOLVER_PROFILE=easy|balanced|killer (기본 balanced).",
  },
);

const visionFields = {
  imageBase64: z
    .string()
    .optional()
    .describe(
      "선택. 크롭 시험지 이미지 — base64 순수 문자열 또는 data:image/png;base64,... 형식. 있으면 Gemini 비전으로 해당 이미지의 문항을 풀이합니다.",
    ),
  imageMimeType: z
    .string()
    .optional()
    .describe("imageBase64 사용 시 MIME (예 image/png, image/jpeg). 생략 시 image/png"),
};

server.registerTool(
  "generate_math_explanation",
  {
    description:
      "한국 고등 수학 해설을 Gemini로 생성합니다. imageBase64를 주면 비전(크롭 이미지)으로 문항을 읽고 풀이합니다. 비우면 task 텍스트만으로 생성합니다.",
    inputSchema: z.object({
      task: z
        .string()
        .describe(
          "지시: 출력 형식([정답]/[해설]), 난이도. 이미지가 있으면 '이미지의 단일 문항만 풀어라' 등을 포함.",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Gemini 모델 ID. 비우면 앱과 동일하게 gemini-2.5-flash-lite → gemini-2.5-flash 순 시도",
        ),
      ...visionFields,
    }),
  },
  async ({ task, model, imageBase64, imageMimeType }) => {
    const image =
      imageBase64?.trim() ?
        {
          base64: normalizeImageBase64(imageBase64),
          mimeType: (imageMimeType?.trim() || "image/png").toLowerCase(),
        }
      : undefined;
    const text = await generateWithGemini(task, model, image);
    return { content: [{ type: "text" as const, text }] };
  },
);

server.registerTool(
  "mathpix_recognize",
  {
    description:
      "Mathpix v3/text로 크롭 이미지에서 수식·텍스트를 OCR한다. 해설 생성은 generate_math_explanation_* 에서 task에 이 결과를 붙이거나, 배치는 --mathpix 로 자동 주입한다. 환경: MATHPIX_APP_ID, MATHPIX_APP_KEY.",
    inputSchema: z.object({
      imageBase64: z
        .string()
        .describe("data:image/...;base64,... 또는 순수 base64. Mathpix base64 한도(약 2MB) 준수."),
      imageMimeType: z.string().optional().describe("기본 image/png"),
    }),
  },
  async ({ imageBase64, imageMimeType }) => {
    const base64 = normalizeImageBase64(imageBase64);
    const mime = (imageMimeType?.trim() || "image/png").toLowerCase();
    const result = await recognizeMathpixFromImageBase64Mcp(base64, mime);
    if (!result.ok) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: false, status: result.status, error: result.message }, null, 2),
          },
        ],
      };
    }
    const d = result.data;
    const payload = {
      ok: true,
      text: d.text ?? "",
      latex_styled: d.latex_styled,
      confidence: d.confidence,
      confidence_rate: d.confidence_rate,
      request_id: d.request_id,
      image_width: d.image_width,
      image_height: d.image_height,
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  },
);

server.registerTool(
  "generate_math_explanation_openai",
  {
    description:
      "한국 고등 수학 해설을 OpenAI(Chat Completions)로 생성합니다. imageBase64를 주면 비전으로 이미지 문항을 풀이합니다(gpt-4o 등 비전 모델 권장).",
    inputSchema: z.object({
      task: z
        .string()
        .describe("지시 및 출력 형식([정답]/[해설]). 이미지 있으면 단일 문항만 풀 것을 명시."),
      model: z
        .string()
        .optional()
        .describe("OpenAI 모델(비전: gpt-4o-mini/gpt-4o 등). 비우면 env 폴백 또는 gpt-4o-mini"),
      ...visionFields,
    }),
  },
  async ({ task, model, imageBase64, imageMimeType }) => {
    const image =
      imageBase64?.trim() ?
        {
          base64: normalizeImageBase64(imageBase64),
          mimeType: (imageMimeType?.trim() || "image/png").toLowerCase(),
        }
      : undefined;
    const text = await generateWithOpenAI(task, model, image);
    return { content: [{ type: "text" as const, text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
