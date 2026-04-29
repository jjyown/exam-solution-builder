import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

const SYSTEM_PROMPT = `너는 10년 차 고등 수학 전문 교사야.
[출력 양식]
[빠른 정답] : (여기에 1~5번 객관식 번호나 주관식 단답형 정답만 딱 1줄로 출력해)
---
[출제 의도 및 개념] : 핵심 수학 개념 1~2줄 설명
[조건 분석] : 주어진 조건의 의미
[단계별 풀이] : Step 1, Step 2 등으로 나누어 상세히 설명
[최종 정답 확인] : '따라서 정답은 ~이다' 형식

모든 수식은 반드시 LaTeX 형식으로 작성하고, 인라인 수식은 $...$, 블록 수식은 $$...$$를 사용해.
반드시 한국 초/중/고 교육과정에서 통용되는 수학 용어와 기호만 사용해.
영문 수학 용어(예: combination, permutation, integral, derivative, limit, function, domain, range)는 쓰지 말고 한국어 용어로 바꿔.
기호도 학교 수업 표기 기준을 우선 사용해. 예: 조합은 $_nC_r$ 또는 $\\binom{n}{r}$, 순열은 $_nP_r$.
[단계별 풀이]의 단계 표시는 Step 대신 '1단계, 2단계'처럼 한국어로 작성해.`;

type GenerateRequestBody = {
  questionText?: string;
  imageBase64?: string;
  imageMimeType?: string;
  diagramImageBase64?: string;
  diagramMimeType?: string;
  diagramImages?: Array<{ imageBase64?: string; mimeType?: string }>;
  includeDiagramExplanation?: boolean;
  explanationSelectionMode?: "all" | "core";
  showAllMethods?: boolean;
  generationMode?: "test" | "final";
  mimeType?: string;
  crop?: unknown;
};

const FINAL_MODEL_CANDIDATES = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"] as const;
const TEST_MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"] as const;

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY가 설정되지 않았습니다." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as GenerateRequestBody;
    const questionText = body.questionText?.trim() ?? "";
    const imageBase64 = body.imageBase64?.trim();
    const mimeType =
      body.imageMimeType?.trim() || body.mimeType?.trim() || "image/png";
    const diagramImageBase64 = body.diagramImageBase64?.trim();
    const diagramMimeType = body.diagramMimeType?.trim() || "image/png";
    const diagramImages = (body.diagramImages || [])
      .map((item) => ({
        imageBase64: item.imageBase64?.trim() || "",
        mimeType: item.mimeType?.trim() || "image/png",
      }))
      .filter((item) => item.imageBase64);
    const includeDiagramExplanation = body.includeDiagramExplanation !== false;
    const explanationSelectionMode = body.explanationSelectionMode || "all";
    const showAllMethods = body.showAllMethods !== false;
    const generationMode = body.generationMode === "test" ? "test" : "final";
    const modelCandidates =
      generationMode === "test" ? TEST_MODEL_CANDIDATES : FINAL_MODEL_CANDIDATES;

    if (!imageBase64) {
      return NextResponse.json(
        { error: "문제 이미지 데이터가 없습니다." },
        { status: 400 },
      );
    }

    const client = new GoogleGenerativeAI(apiKey);

    const prompt = [
      "다음 문제를 해설해줘.",
      "",
      `[문제 텍스트]`,
      questionText || "(텍스트 미입력 - 이미지의 문제를 직접 읽어 해설해줘)",
      "",
      "[추가 지시]",
      "- 출력 양식을 정확히 지켜줘.",
      "- 수식은 LaTeX로 작성해.",
      "- [빠른 정답]은 한 줄로만 작성해.",
      "- 이미지에서 선택지 ①~⑤ 또는 1~5 보기 형식이 보이면 객관식으로 판단해.",
      "- 객관식으로 판단되면 [빠른 정답]에는 정답 번호만 1~5 중 하나로 출력해(해설 문장 금지).",
      "- 주관식이면 [빠른 정답]에는 최종 식/값만 간단히 출력해.",
      "- 이미지가 일부 흐리거나 누락되어도 '이미지가 제공되지 않았다'고 쓰지 말고, 판독 가능한 정보 기준으로 최선의 해설을 작성해.",
      "- 반드시 한국 초/중/고 수학 교과에서 쓰는 용어와 기호만 사용해.",
      "- 영문 수학 용어 대신 한국어 용어를 사용해.",
      "- 조합/순열 표기는 학교 수업 표기(예: $_nC_r$, $_nP_r$, 또는 동치 표기)로 작성해.",
      "- 문제 텍스트가 없으면 이미지의 문제를 직접 해석해 풀이해.",
      includeDiagramExplanation
        ? "- 그림/도형/그래프가 있으면 해설에 의미와 해석 포인트를 반드시 포함해."
        : "- 그림/도형 설명은 핵심에 필요한 경우에만 짧게 포함해.",
      explanationSelectionMode === "all"
        ? "- 괜찮은 해설 관점이 여러 개면 모두 제시해."
        : "- 해설 관점이 여러 개라도 핵심 1~2개만 엄선해서 제시해.",
      showAllMethods
        ? "- 풀이 방법이 여러 개면 [단계별 풀이]에서 [방법 1], [방법 2], [방법 3] 형식으로 모두 제시해."
        : "- 풀이 방법은 대표 1가지만 제시해.",
      body.crop ? `- 사용자 크롭 정보: ${JSON.stringify(body.crop)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const contents: Array<
      { text: string } | { inlineData: { data: string; mimeType: string } }
    > = [
      {
        text: prompt,
      },
      {
        inlineData: {
          data: imageBase64,
          mimeType,
        },
      },
    ];

    if (diagramImageBase64) {
      contents.push({
        text: "추가 그림(도형/그래프) 참고 이미지",
      });
      contents.push({
        inlineData: {
          data: diagramImageBase64,
          mimeType: diagramMimeType,
        },
      });
    }

    diagramImages.forEach((diagram, index) => {
      contents.push({
        text: `추가 그림(도형/그래프) 참고 이미지 ${index + 1}`,
      });
      contents.push({
        inlineData: {
          data: diagram.imageBase64,
          mimeType: diagram.mimeType,
        },
      });
    });

    const failures: string[] = [];

    for (const modelName of modelCandidates) {
      try {
        const model = client.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 3000,
          },
          systemInstruction: SYSTEM_PROMPT,
        });
        const result = await model.generateContent(contents);
        const generatedText = result.response.text()?.trim();
        if (!generatedText) {
          failures.push(`${modelName}: 응답 비어 있음`);
          continue;
        }
        return NextResponse.json({ result: generatedText, model: modelName }, { status: 200 });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "알 수 없는 모델 호출 오류";
        failures.push(`${modelName}: ${message}`);
      }
    }

    return NextResponse.json(
      {
        error: "해설 생성 실패: 사용 가능한 Gemini 모델 호출에 모두 실패했습니다.",
        details: failures,
      },
      { status: 502 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 서버 오류";
    console.error("Gemini API error:", message, error);
    return NextResponse.json(
      { error: `해설 생성 중 서버 오류가 발생했습니다: ${message}` },
      { status: 500 },
    );
  }
}
