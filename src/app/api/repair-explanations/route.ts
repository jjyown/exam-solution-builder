import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import type { ExportDocEntry } from "@/lib/exportDocQuality";
import {
  getExportRepairWarnings,
  sanitizeExportPlainText,
  validateExportDocEntries,
} from "@/lib/exportDocQuality";

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
  const cleaned = raw.replace(/```json|```/gi, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || first >= last) return null;
  return cleaned.slice(first, last + 1);
}

function parseJsonSafely(raw: string) {
  try {
    return JSON.parse(raw) as { entries?: ExportDocEntry[] };
  } catch {
    const normalized = raw
      .replace(/\r\n/g, "\n")
      .replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    return JSON.parse(normalized) as { entries?: ExportDocEntry[] };
  }
}

function normalizeRepairedEntries(items: unknown[]): ExportDocEntry[] {
  return items
    .map((item) => {
      const row = item as ExportDocEntry;
      return {
        questionNo: String(row.questionNo || "").trim(),
        quickAnswer: sanitizeExportPlainText(String(row.quickAnswer || "").trim()) || "-",
        body:
          sanitizeExportPlainText(String(row.body || "").trim()) || "(해설 본문 없음)",
      };
    })
    .filter((item) => item.questionNo);
}

/** 보정 결과가 입력 문항 집합·개수와 같아야 한다(병합·누락 방지). */
function repairOutputMatchesInput(
  input: ExportDocEntry[],
  output: ExportDocEntry[],
): { ok: boolean; detail?: string } {
  if (input.length !== output.length) {
    return {
      ok: false,
      detail: `문항 개수 불일치(입력 ${input.length}, 출력 ${output.length})`,
    };
  }
  const inNos = input.map((e) => e.questionNo).sort();
  const outNos = output.map((e) => e.questionNo).sort();
  if (!inNos.every((n, i) => n === outNos[i])) {
    return { ok: false, detail: "questionNo 집합이 입력과 다릅니다." };
  }
  return { ok: true };
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
      "입력은 내보내기 직전 스냅샷이며, 각 항목은 이미지 파이프라인에서 문항별로 생성된 텍스트다.",
      "반드시 JSON 하나만 반환하고, JSON 외 문장은 절대 출력하지 마.",
      '형식: {"entries":[{"questionNo":"1","quickAnswer":"...","body":"..."}]}',
      "",
      "[문항 무결성]",
      "- 출력 entries 개수·questionNo 집합은 입력과 동일하게 유지한다. 문항 병합·누락·번호 변경 금지.",
      "- 각 body는 해당 questionNo 한 문항의 풀이만 담는다. 타 문항 풀이나 '다음 문제'로 이어 붙이지 마라.",
      "- body 안에 [정답] 헤더를 넣지 마라(정답은 quickAnswer만).",
      "",
      "[필수 규칙 — 클라이언트 검증과 동일]",
      "- 내부적으로 '중고등학교 20년 경력 교사'와 '문제 출제위원' 관점 토론을 거쳐 최종본을 작성.",
      "- 토론 과정은 출력하지 말고 최종 결과만 출력.",
      "- quickAnswer는 빈 문자열이나 '-'만 두지 마. 객관식이면 1~5, 단답형이면 최종 값/식, 서술형 지시가 명확하면 '해설참고' 등 입력과 일관되게.",
      "- body는 공백 포함 최소 35자 이상. 부족하면 풀이 단계를 보강해 길이를 채워.",
      "- '이미지가 제공되지 않았다', '이미지 부재' 등 메타 문구는 삭제하고 실제 풀이만 남겨.",
      "- 수식은 유니코드·평문(√, ∛, ×, sin, cos, θ, ≥ 등)으로 정리. 달러·백슬래시 LaTeX가 남지 않게 한다(내보내기 게이트와 맞춤).",
      "- 중고등학교 교육과정 범위의 정석 풀이.",
      "- 추정/근사/어림/대충/감으로/approx 등 근사 중심 표현 금지. 필요하면 부등식·범위로 엄밀히.",
      "- 단일 풀이는 수식·등호 연쇄 위주로 짧게 유지하고, 말로만 길게 늘리지 마라(다중 [방법 n]이면 예외).",
      "- 동일 questionNo는 입력과 맞출 것. 정답 의미를 바꾸지 말 것(오류 수정만).",
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
        const parsed = parseJsonSafely(json);
        const repaired = normalizeRepairedEntries(parsed.entries || []);
        if (repaired.length === 0) {
          failures.push(`${modelName}: 보정 결과 비어 있음`);
          continue;
        }
        const setCheck = repairOutputMatchesInput(entries, repaired);
        if (!setCheck.ok) {
          failures.push(`${modelName}: ${setCheck.detail ?? "출력 문항 집합 불일치"}`);
          continue;
        }
        const gate = validateExportDocEntries(repaired);
        if (!gate.ok) {
          failures.push(`${modelName}: 보정 후 규칙 미통과 - ${gate.issues.join(" | ")}`);
          continue;
        }
        const warnings = repaired.flatMap((entry) =>
          getExportRepairWarnings(entry).map((warning) => `${entry.questionNo}번(${warning})`),
        );
        return NextResponse.json({ entries: repaired, model: modelName, warnings });
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
          const parsed = parseJsonSafely(json);
          const repaired = normalizeRepairedEntries(parsed.entries || []);
          const setCheck = repairOutputMatchesInput(entries, repaired);
          const gate = validateExportDocEntries(repaired);
          if (repaired.length > 0 && setCheck.ok && gate.ok) {
            const warnings = repaired.flatMap((entry) =>
              getExportRepairWarnings(entry).map((warning) => `${entry.questionNo}번(${warning})`),
            );
            return NextResponse.json({
              entries: repaired,
              model: `${openAiModel} (openai-fallback)`,
              warnings,
            });
          }
          if (repaired.length === 0) {
            failures.push(`openai:${openAiModel}: 보정 결과 비어 있음`);
          } else if (!setCheck.ok) {
            failures.push(
              `openai:${openAiModel}: ${setCheck.detail ?? "출력 문항 집합 불일치"}`,
            );
          } else {
            failures.push(`openai:${openAiModel}: 보정 후 규칙 미통과 - ${gate.issues.join(" | ")}`);
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

