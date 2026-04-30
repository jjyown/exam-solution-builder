import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";

const SYSTEM_PROMPT = `당신은 중고등학생 대상 수학 전문 학원의 교재 및 해설 제작 마스터입니다.
사용자가 구분선(예: '---' 또는 '===')으로 구분하여 여러 개의 수학 문제를 한 번에 입력할 것입니다.
당신의 유일한 임무는 입력된 모든 문제를 순서대로 풀이한 뒤, 개별로 분리하지 말고 반드시 '단 하나의 통합된 텍스트 문서'로 출력하는 것입니다.

[출력 필수 양식]
반드시 아래의 '빠른 정답 및 해설' 양식을 엄격하게 지켜서 하나의 결과물로 출력하세요.

[정답] (여기에 정답 번호 또는 값)
[해설]
(여기에 상세한 문제 풀이 과정)

[정답] (여기에 정답 번호 또는 값)
[해설]
(여기에 상세한 문제 풀이 과정)

... (입력된 모든 문제에 대해 동일한 양식으로 끝까지 작성할 것)

[절대 주의사항]

단일 문서 출력: 문제마다 답변을 끊어서 여러 번 나누어 출력하지 마세요. 반드시 모든 문제의 해설을 모아서 한 번에 응답해야 합니다.

학생 눈높이 맞춤 (매우 중요): 대상은 중고등학생입니다. 반드시 중고등학교 수학 교육과정 내에서 다루는 기호와 용어, 개념만 사용하여 풀이를 작성하세요. 대학교 수준의 수학 기호나 풀이 방식(예: 로피탈의 정리, 편미분, 선형대수학 기호 등)은 절대 사용해서는 안 됩니다.

불필요한 텍스트 생략: "네, 알겠습니다", "해설을 제작해 드립니다" 같은 인사말이나 부연 설명은 절대 포함하지 마세요. 오직 해설지 내용만 출력하세요.

디자인 및 표기: 수식은 가독성 있게 작성하고, 불필요한 한자(漢字)는 절대 사용하지 마세요. 깔끔하고 직관적인 구성을 유지하십시오.`;

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
  quickAnswerPageHint?: string;
  explanationReferenceHint?: string;
};

const FINAL_MODEL_CANDIDATES = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"] as const;
const TEST_MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"] as const;

function validateExplanationFormat(text: string) {
  const normalized = text.trim();
  const answerMatch = normalized.match(/\[정답\]\s*([^\n\r]*)/i);
  const explanationMatch = normalized.match(/\[해설\]\s*([\s\S]+)/i);
  const missing: string[] = [];

  if (!answerMatch) missing.push("[정답]");
  if (!explanationMatch) missing.push("[해설]");
  if (answerMatch && !answerMatch[1]?.trim()) missing.push("[정답] 값");
  if (explanationMatch && !explanationMatch[1]?.trim()) missing.push("[해설] 본문");
  if (explanationMatch && explanationMatch[1]?.trim()?.length < 35) {
    missing.push("[해설] 본문 분량");
  }

  return { ok: missing.length === 0, missing };
}

function isLikelyTruncatedResult(text: string) {
  const explanation = text.match(/\[해설\]\s*([\s\S]*)/i)?.[1]?.trim() ?? "";
  if (explanation.length < 50) return true;
  if (/[,:+\-*/=]$/.test(explanation)) return true;
  const openParen = (explanation.match(/[({\[]/g) ?? []).length;
  const closeParen = (explanation.match(/[)}\]]/g) ?? []).length;
  return openParen > closeParen;
}

function normalizeChoice(value: string) {
  return value
    .trim()
    .replace("①", "1")
    .replace("②", "2")
    .replace("③", "3")
    .replace("④", "4")
    .replace("⑤", "5");
}

function validateExplanationConsistency(text: string) {
  const issues: string[] = [];
  const answerRegex = /\[정답\]\s*([^\n\r]*)/gi;
  const answerMatches = [...text.matchAll(answerRegex)];
  const answerTypes = new Set<"objective" | "subjective">();

  answerMatches.forEach((match, idx) => {
    const answerRaw = match[1]?.trim() ?? "";
    const normalizedAnswer = normalizeChoice(answerRaw);
    const answerChoice = normalizedAnswer.match(/^[1-5]$/)?.[0];
    if (answerChoice) {
      answerTypes.add("objective");
    } else if (normalizedAnswer) {
      answerTypes.add("subjective");
    }

    const currentStart = match.index ?? 0;
    const nextStart = answerMatches[idx + 1]?.index ?? text.length;
    const sectionText = text.slice(currentStart, nextStart);
    const declaredChoices = [...sectionText.matchAll(/정답(?:은|:)?\s*([①②③④⑤1-5])/gi)].map(
      (item) => normalizeChoice(item[1] ?? ""),
    );

    if (answerChoice && declaredChoices.length > 0) {
      const hasConflict = declaredChoices.some((declared) => declared !== answerChoice);
      if (hasConflict) {
        issues.push(
          `${idx + 1}번 문항의 [정답](${answerChoice})과 [해설] 내 정답 표기가 서로 다릅니다.`,
        );
      }
    }
  });

  if (answerMatches.length > 1 && answerTypes.size > 1) {
    issues.push(
      "문항 간 [정답] 형식이 혼합되어 있습니다(객관식 번호/주관식 값). 가능한 한 형식을 일관되게 맞춰 주세요.",
    );
  }

  return { ok: issues.length === 0, issues };
}

function validateCurriculumScope(text: string) {
  const issues: string[] = [];
  const bannedPatterns: Array<{ label: string; regex: RegExp }> = [
    { label: "로피탈", regex: /로피탈|l['’]?\s*h[ôo]pital/i },
    { label: "편미분", regex: /편미분|partial derivative|∂/i },
    { label: "선형대수", regex: /선형대수|linear algebra|고유값|고유벡터|eigenvalue|eigenvector/i },
    { label: "야코비안", regex: /야코비안|jacobian/i },
    { label: "라그랑주 승수", regex: /라그랑주\s*승수|lagrange multiplier/i },
    { label: "벡터미적분", regex: /curl|divergence|gradient theorem|스토크스 정리|가우스 발산정리/i },
    { label: "적분기호 남용", regex: /∮|⨌|삼중적분|다중적분/i },
  ];

  for (const rule of bannedPatterns) {
    if (rule.regex.test(text)) {
      issues.push(`교육과정 외 표현 감지: ${rule.label}`);
    }
  }

  return { ok: issues.length === 0, issues };
}

function buildRetryInstruction(
  formatMissing: string[],
  consistencyIssues: string[],
  scopeIssues: string[],
) {
  const lines: string[] = [
    "[재요청]",
    "직전 응답은 형식/정합 기준을 만족하지 못했습니다.",
  ];
  if (formatMissing.length > 0) {
    lines.push(`형식 누락 항목: ${formatMissing.join(", ")}`);
    lines.push("반드시 [정답] 한 줄 + [해설] 본문 구조를 유지하세요.");
  }
  if (consistencyIssues.length > 0) {
    lines.push(`정합 이슈: ${consistencyIssues.join(" / ")}`);
    lines.push("문항별 [정답]과 [해설] 내부 정답 표기를 서로 일치시키세요.");
  }
  if (scopeIssues.length > 0) {
    lines.push(`교육과정 이탈 이슈: ${scopeIssues.join(" / ")}`);
    lines.push("중고등 교육과정 외 용어/기호(편미분, 선형대수, 로피탈 등)를 제거하세요.");
  }
  lines.push("반드시 아래 형식으로만 다시 작성하세요.");
  lines.push("[정답] (한 줄)");
  lines.push("[해설]");
  lines.push("(해설 본문)");
  lines.push("해설은 중간에 끊기지 않게 마지막 문장까지 완결하세요.");
  lines.push("다른 제목/머리말/설명문을 추가하지 마세요.");
  return lines.join("\n");
}

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
      "- 내부 처리 순서를 반드시 지켜: 1) 문제 풀이 2) 빠른정답 확정 3) 해설 작성.",
      "- 출력 양식을 정확히 지켜줘.",
      "- 수식은 LaTeX 표기(\\binom, \\frac 등)로 쓰지 말고 학생이 읽기 쉬운 일반 표기로 작성해.",
      "- 조합은 반드시 nCk 표기(예: 10C3)로 작성해.",
      "- [해설] 본문 첫 줄에 문제 번호(예: 17.)를 다시 쓰지 마.",
      "- [정답], [해설] 형식을 엄격히 유지해.",
      "- 이미지에서 선택지 ①~⑤ 또는 1~5 보기 형식이 보이면 객관식으로 판단해.",
      "- 객관식이면 [정답]에 정답 번호만 1~5 중 하나로 출력해.",
      "- 단답형이면 [정답]에 최종 식/값만 간단히 출력해.",
      "- 서술형(예: 서술하시오/증명하시오/과정을 쓰시오 지시가 명시된 경우)일 때만 [정답]은 '해설참고'로 출력하고, 실제 답안은 [해설]에 작성해.",
      "- 문제 유형이 애매하면 서술형으로 가정하지 말고 객관식/단답형 기준으로 정답을 출력해.",
      "- 이미지가 일부 흐리거나 누락되어도 '이미지가 제공되지 않았다'고 쓰지 말고, 판독 가능한 정보 기준으로 최선의 해설을 작성해.",
      "- 반드시 중고등학교 교육과정 내 용어/기호만 사용하고 대학 수준 용어/기호는 사용하지 마.",
      "- 영문 수학 용어 대신 한국어 용어를 사용해.",
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
      body.quickAnswerPageHint
        ? `- ${body.quickAnswerPageHint}가 제공된 경우 해당 정답 기준과 모순되지 않게 검증해.`
        : "",
      body.explanationReferenceHint
        ? `- ${body.explanationReferenceHint}가 제공된 경우 구성/서술 흐름을 참고하되, 현재 문제 기준으로 재정리해.`
        : "",
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
        const formatCheck = validateExplanationFormat(generatedText);
        const consistencyCheck = validateExplanationConsistency(generatedText);
        const scopeCheck = validateCurriculumScope(generatedText);
        if (
          formatCheck.ok &&
          consistencyCheck.ok &&
          scopeCheck.ok &&
          !isLikelyTruncatedResult(generatedText)
        ) {
          return NextResponse.json(
            { result: generatedText, model: modelName, qualityWarnings: [] },
            { status: 200 },
          );
        }

        const qualityWarnings = [
          ...formatCheck.missing.map((item) => `형식 누락: ${item}`),
          ...consistencyCheck.issues,
          ...scopeCheck.issues,
        ];
        const retryContents: Array<
          { text: string } | { inlineData: { data: string; mimeType: string } }
        > = [
          ...contents,
          {
            text: buildRetryInstruction(
              formatCheck.missing,
              consistencyCheck.issues,
              scopeCheck.issues,
            ),
          },
        ];
        const retryResult = await model.generateContent(retryContents);
        const retryText = retryResult.response.text()?.trim();
        if (!retryText) {
          failures.push(`${modelName}: 형식 재시도 응답 비어 있음`);
          continue;
        }
        const retryFormatCheck = validateExplanationFormat(retryText);
        const retryConsistencyCheck = validateExplanationConsistency(retryText);
        const retryScopeCheck = validateCurriculumScope(retryText);
        if (
          !retryFormatCheck.ok ||
          !retryConsistencyCheck.ok ||
          !retryScopeCheck.ok ||
          isLikelyTruncatedResult(retryText)
        ) {
          failures.push(
            `${modelName}: 형식/정합 검증 실패(재시도 포함) - 누락: ${retryFormatCheck.missing.join(
              ", ",
            )} / 정합 이슈: ${retryConsistencyCheck.issues.join(" | ")} / 교육과정 이탈: ${retryScopeCheck.issues.join(
              " | ",
            )}`,
          );
          continue;
        }
        return NextResponse.json(
          {
            result: retryText,
            model: modelName,
            retriedForFormat: true,
            qualityWarnings,
          },
          { status: 200 },
        );
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
