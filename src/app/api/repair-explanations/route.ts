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

const REPAIR_MODEL_CANDIDATES = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"] as const;

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
    const prompt = [
      "다음 문항 해설들을 DOCX 내보내기용으로 정제해.",
      "반드시 JSON 하나만 반환하고, JSON 외 문장은 절대 출력하지 마.",
      '형식: {"entries":[{"questionNo":"1","quickAnswer":"...","body":"..."}]}',
      "",
      "[필수 규칙]",
      "- quickAnswer, body는 비우지 마.",
      "- LaTeX 표기($, \\frac, \\sqrt, \\binom, \\left, \\right 등) 금지.",
      "- 중고등학교 교육과정의 일반적인 풀이로 재작성.",
      "- 추정/근사/어림/대충/감으로 계산 방식 금지.",
      "- [해설] 본문은 학생이 따라갈 수 있게 단계형 문장으로 작성.",
      "- 근사값이 꼭 필요한 문제여도 '추정한다' 같은 표현 대신 명확한 근거를 제시.",
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
        return NextResponse.json({ entries: repaired, model: modelName });
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 오류";
        failures.push(`${modelName}: ${message}`);
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

