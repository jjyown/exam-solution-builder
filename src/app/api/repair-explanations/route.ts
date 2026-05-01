import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

type ExportDocEntry = {
  questionNo: string;
  quickAnswer: string;
  body: string;
};

type RepairRequestBody = {
  entries?: ExportDocEntry[];
};

function parseModelCandidatesFromEnv(envKey: string, fallback: string[]) {
  const raw = process.env[envKey]?.trim();
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

const REPAIR_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_REPAIR", [
  "gemini-2.0-flash",
]);

function extractJsonObject(raw: string) {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || first >= last) return null;
  return raw.slice(first, last + 1);
}

function sanitizeText(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\$\$?/g, "")
    .replace(/\\(frac|sqrt|binom|left|right|cdot|times|div|pi|sin|cos|tan|log|ln|alpha|beta|gamma|theta)\b/gi, "")
    .replace(/\\[()[\]{}]/g, "")
    .trim();
}

function validateRepairedEntry(entry: ExportDocEntry) {
  const issues: string[] = [];
  const text = `${entry.quickAnswer}\n${entry.body}`;
  if (
    /\$\$?[^$]*\$?\$?|\\(frac|sqrt|binom|left|right|cdot|times|div|pi|sin|cos|tan|log|ln|alpha|beta|gamma|theta)\b|\\[()[\]{}]/i.test(
      text,
    )
  ) {
    issues.push("LaTeX 흔적");
  }
  if (/추정|근사|어림|대략|감으로|찍어서|적당히|approx|approximately|≈/i.test(entry.body)) {
    issues.push("근삿값/추정 표현");
  }
  const sentenceCount =
    entry.body
      .split(/[\n.!?]+/)
      .map((line) => line.trim())
      .filter(Boolean).length || 0;
  const methodCount = (entry.body.match(/\[방법\s*\d+\]/g) ?? []).length;
  if (methodCount <= 1 && sentenceCount > 12) {
    issues.push("과도한 장문");
  }
  return { ok: issues.length === 0, issues };
}

async function repairWithOpenAi(params: {
  apiKey: string;
  model: string;
  prompt: string;
}) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: [{ role: "user", content: params.prompt }],
      temperature: 0.1,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI 폴백 호출 실패: ${response.status} ${text}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

export async function POST(request: Request) {
  try {
    const apiKey =
      process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY(또는 GOOGLE_API_KEY)가 필요합니다." }, { status: 500 });
    }

    const body = (await request.json()) as RepairRequestBody;
    const entries = (body.entries || [])
      .map((item) => ({
        questionNo: String(item.questionNo || "").trim(),
        quickAnswer: String(item.quickAnswer || "").trim(),
        body: String(item.body || "").trim(),
      }))
      .filter((item) => item.questionNo);

    if (entries.length === 0) {
      return NextResponse.json({ error: "보정할 문항이 없습니다." }, { status: 400 });
    }

    const client = new GoogleGenerativeAI(apiKey);
    const openAiApiKey =
      process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_KEY?.trim() || "";
    const openAiModel = process.env.OPENAI_MODEL_REPAIR_FALLBACK?.trim() || "gpt-4o-mini";
    const prompt = [
      "다음 문항 해설들을 DOCX 내보내기용으로 정제해.",
      "반드시 JSON 하나만 반환하고, JSON 외 문장은 절대 출력하지 마.",
      '형식: {"entries":[{"questionNo":"1","quickAnswer":"...","body":"..."}]}',
      "",
      "[필수 규칙]",
      "- 내부적으로 '중고등학교 20년 경력 교사'와 '문제 출제위원' 관점 토론을 거쳐 최종본을 작성.",
      "- 토론 과정은 출력하지 말고 최종 결과만 출력.",
      "- quickAnswer, body는 비우지 마.",
      "- LaTeX 표기($, \\frac, \\sqrt, \\binom, \\left, \\right 등) 금지.",
      "- 중고등학교 교육과정의 일반적인 풀이로 재작성.",
      "- 추정/근사/어림/대충/감으로 계산 방식 금지.",
      "- [해설] 본문은 학생이 따라갈 수 있게 단계형 문장으로 작성.",
      "- 단일 풀이 문제는 과도한 장문을 피하고 핵심 수식과 결론 중심으로 4~8문장 내외로 정리.",
      "- 근사값이 꼭 필요한 문제여도 '추정한다' 같은 표현 대신 명확한 근거를 제시.",
      "- 정답 값(quickAnswer)은 의미를 바꾸지 말고 유지.",
      "",
      "[입력 문항]",
      JSON.stringify(entries),
    ].join("\n");

    const failures: string[] = [];
    for (const modelName of REPAIR_MODEL_CANDIDATES) {
      try {
        const model = client.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        const json = extractJsonObject(text);
        if (!json) {
          failures.push(`${modelName}: JSON 추출 실패`);
          continue;
        }
        const parsed = JSON.parse(json) as { entries?: ExportDocEntry[] };
        const repaired = (parsed.entries || [])
          .map((item) => ({
            questionNo: String(item.questionNo || "").trim(),
            quickAnswer: sanitizeText(String(item.quickAnswer || "").trim()) || "-",
            body: sanitizeText(String(item.body || "").trim()) || "(해설 본문 없음)",
          }))
          .filter((item) => item.questionNo);
        if (repaired.length === 0) {
          failures.push(`${modelName}: 보정 결과 비어 있음`);
          continue;
        }
        const invalids = repaired
          .map((entry) => ({ entry, check: validateRepairedEntry(entry) }))
          .filter((item) => !item.check.ok);
        if (invalids.length > 0) {
          failures.push(
            `${modelName}: 보정 후 규칙 미통과 - ${invalids
              .map((item) => `${item.entry.questionNo}번(${item.check.issues.join(", ")})`)
              .join(" / ")}`,
          );
          continue;
        }
        return NextResponse.json({ entries: repaired, model: modelName });
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 오류";
        failures.push(`${modelName}: ${message}`);
      }
    }

    if (openAiApiKey) {
      try {
        const text = await repairWithOpenAi({
          apiKey: openAiApiKey,
          model: openAiModel,
          prompt,
        });
        const json = extractJsonObject(text);
        if (!json) {
          failures.push(`openai:${openAiModel}: JSON 추출 실패`);
        } else {
          const parsed = JSON.parse(json) as { entries?: ExportDocEntry[] };
          const repaired = (parsed.entries || [])
            .map((item) => ({
              questionNo: String(item.questionNo || "").trim(),
              quickAnswer: sanitizeText(String(item.quickAnswer || "").trim()) || "-",
              body: sanitizeText(String(item.body || "").trim()) || "(해설 본문 없음)",
            }))
            .filter((item) => item.questionNo);
          const invalids = repaired
            .map((entry) => ({ entry, check: validateRepairedEntry(entry) }))
            .filter((item) => !item.check.ok);
          if (repaired.length > 0 && invalids.length === 0) {
            return NextResponse.json({ entries: repaired, model: `${openAiModel} (openai-fallback)` });
          }
          if (repaired.length === 0) {
            failures.push(`openai:${openAiModel}: 보정 결과 비어 있음`);
          } else {
            failures.push(
              `openai:${openAiModel}: 보정 후 규칙 미통과 - ${invalids
                .map((item) => `${item.entry.questionNo}번(${item.check.issues.join(", ")})`)
                .join(" / ")}`,
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 OpenAI 오류";
        failures.push(`openai:${openAiModel}: ${message}`);
      }
    }

    return NextResponse.json(
      { error: "자동 보정 모델 호출에 실패했습니다.", details: failures },
      { status: 502 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: `자동 보정 처리 중 오류가 발생했습니다: ${message}` },
      { status: 500 },
    );
  }
}

