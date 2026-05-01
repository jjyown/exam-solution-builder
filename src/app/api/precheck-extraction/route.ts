import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

type PrecheckRequestBody = {
  imageBase64?: string;
  imageMimeType?: string;
  crop?: unknown;
};

type VisionPrecheckResult = {
  pass: boolean;
  score: number;
  missing: string[];
  reasons: string[];
};

const PRECHECK_MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.0-flash"] as const;

function extractJsonObject(raw: string) {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || first >= last) return null;
  return raw.slice(first, last + 1);
}

function normalizePrecheck(payload: unknown): VisionPrecheckResult {
  if (!payload || typeof payload !== "object") {
    return {
      pass: false,
      score: 0,
      missing: ["문제영역"],
      reasons: ["모델 응답 형식을 해석하지 못했습니다."],
    };
  }
  const data = payload as Record<string, unknown>;
  const score =
    typeof data.score === "number"
      ? Math.max(0, Math.min(100, Math.round(data.score)))
      : 0;
  const missing = Array.isArray(data.missing)
    ? data.missing.map((item) => String(item)).filter(Boolean)
    : [];
  const reasons = Array.isArray(data.reasons)
    ? data.reasons.map((item) => String(item)).filter(Boolean)
    : [];
  const passByFlag = data.pass === true;
  const pass = passByFlag || (score >= 70 && missing.length === 0);
  return { pass, score, missing, reasons };
}

export async function POST(request: Request) {
  try {
    const apiKey =
      process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY(또는 GOOGLE_API_KEY)가 설정되지 않았습니다." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as PrecheckRequestBody;
    const imageBase64 = body.imageBase64?.trim();
    const imageMimeType = body.imageMimeType?.trim() || "image/png";

    if (!imageBase64) {
      return NextResponse.json({ error: "문제 이미지 데이터가 없습니다." }, { status: 400 });
    }

    const client = new GoogleGenerativeAI(apiKey);
    const prompt = [
      "너는 수학 문제 이미지 품질 검수기다.",
      "중고등 수학 문제 해설 생성 전, 이미지에서 핵심 정보 누락 여부만 판단하라.",
      "반드시 JSON 하나만 반환하라. 다른 문장 금지.",
      '형식: {"pass":boolean,"score":0-100,"missing":[string],"reasons":[string]}',
      "판단 기준:",
      "- 문제 본문 문장이 식별 가능해야 함",
      "- 객관식이면 선택지(①~⑤ 또는 1~5) 가급적 식별 가능해야 함",
      "- 조건/식/도형 핵심 정보가 잘리지 않아야 함",
      "- 흐림, 잘림, 과도한 여백으로 정보가 부족하면 fail",
      body.crop ? `- 사용자 크롭 정보 참고: ${JSON.stringify(body.crop)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const failures: string[] = [];
    for (const modelName of PRECHECK_MODEL_CANDIDATES) {
      try {
        const model = client.getGenerativeModel({ model: modelName });
        const result = await model.generateContent([
          { text: prompt },
          {
            inlineData: {
              data: imageBase64,
              mimeType: imageMimeType,
            },
          },
        ]);
        const raw = result.response.text()?.trim() ?? "";
        if (!raw) {
          failures.push(`${modelName}: 빈 응답`);
          continue;
        }
        const jsonText = extractJsonObject(raw);
        if (!jsonText) {
          failures.push(`${modelName}: JSON 추출 실패`);
          continue;
        }
        const parsed = JSON.parse(jsonText) as unknown;
        const normalized = normalizePrecheck(parsed);
        return NextResponse.json({ ...normalized, model: modelName }, { status: 200 });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "알 수 없는 사전검증 모델 오류";
        failures.push(`${modelName}: ${message}`);
      }
    }

    return NextResponse.json(
      {
        pass: false,
        score: 0,
        missing: ["문제영역"],
        reasons: ["비전 사전검증 모델 호출에 실패했습니다."],
        details: failures,
      },
      { status: 502 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 서버 오류";
    return NextResponse.json(
      { error: `사전검증 처리 중 오류가 발생했습니다: ${message}` },
      { status: 500 },
    );
  }
}

