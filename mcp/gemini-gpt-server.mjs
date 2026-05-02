/**
 * Cursor MCP stdio 서버: Google Gemini / OpenAI Chat Completions 호출.
 * stdout에는 MCP JSON-RPC만 출력합니다(로그는 stderr).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { GoogleGenerativeAI } from "@google/generative-ai";

const mcpServer = new McpServer({
  name: "gemini-gpt-bridge",
  version: "1.0.0",
});

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

/** @param {{ role: string; content: string }[]} messages @param {string} modelId @param {number} temperature */
async function openaiChatCompletions(messages, modelId, temperature) {
  const key = process.env.OPENAI_API_KEY;
  if (!key?.trim()) {
    return { ok: false, text: "오류: OPENAI_API_KEY가 설정되어 있지 않습니다." };
  }
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      temperature: temperature ?? 0.7,
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    return { ok: false, text: `OpenAI API 오류 ${res.status}: ${raw}` };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: true, text: raw };
  }
  const text = data?.choices?.[0]?.message?.content ?? "";
  return { ok: true, text: text || raw };
}

/**
 * OpenAI 스타일 messages → Gemini contents + 선행 system 문자열.
 * @param {{ role: string; content: string }[]} messages
 * @returns {{ ok: true, systemInstruction?: string, contents: { role: string; parts: { text: string }[] }[] } } | { ok: false, text: string }}
 */
function openaiMessagesToGemini(messages) {
  const sys = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    sys.push(messages[i].content);
    i++;
  }
  const systemInstruction = sys.length ? sys.join("\n\n") : undefined;
  const contents = [];
  let bufferSystem = "";
  for (; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "system") {
      bufferSystem += (bufferSystem ? "\n" : "") + m.content;
      continue;
    }
    let text = m.content;
    if (bufferSystem) {
      text = `[시스템 보충]\n${bufferSystem}\n\n${text}`;
      bufferSystem = "";
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    const role = m.role === "assistant" ? "model" : "user";
    contents.push({ role, parts: [{ text }] });
  }
  if (bufferSystem) {
    return {
      ok: false,
      text: "오류: 대화 끝에 system만 남았습니다. user 메시지가 필요합니다.",
    };
  }
  if (!contents.length) {
    return { ok: false, text: "오류: 유효한 user/assistant 메시지가 없습니다." };
  }
  if (contents[contents.length - 1].role !== "user") {
    return {
      ok: false,
      text: "오류: Gemini는 마지막 메시지가 user여야 합니다. assistant로 끝나면 이어질 user를 추가하세요.",
    };
  }
  return { ok: true, systemInstruction, contents };
}

/** @param {{ role: string; parts: { text: string }[] }[]} contents @param {string} modelId @param {string|undefined} systemInstruction @param {number|undefined} temperature */
async function geminiGenerateFromContents(
  contents,
  modelId,
  systemInstruction,
  temperature
) {
  const key = process.env.GEMINI_API_KEY;
  if (!key?.trim()) {
    return { ok: false, text: "오류: GEMINI_API_KEY가 설정되어 있지 않습니다." };
  }
  const client = new GoogleGenerativeAI(key);
  const gen = client.getGenerativeModel({
    model: modelId,
    ...(systemInstruction?.trim()
      ? { systemInstruction: systemInstruction.trim() }
      : {}),
    ...(temperature !== undefined
      ? { generationConfig: { temperature } }
      : {}),
  });
  try {
    const res = await gen.generateContent({ contents });
    const out = res.response?.text?.() ?? "";
    return { ok: true, text: out || "(빈 응답)" };
  } catch (e) {
    return { ok: false, text: `Gemini API 오류: ${e?.message ?? e}` };
  }
}

mcpServer.registerTool(
  "gpt_generate",
  {
    description:
      "OpenAI GPT(Chat Completions)로 텍스트 생성. 환경변수 OPENAI_API_KEY 필요. gemini_generate와 동일한 입력 형태.",
    inputSchema: {
      prompt: z.string().describe("사용자 프롬프트(텍스트)"),
      model: z
        .string()
        .optional()
        .describe("모델 ID (기본: gpt-4o-mini)"),
      systemInstruction: z
        .string()
        .optional()
        .describe("시스템 지시문(선택) → OpenAI system 메시지로 전달"),
    },
  },
  async ({ prompt, model, systemInstruction }) => {
    const modelId = (model && String(model).trim()) || "gpt-4o-mini";
    const msgs = [];
    if (systemInstruction?.trim()) {
      msgs.push({ role: "system", content: systemInstruction.trim() });
    }
    msgs.push({ role: "user", content: prompt });
    const out = await openaiChatCompletions(msgs, modelId, 0.7);
    return textResult(out.text);
  }
);

mcpServer.registerTool(
  "gemini_generate",
  {
    description:
      "Google Gemini로 텍스트 생성. 환경변수 GEMINI_API_KEY 필요.",
    inputSchema: {
      prompt: z.string().describe("사용자 프롬프트(텍스트)"),
      model: z
        .string()
        .optional()
        .describe("모델 ID (기본: gemini-2.5-flash)"),
      systemInstruction: z
        .string()
        .optional()
        .describe("시스템 지시문(선택)"),
    },
  },
  async ({ prompt, model, systemInstruction }) => {
    const key = process.env.GEMINI_API_KEY;
    if (!key?.trim()) {
      return textResult("오류: GEMINI_API_KEY가 설정되어 있지 않습니다.");
    }
    const modelId = (model && String(model).trim()) || "gemini-2.5-flash";
    const client = new GoogleGenerativeAI(key);
    const gen = client.getGenerativeModel({
      model: modelId,
      ...(systemInstruction?.trim()
        ? { systemInstruction: systemInstruction.trim() }
        : {}),
    });
    const res = await gen.generateContent([{ text: prompt }]);
    const out = res.response?.text?.() ?? "";
    return textResult(out || "(빈 응답)");
  }
);

mcpServer.registerTool(
  "gemini_chat",
  {
    description:
      "Google Gemini로 다중 메시지 대화 생성(gpt_chat과 동일한 role 형식: system/user/assistant). 환경변수 GEMINI_API_KEY 필요. assistant는 Gemini의 model 역할로 매핑됩니다.",
    inputSchema: {
      prompt: z
        .string()
        .optional()
        .describe("단일 사용자 메시지(messages 미사용 시)"),
      messages: z
        .array(
          z.object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          })
        )
        .optional()
        .describe("대화 메시지 배열 (prompt와 동시 지정 시 messages 우선)"),
      model: z
        .string()
        .optional()
        .describe("모델 ID (기본: gemini-2.5-flash)"),
      temperature: z.number().min(0).max(2).optional(),
    },
  },
  async ({ prompt, messages, model, temperature }) => {
    const modelId = (model && String(model).trim()) || "gemini-2.5-flash";
    let msgs = messages;
    if (!msgs?.length) {
      const p = prompt?.trim();
      if (!p) {
        return textResult("오류: prompt 또는 messages 중 하나는 필요합니다.");
      }
      msgs = [{ role: "user", content: p }];
    }
    const mapped = openaiMessagesToGemini(msgs);
    if (!mapped.ok) {
      return textResult(mapped.text);
    }
    const out = await geminiGenerateFromContents(
      mapped.contents,
      modelId,
      mapped.systemInstruction,
      temperature
    );
    return textResult(out.text);
  }
);

mcpServer.registerTool(
  "gpt_chat",
  {
    description:
      "지피티(OpenAI) Chat Completions로 다중 메시지 대화 생성. 환경변수 OPENAI_API_KEY 필요.",
    inputSchema: {
      prompt: z
        .string()
        .optional()
        .describe("단일 사용자 메시지( messages 미사용 시 )"),
      messages: z
        .array(
          z.object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          })
        )
        .optional()
        .describe("대화 메시지 배열 (prompt와 동시 지정 시 messages 우선)"),
      model: z
        .string()
        .optional()
        .describe("모델 ID (기본: gpt-4o-mini)"),
      temperature: z.number().min(0).max(2).optional(),
    },
  },
  async ({ prompt, messages, model, temperature }) => {
    const modelId = (model && String(model).trim()) || "gpt-4o-mini";
    let msgs = messages;
    if (!msgs?.length) {
      const p = prompt?.trim();
      if (!p) {
        return textResult("오류: prompt 또는 messages 중 하나는 필요합니다.");
      }
      msgs = [{ role: "user", content: p }];
    }
    const out = await openaiChatCompletions(
      msgs,
      modelId,
      temperature ?? 0.7
    );
    return textResult(out.text);
  }
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
