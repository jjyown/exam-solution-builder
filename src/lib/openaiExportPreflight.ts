/**
 * 합본 마크다운을 OpenAI에 보내 **그림 필요 여부·검수 요약** 표를 받는다.
 * 운영자가 그 결과를 UI에서 보고 최종 편집한 뒤 `write-final-docx` 하는 동선용.
 */
import {
  OPENAI_IMAGE_NECESSITY_CHECKLIST_SYSTEM,
  buildImageNecessityUserMessage,
} from "@/lib/chiefEditorPrompts";

type OpenAiChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
};

export async function runOpenAiImageNecessityPreflight(mergedMarkdown: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY가 없습니다. .env.local 또는 환경 변수를 설정하세요.");
  }
  /** 검수표 생성은 기본 mini — `OPENAI_MODEL_CROSS_VERIFY` 와 분리(비용). */
  const model = process.env.OPENAI_MODEL_PREFLIGHT?.trim() || "gpt-4o-mini";

  const user = buildImageNecessityUserMessage(mergedMarkdown);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: OPENAI_IMAGE_NECESSITY_CHECKLIST_SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI preflight HTTP ${res.status}: ${raw.slice(0, 600)}`);
  }
  const data = JSON.parse(raw) as OpenAiChatResponse;
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error(`OpenAI preflight 응답 비어 있음: ${data.error?.message ?? raw.slice(0, 200)}`);
  }
  return text;
}
