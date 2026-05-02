import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { buildSystemInstruction } from "./prompts";
import { getRuntimePromptRules } from "@/lib/supabasePromptRules";
import { isGeminiRateLimitedMessage } from "@/lib/geminiRateLimit";

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
  solverModelProfile?: "easy" | "balanced" | "killer";
  mimeType?: string;
  crop?: unknown;
  quickAnswerPageHint?: string;
  explanationReferenceHint?: string;
};

function parseModelCandidatesFromEnv(envKey: string, fallback: string[]) {
  const normalize = (models: string[]) =>
    Array.from(
      new Set(
        models
          .map((item) => item.trim())
          .filter(Boolean)
          // v1beta generateContent에서 404가 반복되는 1.5 계열은 자동 제외한다.
          .filter((name) => !/^gemini-1\.5-(pro|flash)$/i.test(name)),
      ),
    );

  const raw = process.env[envKey]?.trim();
  if (!raw) {
    const normalizedFallback = normalize(fallback);
    return normalizedFallback.length > 0 ? normalizedFallback : ["gemini-2.0-flash"];
  }
  const parsed = normalize(raw.split(","));
  if (parsed.length > 0) return parsed;
  const normalizedFallback = normalize(fallback);
  return normalizedFallback.length > 0 ? normalizedFallback : ["gemini-2.0-flash"];
}

const FINAL_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_GENERATE_FINAL", [
  "gemini-2.0-flash",
]);
const TEST_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_GENERATE_TEST", [
  "gemini-2.0-flash",
]);
const EASY_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_GENERATE_EASY", [
  "gemini-2.0-flash",
]);
const BALANCED_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_GENERATE_BALANCED", [
  "gemini-2.0-flash",
]);
const KILLER_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_GENERATE_KILLER", [
  "gemini-2.0-flash",
]);

function pickModelCandidates(params: {
  generationMode: "test" | "final";
  solverModelProfile: "easy" | "balanced" | "killer";
}) {
  const { generationMode, solverModelProfile } = params;
  if (solverModelProfile === "easy") {
    return generationMode === "test" ? [...EASY_MODEL_CANDIDATES] : [...FINAL_MODEL_CANDIDATES];
  }
  if (solverModelProfile === "killer") {
    return generationMode === "test" ? [...TEST_MODEL_CANDIDATES] : [...KILLER_MODEL_CANDIDATES];
  }
  if (solverModelProfile === "balanced") {
    return generationMode === "test"
      ? [...TEST_MODEL_CANDIDATES]
      : [...BALANCED_MODEL_CANDIDATES];
  }
  return generationMode === "test" ? [...TEST_MODEL_CANDIDATES] : [...FINAL_MODEL_CANDIDATES];
}

function validateExplanationFormat(text: string) {
  const normalized = text.trim();
  const missing: string[] = [];

  if (!/^\s*\[정답\]/i.test(normalized)) {
    missing.push("[정답] 선두 시작(앞에 서두·다른 문항 금지)");
  }
  const headerExplainCount = (normalized.match(/\[해설\]/gi) ?? []).length;
  if (headerExplainCount !== 1) {
    missing.push(
      headerExplainCount === 0
        ? "[해설]"
        : "[해설] 헤더는 응답당 정확히 한 번(연쇄 문항 붙여넣기 금지)",
    );
  }

  const answerMatch = normalized.match(/\[정답\]\s*([^\n\r]*)/i);
  const explanationMatch = normalized.match(/\[해설\]\s*([\s\S]+)/i);
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

/** 단일 문항 생성인데 타 문항 스크랩이 붙은 경우(규칙/컨텍스트 오염) 탐지 */
function validateCrossProblemBleed(text: string) {
  const issues: string[] = [];
  const explanation = text.match(/\[해설\]\s*([\s\S]+)/i)?.[1]?.trim() ?? "";
  if (!explanation) return { ok: true, issues };

  // 주의: '입니다/습니다' 뒤 줄바꿈 + '2.' 는 정상 단계 번호(1. 2. 3. 풀이)와 동일해 오탐이 매우 많다. 사용하지 않는다.

  if (/(?:^|\n)\s*(?:다음|이어서|또\s*다른)\s*문제/m.test(explanation)) {
    issues.push(
      "[해설]에 다른 문항으로 이어지는 표현이 있습니다. 현재 크롭의 한 문항만 완결해 주세요.",
    );
  }

  if (/(?:^|\n)\s*(?:[3-9]|1[0-9])\s*번\s*(?:문항|문제)/m.test(explanation)) {
    issues.push(
      "[해설]에 다른 문항 번호가 등장했습니다. 단일 크롭 문항만 다루세요.",
    );
  }

  // 연쇄 문항: 2)[정답], 3.[정답] … 한 응답에 여러 문제 붙이기
  if (/\d+\)\s*\[정답\]/i.test(explanation)) {
    issues.push(
      "[해설] 안에 연속 문항 표기(예: 2)[정답])가 있습니다. 한 문항만 출력하세요.",
    );
  }
  if (/(?:^|\n)\s*\d+\.\s*\[정답\]/im.test(explanation)) {
    issues.push(
      "[해설] 안에 번호 매긴 두 번째 [정답]이 있습니다. 한 문항만 출력하세요.",
    );
  }
  // [해설] 본문 속 추가 [정답] (첫 블록 밖의 연쇄 출력)
  const explainInnerAnswer = explanation.match(/\[정답\]/gi);
  if (explainInnerAnswer && explainInnerAnswer.length > 0) {
    issues.push(
      "[해설] 본문에 [정답]이 들어가 있습니다. 맨 앞 [정답] 한 번만 쓰세요.",
    );
  }

  const answerHeaders = text.match(/\[정답\]/gi);
  if (answerHeaders && answerHeaders.length > 1) {
    issues.push("[정답] 헤더가 여러 번입니다. 한 문항만 출력하세요.");
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

function validatePedagogicalPolicy(
  text: string,
  solverModelProfile: "easy" | "balanced" | "killer" = "balanced",
) {
  const issues: string[] = [];
  const answer = text.match(/\[정답\]\s*([^\n\r]*)/i)?.[1]?.trim() ?? "";
  const explanation = text.match(/\[해설\]\s*([\s\S]+)/i)?.[1]?.trim() ?? "";
  const combined = `${answer}\n${explanation}`.trim();
  const estimationPattern =
    /근삿?값|추정|근사|어림|대략|감으로|찍어서|적당히|approx(?:imately)?|≈|≒|약\s*\d/i;
  if (estimationPattern.test(combined)) {
    issues.push("근삿값/추정 중심 풀이 표현이 감지되었습니다.");
  }
  const methodCount = (explanation.match(/\[방법\s*\d+\]/g) ?? []).length;
  const lines = explanation.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numberedLines = lines.filter((line) => /^\d+\.\s/.test(line)).length;
  const stepHeavy =
    lines.length >= 3 && numberedLines >= 2 && numberedLines / lines.length >= 0.35;
  const maxChars =
    solverModelProfile === "killer" ? 5500 : solverModelProfile === "easy" ? 2000 : 3200;
  const maxLines =
    solverModelProfile === "killer" ? 26 : solverModelProfile === "easy" ? 14 : 18;
  if (methodCount <= 1) {
    const tooLongByChars = explanation.length > maxChars;
    const tooLongBySteps = stepHeavy && lines.length > maxLines;
    if (tooLongBySteps || (!stepHeavy && tooLongByChars)) {
      issues.push("단일 풀이 기준으로 해설이 과도하게 장문입니다. 핵심 수식 중심으로 압축해 주세요.");
    }
  }
  return { ok: issues.length === 0, issues };
}

function hasCriticalPedagogyIssue(issues: string[]) {
  return issues.some((issue) => /근삿값|추정/.test(issue));
}

function splitPedagogyIssues(issues: string[]) {
  const critical = issues.filter((issue) => /근삿값|추정/.test(issue));
  const warnings = issues.filter((issue) => !/근삿값|추정/.test(issue));
  return { critical, warnings };
}

function buildRetryInstruction(
  formatMissing: string[],
  consistencyIssues: string[],
  scopeIssues: string[],
  pedagogyIssues: string[],
  retryHistory: string[] = [],
  retryAttempt = 1,
) {
  const lines: string[] = [
    "[재요청]",
    "직전 응답은 형식/정합 기준을 만족하지 못했습니다.",
  ];
  if (retryHistory.length > 0) {
    lines.push("[이전 시도 위반 요약]");
    retryHistory.forEach((item) => lines.push(`- ${item}`));
  }
  if (retryAttempt >= 2) {
    lines.push("[강조]");
    lines.push("이전 위반이 반복되었습니다. 같은 실수를 절대 반복하지 마세요.");
  }
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
  if (pedagogyIssues.length > 0) {
    lines.push(`수업/출제 기준 이슈: ${pedagogyIssues.join(" / ")}`);
    lines.push("중고등학교 20년 교사 + 출제위원 토론을 거쳐 정석 풀이/학생 친화 요약본으로 다시 작성하세요.");
    lines.push("수식·등식 연쇄로 압축하고, 먼저/다음으로 문장 나열·보기 일일이 검토로 분량을 늘리지 마세요.");
  }
  lines.push(
    "[단일 문항] 첨부 크롭은 한 문항만이다. 2)[정답]·여러 [해설]·본문 속 [정답]으로 연쇄 붙이기 금지. '다음 문제', '3번 문항'도 금지. 수식·등호 위주로 짧게, 1.2.3. 줄번호·말로만 긴 풀이 금지.",
  );
  lines.push("반드시 아래 형식으로만 다시 작성하세요.");
  lines.push("[정답] (한 줄)");
  lines.push("[해설]");
  lines.push("(해설 본문)");
  lines.push("특히 근사값(약, ≈, 1.414 등)을 사용하지 말고, 식 전개로 결론을 도출하세요.");
  lines.push("해설은 중간에 끊기지 않게 마지막 문장까지 완결하세요.");
  lines.push("다른 제목/머리말/설명문을 추가하지 마세요.");
  return lines.join("\n");
}

function inferDiagramAidNeed(questionText: string) {
  const text = questionText.trim();
  if (!text) {
    return {
      recommended: false,
      score: 0,
      reasons: ["문제 텍스트가 없어 자동 판정을 건너뜀"],
    };
  }

  const rules: Array<{ label: string; regex: RegExp; score: number }> = [
    { label: "도형/기하 키워드", regex: /(도형|기하|삼각형|사각형|원|부채꼴|현|접선|닮음|합동)/, score: 3 },
    { label: "좌표/그래프 키워드", regex: /(좌표평면|그래프|함수의 그래프|포물선|직선의 기울기|절편)/, score: 2 },
    { label: "작도/보조선 지시", regex: /(그림을 그려|도형을 그려|작도|보조선|연장선|수선의 발)/, score: 3 },
    { label: "각/길이 표기", regex: /(∠|각\s*[A-Z가-힣]|길이|넓이|둘레|반지름|지름)/, score: 2 },
    { label: "시각 자료 언급", regex: /(그림|도표|도식|다음 도형|아래 그림)/, score: 2 },
  ];

  let score = 0;
  const reasons: string[] = [];
  for (const rule of rules) {
    if (rule.regex.test(text)) {
      score += rule.score;
      reasons.push(rule.label);
    }
  }
  return {
    recommended: score >= 4,
    score,
    reasons: reasons.length ? reasons : ["도형 보조 이미지 필요 신호 낮음"],
  };
}

/** OpenAI vision은 user-only보다 system+user가 [정답]/[해설] 준수율이 높다 */
const OPENAI_VISION_EXPLANATION_SYSTEM = `당신은 중고등 수학 문제 이미지를 읽고, 사용자가 지정한 크롭의 한 문항만 푼다.
응답은 반드시 아래 형식만 사용한다. 인사·머리말·코드펜스(\`\`\`)·추가 제목 금지.
맨 앞은 공백만 허용하고 반드시 [정답]으로 시작한다. 서두 장문 뒤에 [정답]을 두지 않는다.
첫 줄: [정답] 한 줄에 최종 답만(객관식이면 1~5 하나).
그 다음 줄에만: [해설] (이 헤더는 전체에서 단 한 번)
그 다음 줄부터: 풀이 본문만 쓰고 즉시 종료. 2)[정답] 같은 연쇄 문항·두 번째 [해설]·본문 속 [정답] 금지.
풀이는 수식·등호 전개를 중심에 두고 한국어는 최소로. 1.2.3. 줄 번호 금지(난문제만 예외). 장황한 절차 서술 금지.
근호는 이미지에서 범위를 확정한다: 한 √ 안에 다른 루트가 들어간 중첩과 √·∛가 곱으로 나열된 경우를 혼동하지 말 것. 평문에서는 √(2×∛4)처럼 괄호로 중첩을 드러낼 것.
LaTeX($, \\frac 등) 금지. 조합은 nCk 표기.`;

async function generateWithOpenAiFallback(params: {
  apiKey: string;
  model: string;
  prompt: string;
  imageBase64: string;
  mimeType: string;
  diagramImageBase64?: string;
  diagramMimeType?: string;
  diagramImages: Array<{ imageBase64: string; mimeType: string }>;
}) {
  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: params.prompt }];
  content.push({
    type: "image_url",
    image_url: { url: `data:${params.mimeType};base64,${params.imageBase64}` },
  });
  if (params.diagramImageBase64) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${params.diagramMimeType || "image/png"};base64,${params.diagramImageBase64}`,
      },
    });
  }
  params.diagramImages.forEach((item) => {
    content.push({
      type: "image_url",
      image_url: { url: `data:${item.mimeType};base64,${item.imageBase64}` },
    });
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        { role: "system", content: OPENAI_VISION_EXPLANATION_SYSTEM },
        { role: "user", content },
      ],
      temperature: 0.2,
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

function isCrossVerifyEnabled() {
  return (process.env.EXPLANATION_CROSS_VERIFY || "").trim().toLowerCase() === "true";
}

function resolveCrossVerifyModel() {
  return process.env.OPENAI_MODEL_CROSS_VERIFY?.trim() || "gpt-4o";
}

/** Gemini 1차 초안과 동일 기준으로 교차검증 결과를 받아들일지 판단 */
function passesPrimaryQualityGate(
  generatedText: string,
  solverModelProfile: "easy" | "balanced" | "killer" = "balanced",
) {
  const formatCheck = validateExplanationFormat(generatedText);
  const consistencyCheck = validateExplanationConsistency(generatedText);
  const bleedCheck = validateCrossProblemBleed(generatedText);
  const consistencyEffective = {
    ok: consistencyCheck.ok && bleedCheck.ok,
    issues: [...consistencyCheck.issues, ...bleedCheck.issues],
  };
  const scopeCheck = validateCurriculumScope(generatedText);
  const pedagogyCheck = validatePedagogicalPolicy(generatedText, solverModelProfile);
  return (
    formatCheck.ok &&
    consistencyEffective.ok &&
    scopeCheck.ok &&
    pedagogyCheck.ok &&
    !isLikelyTruncatedResult(generatedText)
  );
}

function buildCrossVerifyUserPrompt(
  draft: string,
  ctx: {
    generationMode: "test" | "final";
    solverModelProfile: "easy" | "balanced" | "killer";
  },
) {
  const profileLine =
    ctx.solverModelProfile === "easy"
      ? "문항 난이도 힌트: 비교적 단순한 유형 위주로 검증."
      : ctx.solverModelProfile === "killer"
        ? "문항 난이도 힌트: 고난도·함정·세부 조건을 놓치지 않도록 검증."
        : "문항 난이도 힌트: 일반 난이도 기준으로 검증.";
  const modeLine =
    ctx.generationMode === "test"
      ? "생성 모드: 테스트(초안 점검)."
      : "생성 모드: 최종(발행 수준).";
  return [
    "[역할]",
    "당신은 중고등 수학 해설의 독립 검토자다. 첨부 이미지는 사용자가 지정한 단일 문항 크롭이다. 문제를 다시 읽고, 아래 [초안]의 정답·풀이가 그 한 문항의 조건·보기와 논리적으로 일치하는지 검증하라.",
    "다른 문항의 풀이가 섞였다면 제거하고, 이 문항만 [정답]+[해설]로 완결하라.",
    modeLine,
    profileLine,
    "",
    "[출력 규칙]",
    "- 출력은 [정답] 한 줄, [해설] 본문만. 인사·머리말·메타 설명 금지.",
    "- [해설]은 말로 장황하게 풀지 말고 수식·등식 연쇄 위주로 짧게 유지할 것.",
    "- LaTeX($, \\\\frac, \\\\sqrt 등) 금지. 조합은 nCk 표기.",
    "- 중고등 교육과정 범위를 벗어난 전공 수학 용어·기호 금지.",
    "- 초안이 완전히 옳으면 내용을 바꾸지 말고 동일 결론을 형식에 맞게 재출력.",
    "- 계산 오류·조건 누락·객관식 보기 불일치 등 오류가 있으면 올바른 해설로 전체를 다시 작성.",
    "- 초안에 2)[정답]·세 번째 문항 풀이가 붙어 있으면 삭제하고, 이미지의 한 문항만 남겨라.",
    "- 제곱근·세제곱근: 이미지에서 근호 중첩과 근호들의 곱을 혼동하지 않았는지 초안의 식 구조와 대조한다. 특히 √(안쪽 전체) 인지 √a×∛b 인지부터 검증한다.",
    "",
    "[초안]",
    draft,
  ].join("\n");
}

async function runOpenAiCrossVerify(params: {
  draft: string;
  openAiApiKey: string;
  imageBase64: string;
  mimeType: string;
  diagramImageBase64?: string;
  diagramMimeType?: string;
  diagramImages: Array<{ imageBase64: string; mimeType: string }>;
  generationMode: "test" | "final";
  solverModelProfile: "easy" | "balanced" | "killer";
}): Promise<{ text: string; crossVerified: boolean; verifyWarning?: string }> {
  if (!isCrossVerifyEnabled() || !params.openAiApiKey) {
    return { text: params.draft, crossVerified: false };
  }
  const verifyModel = resolveCrossVerifyModel();
  const verifyPrompt = buildCrossVerifyUserPrompt(params.draft, {
    generationMode: params.generationMode,
    solverModelProfile: params.solverModelProfile,
  });
  try {
    const verified = await generateWithOpenAiFallback({
      apiKey: params.openAiApiKey,
      model: verifyModel,
      prompt: verifyPrompt,
      imageBase64: params.imageBase64,
      mimeType: params.mimeType,
      diagramImageBase64: params.diagramImageBase64,
      diagramMimeType: params.diagramMimeType,
      diagramImages: params.diagramImages,
    });
    if (!verified.trim()) {
      return {
        text: params.draft,
        crossVerified: false,
        verifyWarning: "교차검증 응답이 비어 있어 1차 초안을 유지했습니다.",
      };
    }
    if (!passesPrimaryQualityGate(verified, params.solverModelProfile)) {
      return {
        text: params.draft,
        crossVerified: false,
        verifyWarning:
          "교차검증 결과가 내부 품질 검증을 통과하지 못해 1차 초안을 유지했습니다.",
      };
    }
    return { text: verified, crossVerified: true };
  } catch {
    return {
      text: params.draft,
      crossVerified: false,
      verifyWarning: "교차검증 호출에 실패해 1차 초안을 유지했습니다.",
    };
  }
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
    const explanationSelectionMode = body.explanationSelectionMode || "core";
    const showAllMethods = body.showAllMethods === true;
    const generationMode = body.generationMode === "test" ? "test" : "final";
    const solverModelProfile =
      body.solverModelProfile === "easy" ||
      body.solverModelProfile === "balanced" ||
      body.solverModelProfile === "killer"
        ? body.solverModelProfile
        : "balanced";
    const runtimeRules = await getRuntimePromptRules();
    const systemInstruction = buildSystemInstruction(solverModelProfile, runtimeRules);
    const modelCandidates = pickModelCandidates({
      generationMode,
      solverModelProfile,
    });
    const diagramAid = inferDiagramAidNeed(questionText);
    const openAiApiKey =
      process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_KEY?.trim() || "";
    const openAiModel =
      process.env.OPENAI_MODEL_GENERATE_FALLBACK?.trim() || "gpt-4o-mini";

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
      "[입력 계약]",
      "- 첨부 이미지는 사용자가 시험지에서 지정한 단일 문항 영역(크롭)이다. 보통 원하는 문항만 골라 지정하므로 번호가 연속이 아니거나(예: 2번·5번만), 옆 칸에 다른 문항이 비치는 것은 정상이다. 크롭 안의 그 문항 하나만 푼다.",
      "- 이 호출에서 출력은 반드시 한 문항만: [정답] 블록 1개, [해설] 블록 1개.",
      "- 연쇄 출력 금지: 보기 ①~⑤를 검토한 뒤에도 다른 문제를 이어 풀지 마라. 2)[정답], 3.[정답] 형태로 여러 문항을 한 응답에 붙이지 마라.",
      "- 응답 전체에서 [해설] 헤더는 정확히 한 번. [해설] 본문 안에 [정답]을 다시 쓰지 마라.",
      "- 출력은 선행 문구 없이 [정답]으로 시작하라(첫 줄이 문제 풀이 본문이 되면 안 된다).",
      "- 다른 문항 번호·선택지·풀이를 인용하거나 이어 붙이지 마라.",
      "- 근삿값·추정·어림으로 결론을 내리지 말고, 교과서 수준의 정확한 전개로 마무리하라.",
      solverModelProfile === "easy"
        ? "- 분량·스타일: [해설]은 짧게. 등식 연쇄 위주, 말로 풀어쓰기 최소화."
        : solverModelProfile === "killer"
          ? "- 분량·스타일: 필요한 논리는 빠짐없이 쓰되, 여전히 수식 전개를 우선하고 말길로 늘리지 마라. 한 문항 안에서만 완결."
          : "- 분량·스타일: 수식 중심으로 압축. 불필요한 서두·보기 나열로 길이를 늘리지 마라.",
      "",
      `[문제 텍스트]`,
      questionText || "(텍스트 미입력 - 이미지의 문제를 직접 읽어 해설해줘)",
      "",
      "[추가 지시]",
      "- 너는 내부적으로 '중고등학교 수학 20년 경력 교사'와 '수능/내신 출제위원'이 토론해 합의한 최종 해설만 출력한다.",
      "- 내부 토론 과정은 출력하지 말고, 최종 결론만 제시해.",
      "- 내부 순서: 식 구조 확인 → 등식으로 전개 → [정답] 확정. 출력에서는 내부 단계를 장문으로 설명하지 마라.",
      "- 출력 양식을 정확히 지켜줘.",
      "- 수식은 LaTeX 표기(\\binom, \\frac 등)로 쓰지 말고 학생이 읽기 쉬운 일반 표기로 작성해.",
      "- [근호·식 구조] 이미지에서 제곱근·세제곱근의 위선이 어디까지 덮는지 먼저 확인하고 풀이를 시작해. √ 안에 수와 다른 근호가 함께 묶인 경우(중첩)와 √와 ∛가 서로 따로 곱해진 경우는 값이 다르다. 추측하지 말고 인쇄된 기호 범위를 따른다.",
      "- 평문 수식에서는 중첩을 반드시 괄호로 드러낸다. 예: √(2×∛4)처럼 한 제곱근 안에 세제곱근이 묶인 형과, √2×∛4처럼 둘이 곱인 형은 서로 다른 식이다.",
      "- 식 해석은 한 줄로 수식으로만 표시(예: 주어진 식 = (√(2×∛4))^3). 틀린 해석이면 이후 전개는 무효다.",
      "- 조합은 반드시 nCk 표기(예: 10C3)로 작성해.",
      "- [해설] 본문 첫 줄에 문제 번호(예: 17.)를 다시 쓰지 마.",
      "- [해설] 스타일: 수식·등호 연쇄를 본문 축으로 쓴다. '먼저/다음으로/이제'로 문장을 늘리지 말 것. 1.2.3. 줄번호 금지(예외: 복잡한 분기만 최소). 객관식은 보기를 일일이 검토하며 늘리지 말고 필요한 비교만.",
      "- [정답], [해설] 형식을 엄격히 유지해.",
      "- 이미지에서 선택지 ①~⑤ 또는 1~5 보기 형식이 보이면 객관식으로 판단해.",
      "- 객관식이면 [정답]에 정답 번호만 1~5 중 하나로 출력해.",
      "- 단답형이면 [정답]에 최종 식/값만 간단히 출력해.",
      "- 서술형(예: 서술하시오/증명하시오/과정을 쓰시오 지시가 명시된 경우)일 때만 [정답]은 '해설참고'로 출력하고, 실제 답안은 [해설]에 작성해.",
      "- 문제 유형이 애매하면 서술형으로 가정하지 말고 객관식/단답형 기준으로 정답을 출력해.",
      "- 이미지가 일부 흐리거나 누락되어도 '이미지가 제공되지 않았다'고 쓰지 말고, 판독 가능한 정보 기준으로 최선의 해설을 작성해.",
      "- 반드시 중고등학교 교육과정 내 용어/기호만 사용하고 대학 수준 용어/기호는 사용하지 마.",
      "- 영문 수학 용어 대신 한국어 용어를 사용해.",
      "- 정석 풀이가 가능한 문제에서 근삿값/추정/어림 계산으로 답을 내지 마.",
      "- 쉬운·중간 난이도는 [해설]을 짧게 끝낸다. 같은 내용을 말과 식에 중복 쓰지 마라.",
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
      solverModelProfile === "easy"
        ? "- 모델 프로필: 쉬운 문제 우선(속도/안정성 중심)으로 풀이 정확도를 확보해."
        : solverModelProfile === "killer"
          ? "- 모델 프로필: 킬러 문제 우선(고난도 정밀 추론 중심)으로 풀이를 진행해."
          : "- 모델 프로필: 균형형(일반~고난도 모두 안정적)으로 풀이해.",
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
    const recursiveIssueHistory: string[] = [];

    geminiModels: for (const modelName of modelCandidates) {
      try {
        const model = client.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 3000,
          },
          systemInstruction,
        });
        const result = await model.generateContent(contents);
        const generatedText = result.response.text()?.trim();
        if (!generatedText) {
          failures.push(`${modelName}: 응답 비어 있음`);
          continue;
        }
        const formatCheck = validateExplanationFormat(generatedText);
        const consistencyCheck = validateExplanationConsistency(generatedText);
        const bleedCheck = validateCrossProblemBleed(generatedText);
        const consistencyEffective = {
          ok: consistencyCheck.ok && bleedCheck.ok,
          issues: [...consistencyCheck.issues, ...bleedCheck.issues],
        };
        const scopeCheck = validateCurriculumScope(generatedText);
        const pedagogyCheck = validatePedagogicalPolicy(generatedText, solverModelProfile);
        if (
          formatCheck.ok &&
          consistencyEffective.ok &&
          scopeCheck.ok &&
          pedagogyCheck.ok &&
          !isLikelyTruncatedResult(generatedText)
        ) {
          const cross = await runOpenAiCrossVerify({
            draft: generatedText,
            openAiApiKey,
            imageBase64,
            mimeType,
            diagramImageBase64,
            diagramMimeType,
            diagramImages: diagramImages.map((item) => ({
              imageBase64: item.imageBase64,
              mimeType: item.mimeType,
            })),
            generationMode,
            solverModelProfile,
          });
          const verifyModelTag = resolveCrossVerifyModel();
          const qualityWarningsCross = cross.verifyWarning ? [cross.verifyWarning] : [];
          return NextResponse.json(
            {
              result: cross.text,
              model: cross.crossVerified
                ? `${modelName}+${verifyModelTag}(cross-verify)`
                : modelName,
              qualityWarnings: qualityWarningsCross,
              diagramAidRecommendation: diagramAid,
              crossVerified: cross.crossVerified,
            },
            { status: 200 },
          );
        }

        const qualityWarnings = [
          ...formatCheck.missing.map((item) => `형식 누락: ${item}`),
          ...consistencyEffective.issues,
          ...scopeCheck.issues,
          ...pedagogyCheck.issues,
        ];
        recursiveIssueHistory.push(
          ...qualityWarnings.filter(Boolean).map((item) => `1차 시도 위반: ${item}`),
        );
        const retryContents: Array<
          { text: string } | { inlineData: { data: string; mimeType: string } }
        > = [
          ...contents,
          {
            text: buildRetryInstruction(
              formatCheck.missing,
              consistencyEffective.issues,
              scopeCheck.issues,
              pedagogyCheck.issues,
              recursiveIssueHistory.slice(-6),
              1,
            ),
          },
        ];
        let retryResult;
        try {
          retryResult = await model.generateContent(retryContents);
        } catch (retryError) {
          const retryMsg =
            retryError instanceof Error ? retryError.message : "알 수 없는 모델 호출 오류";
          failures.push(`${modelName}: 형식 재시도 중 오류 - ${retryMsg}`);
          if (isGeminiRateLimitedMessage(retryMsg)) {
            failures.push(
              "generate: Gemini 할당량/혼잡(429)으로 추가 모델 순회를 생략합니다.",
            );
            break geminiModels;
          }
          continue;
        }
        const retryText = retryResult.response.text()?.trim();
        if (!retryText) {
          failures.push(`${modelName}: 형식 재시도 응답 비어 있음`);
          continue;
        }
        const retryFormatCheck = validateExplanationFormat(retryText);
        const retryConsistencyCheck = validateExplanationConsistency(retryText);
        const retryBleedCheck = validateCrossProblemBleed(retryText);
        const retryConsistencyEffective = {
          ok: retryConsistencyCheck.ok && retryBleedCheck.ok,
          issues: [...retryConsistencyCheck.issues, ...retryBleedCheck.issues],
        };
        const retryScopeCheck = validateCurriculumScope(retryText);
        const retryPedagogyCheck = validatePedagogicalPolicy(retryText, solverModelProfile);
        if (
          !retryFormatCheck.ok ||
          !retryConsistencyEffective.ok ||
          !retryScopeCheck.ok ||
          !retryPedagogyCheck.ok ||
          isLikelyTruncatedResult(retryText)
        ) {
          failures.push(
            `${modelName}: 형식/정합 검증 실패(재시도 포함) - 누락: ${retryFormatCheck.missing.join(
              ", ",
            )} / 정합 이슈: ${retryConsistencyEffective.issues.join(" | ")} / 교육과정 이탈: ${retryScopeCheck.issues.join(
              " | ",
            )} / 수업기준 이슈: ${retryPedagogyCheck.issues.join(" | ")}`,
          );
          continue;
        }
        const crossRetry = await runOpenAiCrossVerify({
          draft: retryText,
          openAiApiKey,
          imageBase64,
          mimeType,
          diagramImageBase64,
          diagramMimeType,
          diagramImages: diagramImages.map((item) => ({
            imageBase64: item.imageBase64,
            mimeType: item.mimeType,
          })),
          generationMode,
          solverModelProfile,
        });
        const verifyModelTagRetry = resolveCrossVerifyModel();
        const qualityWarningsMerged = [...qualityWarnings];
        if (crossRetry.verifyWarning) qualityWarningsMerged.push(crossRetry.verifyWarning);
        return NextResponse.json(
          {
            result: crossRetry.text,
            model: crossRetry.crossVerified
              ? `${modelName}+${verifyModelTagRetry}(cross-verify)`
              : modelName,
            retriedForFormat: true,
            qualityWarnings: qualityWarningsMerged,
            diagramAidRecommendation: diagramAid,
            crossVerified: crossRetry.crossVerified,
          },
          { status: 200 },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "알 수 없는 모델 호출 오류";
        failures.push(`${modelName}: ${message}`);
        if (isGeminiRateLimitedMessage(message)) {
          failures.push(
            "generate: Gemini 할당량/혼잡(429)으로 추가 모델 순회를 생략합니다.",
          );
          break geminiModels;
        }
      }
    }

    if (openAiApiKey) {
      try {
        const openAiText = await generateWithOpenAiFallback({
          apiKey: openAiApiKey,
          model: openAiModel,
          prompt,
          imageBase64,
          mimeType,
          diagramImageBase64,
          diagramMimeType,
          diagramImages: diagramImages.map((item) => ({
            imageBase64: item.imageBase64,
            mimeType: item.mimeType,
          })),
        });
        if (openAiText) {
          const formatCheck = validateExplanationFormat(openAiText);
          const consistencyCheck = validateExplanationConsistency(openAiText);
          const bleedCheck = validateCrossProblemBleed(openAiText);
          const consistencyEffective = {
            ok: consistencyCheck.ok && bleedCheck.ok,
            issues: [...consistencyCheck.issues, ...bleedCheck.issues],
          };
          const scopeCheck = validateCurriculumScope(openAiText);
          const pedagogyCheck = validatePedagogicalPolicy(openAiText, solverModelProfile);
          const pedagogySplit = splitPedagogyIssues(pedagogyCheck.issues);
          const truncated = isLikelyTruncatedResult(openAiText);

          if (
            formatCheck.ok &&
            consistencyEffective.ok &&
            scopeCheck.ok &&
            !truncated &&
            pedagogySplit.critical.length === 0
          ) {
            return NextResponse.json(
              {
                result: openAiText,
                model: `${openAiModel} (openai-fallback)`,
                qualityWarnings: pedagogySplit.warnings,
                diagramAidRecommendation: diagramAid,
              },
              { status: 200 },
            );
          }

          const openAiRetryEnv = (process.env.OPENAI_EXPLANATION_FORMAT_RETRY || "")
            .trim()
            .toLowerCase();
          const allowOpenAiFormatRetry = openAiRetryEnv !== "false";

          if (!allowOpenAiFormatRetry) {
            failures.push(
              `openai:${openAiModel}: 형식/정합 검증 실패 - OpenAI 2차 호출 생략(OPENAI_EXPLANATION_FORMAT_RETRY=false) - 누락: ${formatCheck.missing.join(", ")} / 정합: ${consistencyEffective.issues.join(" | ")} / 범위: ${scopeCheck.issues.join(" | ")} / 수업기준(치명): ${pedagogySplit.critical.join(" | ") || "없음"} / 수업기준(경고): ${pedagogySplit.warnings.join(" | ") || "없음"}`,
            );
          } else {
            const retryInstruction = buildRetryInstruction(
              formatCheck.missing,
              consistencyEffective.issues,
              scopeCheck.issues,
              pedagogyCheck.issues,
              [
                ...recursiveIssueHistory.slice(-6),
                ...pedagogyCheck.issues.map((item) => `OpenAI 1차 위반: ${item}`),
              ],
              2,
            );
            const retryText = await generateWithOpenAiFallback({
              apiKey: openAiApiKey,
              model: openAiModel,
              prompt: `${prompt}\n\n${retryInstruction}`,
              imageBase64,
              mimeType,
              diagramImageBase64,
              diagramMimeType,
              diagramImages: diagramImages.map((item) => ({
                imageBase64: item.imageBase64,
                mimeType: item.mimeType,
              })),
            });
            if (retryText) {
              const retryFormatCheck = validateExplanationFormat(retryText);
              const retryConsistencyCheck = validateExplanationConsistency(retryText);
              const retryBleedCheck = validateCrossProblemBleed(retryText);
              const retryConsistencyEffective = {
                ok: retryConsistencyCheck.ok && retryBleedCheck.ok,
                issues: [...retryConsistencyCheck.issues, ...retryBleedCheck.issues],
              };
              const retryScopeCheck = validateCurriculumScope(retryText);
              const retryPedagogyCheck = validatePedagogicalPolicy(retryText, solverModelProfile);
              const retryPedagogySplit = splitPedagogyIssues(retryPedagogyCheck.issues);
              const retryTruncated = isLikelyTruncatedResult(retryText);

              if (
                retryFormatCheck.ok &&
                retryConsistencyEffective.ok &&
                retryScopeCheck.ok &&
                !retryTruncated &&
                retryPedagogySplit.critical.length === 0
              ) {
                return NextResponse.json(
                  {
                    result: retryText,
                    model: `${openAiModel} (openai-fallback)`,
                    retriedForFormat: true,
                    qualityWarnings: retryPedagogySplit.warnings,
                    diagramAidRecommendation: diagramAid,
                  },
                  { status: 200 },
                );
              }
              failures.push(
                `openai:${openAiModel}: 형식/정합 검증 실패(재시도 포함) - 누락: ${retryFormatCheck.missing.join(", ")} / 정합: ${retryConsistencyEffective.issues.join(" | ")} / 범위: ${retryScopeCheck.issues.join(" | ")} / 수업기준(치명): ${retryPedagogySplit.critical.join(" | ") || "없음"} / 수업기준(경고): ${retryPedagogySplit.warnings.join(" | ") || "없음"}`,
              );
            } else {
              failures.push(`openai:${openAiModel}: 재시도 응답 비어 있음`);
            }
          }
        } else {
          failures.push(`openai:${openAiModel}: 응답 비어 있음`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 OpenAI 오류";
        failures.push(`openai:${openAiModel}: ${message}`);
      }
    }

    return NextResponse.json(
      {
        error: "해설 생성 실패: 사용 가능한 Gemini/OpenAI 모델 호출에 모두 실패했습니다.",
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
