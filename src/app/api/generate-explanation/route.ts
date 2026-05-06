import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { resolveGeminiGenerateEnvKey } from "@/lib/generateExplanationGeminiEnv";
import { buildSystemInstruction } from "./prompts";
import { getRuntimePromptRules } from "@/lib/runtimePromptRules";
import { isGeminiRateLimitedMessage } from "@/lib/geminiRateLimit";
import { DEFAULT_GEMINI_COST_MODELS } from "@/lib/geminiDefaultModels";
import { CHIEF_EDITOR_MATPLOTLIB_LINE } from "@/lib/chiefEditorPrompts";
import {
  validateObjectiveMcAnswer,
} from "@/lib/explanationAnswerValidators";
import {
  buildExplanationProgressReport,
  type SolverProfile,
} from "@/lib/explanationProgressReport";
import {
  isLikelyTruncatedResult,
  validateCrossProblemBleed,
  validateExplanationConsistency,
  validateExplanationFormat,
} from "@/lib/reasoning/explanationFormatPolicy";
import {
  buildRetryInstruction,
  inferDiagramAidNeed,
  splitPedagogyIssues,
  validateCurriculumScope,
  validatePedagogicalPolicy,
} from "@/lib/reasoning/explanationPolicy";
import { buildTextbookReferencePromptBlock } from "@/lib/reasoning/textbookReferenceSelector";

/** data URL 접두사 제거 + 순수 Base64 + MIME 정규화 (Gemini inlineData 호환) */
function parseInlineImage(
  raw: string,
  mimeFallback: string,
): { base64: string; mimeType: string } {
  const fallback =
    mimeFallback.trim().toLowerCase() === "image/jpg" ? "image/jpeg" : mimeFallback.trim() || "image/png";

  const t = raw.trim();
  const dataUrlMatch = t.match(/^data:\s*([^;]+)\s*;\s*base64\s*,\s*([\s\S]+)$/i);
  if (dataUrlMatch) {
    let mime = (dataUrlMatch[1] ?? "").trim().split(";")[0]?.trim().toLowerCase() || fallback;
    if (mime === "image/jpg") mime = "image/jpeg";
    const base64 = (dataUrlMatch[2] ?? "").replace(/\s/g, "");
    return { base64, mimeType: mime || fallback };
  }

  const base64 = t.replace(/\s/g, "");
  let mime = fallback;
  if (mime === "image/jpg") mime = "image/jpeg";
  return { base64, mimeType: mime };
}

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
  textbookUnit?: string;
  textbookType?: string;
  textbookDifficulty?: string;
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
    return normalizedFallback.length > 0 ? normalizedFallback : [...DEFAULT_GEMINI_COST_MODELS];
  }
  const parsed = normalize(raw.split(","));
  if (parsed.length > 0) return parsed;
  const normalizedFallback = normalize(fallback);
  return normalizedFallback.length > 0 ? normalizedFallback : [...DEFAULT_GEMINI_COST_MODELS];
}

const FINAL_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_GENERATE_FINAL", [
  ...DEFAULT_GEMINI_COST_MODELS,
]);
const TEST_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_GENERATE_TEST", [
  ...DEFAULT_GEMINI_COST_MODELS,
]);
const EASY_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_GENERATE_EASY", [
  ...DEFAULT_GEMINI_COST_MODELS,
]);
const BALANCED_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_GENERATE_BALANCED", [
  ...DEFAULT_GEMINI_COST_MODELS,
]);
const KILLER_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_GENERATE_KILLER", [
  ...DEFAULT_GEMINI_COST_MODELS,
]);

/** 해설 본문이 중간에 잘리지 않도록 상한을 넉넉히(환경변수로 조절). */
function resolveGeminiExplanationMaxOutputTokens() {
  const raw = process.env.GEMINI_MAX_OUTPUT_TOKENS_EXPLANATION?.trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 6144;
  return Math.min(8192, Math.max(2048, Math.floor(n)));
}

function pickModelCandidates(params: {
  generationMode: "test" | "final";
  solverModelProfile: "easy" | "balanced" | "killer";
}) {
  const key = resolveGeminiGenerateEnvKey(params);
  if (key === "GEMINI_MODELS_GENERATE_EASY") return [...EASY_MODEL_CANDIDATES];
  if (key === "GEMINI_MODELS_GENERATE_FINAL") return [...FINAL_MODEL_CANDIDATES];
  if (key === "GEMINI_MODELS_GENERATE_TEST") return [...TEST_MODEL_CANDIDATES];
  if (key === "GEMINI_MODELS_GENERATE_BALANCED") return [...BALANCED_MODEL_CANDIDATES];
  if (key === "GEMINI_MODELS_GENERATE_KILLER") return [...KILLER_MODEL_CANDIDATES];
  return [...FINAL_MODEL_CANDIDATES];
}


/** 출제 비평·정답 번복·모순 유발 표현(저품질 해설 패턴) */
function validateNoMetaUndermining(text: string) {
  const issues: string[] = [];
  const explanation = text.match(/\[해설\]\s*([\s\S]+)/i)?.[1]?.trim() ?? "";
  if (!explanation) return { ok: true, issues };

  const patterns: Array<{ label: string; regex: RegExp }> = [
    { label: "출제/문제 오류·비평 표현", regex: /문제(?:에|의)?\s*오류|출제\s*오류|오류(?:가\s*)?있는\s*문제/ },
    { label: "기존·이전 풀이 메타 언급", regex: /기존\s*풀이|이전\s*(?:풀이|응답)|원본\s*풀이/ },
    {
      label: "정답·결론 번복 문장",
      regex: /답(?:은)?\s*.+이\s*아니라|최종\s*답은\s*.+이\s*아니라|아니라\s*보기|문제\s*의도와\s*다르|반드시\s*\d+여야/,
    },
    {
      label: "조건 불충분·풀이 불가 단정",
      regex: /추가\s*조건이\s*필요|이대로는\s*(?:답을\s*)?구할\s*수\s*없|풀\s*수\s*없(?:습니다|다)\./,
    },
    {
      label: "모순·논리 붕괴·풀이 중단 표현",
      regex:
        /그러나[^。\n\u002E]{0,80}모순|하지만[^。\n\u002E]{0,80}모순|논리(?:적)?\s*모순|모순(?:이|을)\s*(?:있|난|드러|생)|다른\s*(?:접근|풀이)(?:이|을)?\s*필요|재\s*검토\s*필요|답을\s*확정할\s*수\s*없/,
    },
  ];
  for (const { label, regex } of patterns) {
    if (regex.test(explanation)) {
      issues.push(`[해설]에 ${label}이 감지되었습니다. 교과서형 정석 풀이만 쓰세요.`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/** =1 직후 4\\log, 1\\log_ 등으로 14·1log 오인되는 조판 */
function validateMathTypesettingLegibility(text: string) {
  const issues: string[] = [];
  const explanation = text.match(/\[해설\]\s*([\s\S]+)/i)?.[1]?.trim() ?? "";
  if (!explanation) return { ok: true, issues };

  if (/=\s*1\s+\d\s*\\log/i.test(explanation)) {
    issues.push(
      "[해설] 로그 전개에서 '= 1' 직후 같은 흐름에 '4\\\\log' 등 숫자+\\\\log가 붙어 '14'로 읽힐 수 있습니다. 단계별 줄바꿈·별도 $...$ 또는 계수에 \\\\cdot(\\\\,)를 넣어 구분하세요.",
    );
  }
  // \\frac{...}{...}\\log 처럼 } 바로 앞의 1은 제외(오탐 방지). 줄 시작·연산자 뒤의 1\\log_ 만 금지
  if (/(?:^|[^0-9}\\])1\\log_/m.test(explanation)) {
    issues.push(
      "[해설] '1\\\\log_{...}'처럼 계수 1과 \\\\log를 붙이지 마세요(1과 l이 붙어 읽힘). 곱셈 1은 생략하거나 '1\\\\cdot\\\\log_{...}'로 쓰세요. '=1'로 끝난 직후 다음 단계는 새 줄·새 $...$로 나누세요.",
    );
  }

  return { ok: issues.length === 0, issues };
}

function mergeConsistencyIssues(text: string) {
  const consistencyCheck = validateExplanationConsistency(text);
  const mcCheck = validateObjectiveMcAnswer(text);
  const bleedCheck = validateCrossProblemBleed(text);
  const metaCheck = validateNoMetaUndermining(text);
  const typesetCheck = validateMathTypesettingLegibility(text);
  return {
    ok:
      consistencyCheck.ok &&
      mcCheck.ok &&
      bleedCheck.ok &&
      metaCheck.ok &&
      typesetCheck.ok,
    issues: [
      ...consistencyCheck.issues,
      ...mcCheck.issues,
      ...bleedCheck.issues,
      ...metaCheck.issues,
      ...typesetCheck.issues,
    ],
  };
}

/** 성공 응답에 단계별 progressReport(JSON)를 붙여 UI·배치 로그에서 활용한다. */
function jsonSuccessWithProgress(
  body: {
    result: string;
    model: string;
    qualityWarnings: string[];
    diagramAidRecommendation: unknown;
    crossVerified?: boolean;
    retriedForFormat?: boolean;
  },
  profile: SolverProfile,
  verifyWarning?: string,
) {
  return NextResponse.json(
    {
      ...body,
      crossVerified: body.crossVerified ?? false,
      progressReport: buildExplanationProgressReport({
        finalText: body.result,
        model: body.model,
        qualityWarnings: body.qualityWarnings ?? [],
        crossVerified: body.crossVerified ?? false,
        verifyWarning,
        retriedForFormat: body.retriedForFormat,
        solverModelProfile: profile,
      }),
    },
    { status: 200 },
  );
}

/** OpenAI vision은 user-only보다 system+user가 [정답]/[해설] 준수율이 높다 */
const OPENAI_VISION_EXPLANATION_SYSTEM = `당신은 중고등 수학 문제 이미지를 읽고, 사용자가 지정한 크롭의 한 문항만 푼다.
응답은 반드시 아래 형식만 사용한다. 인사·머리말·추가 제목 금지. 코드펜스는 matplotlib용 \`\`\`python\`\`\` 만 예외로 허용한다.
맨 앞은 공백만 허용하고 반드시 [정답]으로 시작한다. 서두 장문 뒤에 [정답]을 두지 않는다.
첫 줄: [정답] 한 줄에 최종 답만(객관식이면 1~5 하나).
그 다음 줄에만: [해설] (이 헤더는 전체에서 단 한 번)
그 다음 줄부터: 풀이 본문만 쓰고 즉시 종료. 2)[정답] 같은 연쇄 문항·두 번째 [해설]·본문 속 [정답] 금지.
풀이는 수식·등호 전개를 중심에 두고 한국어는 최소로. 1.2.3. 줄 번호 금지(난문제만 예외). 장황한 절차 서술 금지. 전개 단계는 말로 대신하지 말고 $...$ 안의 수학 기호·등식으로 쓴다.
근호는 이미지에서 범위를 확정한다: 한 √ 안에 다른 루트가 들어간 중첩과 √·∛가 곱으로 나열된 경우를 혼동하지 말 것.
수식은 KaTeX 미리보기용으로 인라인 $ ... $ 안에만 쓴다(\\sqrt{}, \\frac{}{}, \\sin\\theta 등). 2^(1/2) 같은 캐럿(^)만으로 지수를 쌓지 말 것.
문제 이미지와 다른 식 구조로 풀면 오답이다. $\\sqrt{2\\sqrt[3]{4}}$ 와 $\\sqrt{2}\\sqrt[3]{4}$ 를 혼동하지 말 것. 삼각방정식은 양변에 cos 한 번 곱한 뒤 또 cos를 곱해 식을 바꾸지 말 것. 삼각·지수방정식은 최종 값을 원조건에 대입해 성립을 확인한다.
조합은 nCk 표기.
객관식·근사·'가장 가까운' 보기는 연산 끝에 보기·조건과 다시 대조해 검산한다. 중간값과 최종 번호가 모순되면 풀이를 고친다.
${CHIEF_EDITOR_MATPLOTLIB_LINE}`;

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

  const payload: Record<string, unknown> = {
    model: params.model,
    messages: [
      { role: "system", content: OPENAI_VISION_EXPLANATION_SYSTEM },
      { role: "user", content },
    ],
  };
  const t = resolveOpenAiRequestTemperature(params.model);
  if (t !== undefined) {
    payload.temperature = t;
  }
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(payload),
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

/** o·o3 등 추론 계열은 temperature 지정 시 API 400이 나는 경우가 많아 생략한다 */
function resolveOpenAiRequestTemperature(model: string): number | undefined {
  const id = model.trim().toLowerCase();
  if (/^o[0-9]/.test(id)) {
    return undefined;
  }
  return 0.2;
}

/**
 * 교차검증 OpenAI 모델 — **프로필별 라우팅**(종량제 비용 절감·전문가 합의).
 * - easy: `OPENAI_MODEL_CROSS_VERIFY_EASY` → (미설정 시) `gpt-4o-mini` — `OPENAI_MODEL_CROSS_VERIFY` 는 상속하지 않음
 * - balanced: `OPENAI_MODEL_CROSS_VERIFY_BALANCED` → `OPENAI_MODEL_CROSS_VERIFY` → `gpt-4o`
 * - killer: `OPENAI_MODEL_CROSS_VERIFY_KILLER` → `OPENAI_MODEL_CROSS_VERIFY` → `gpt-4o` (최고 역량이 필요하면 env에 gpt-5.2 등 지정)
 */
function resolveCrossVerifyModel(profile: "easy" | "balanced" | "killer") {
  const common = process.env.OPENAI_MODEL_CROSS_VERIFY?.trim();
  if (profile === "killer") {
    return (
      process.env.OPENAI_MODEL_CROSS_VERIFY_KILLER?.trim() ||
      common ||
      "gpt-4o"
    );
  }
  if (profile === "easy") {
    /** `OPENAI_MODEL_CROSS_VERIFY` 만 gpt-4o 로 두어도 easy 는 기본 mini — 비용 절감(전문가 하이브리드). */
    return process.env.OPENAI_MODEL_CROSS_VERIFY_EASY?.trim() || "gpt-4o-mini";
  }
  return process.env.OPENAI_MODEL_CROSS_VERIFY_BALANCED?.trim() || common || "gpt-4o";
}

/** Gemini 1차 초안과 동일 기준으로 교차검증 결과를 받아들일지 판단 */
function passesPrimaryQualityGate(
  generatedText: string,
  solverModelProfile: "easy" | "balanced" | "killer" = "balanced",
) {
  const formatCheck = validateExplanationFormat(generatedText);
  const consistencyEffective = mergeConsistencyIssues(generatedText);
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
    "- 단순 근호·지수 정리형인데 초안이 지수법칙만 열 줄 이상 나열했다면, **동일 결론을 근호 성질 등으로 더 짧게** 압축해 다시 써라(원고는 길이가 아니라 밀도가 기준).",
    "- 로그 전개: '= 1'로 끝난 직후 같은 줄·한 덩어리에 '4\\\\log'가 붙으면 **14**로 읽힌다. 단계를 나누고, 필요하면 '4\\\\cdot\\\\log' 형태로 고친다. '1\\\\log' 붙임도 금지(1\\\\cdot\\\\log 또는 생략).",
    "- 수식은 인라인 $ ... $ 안에 KaTeX로 쓴다. 초안이 캐럿(^)만으로 지수를 쌓았으면 달러 블록 안 표기로 고친다.",
    "- 중고등 교육과정 범위를 벗어난 전공 수학 용어·기호 금지.",
    "- 초안이 완전히 옳으면 내용을 바꾸지 말고 동일 결론을 형식에 맞게 재출력.",
    "- 계산 오류·조건 누락·객관식 보기 불일치 등 오류가 있으면 올바른 해설로 전체를 다시 작성.",
    "- 초안에 2)[정답]·세 번째 문항 풀이가 붙어 있으면 삭제하고, 이미지의 한 문항만 남겨라.",
    "- 제곱근·세제곱근: 이미지에서 근호 중첩과 근호들의 곱을 혼동하지 않았는지 초안의 식 구조와 대조한다. 특히 √(안쪽 전체) 인지 √a×∛b 인지부터 검증한다.",
    "- 방정식·삼각식이면 초안의 최종 값을 원조건에 대입해 성립하는지 확인한다. 성립하지 않으면 초안 계산 오류로 보고 수정한다.",
    "- 삼각방정식 초안에서 cosθ 등을 같은 단계에 두 번 곱해 항이 비정상적으로 바뀌었는지 확인한다.",
    "- '가장 가까운 정수·보기' 유형이면 중간 계산값과 객관식 번호·수치 답이 문제 규칙(반올림 등) 하에서 일치하는지 확인한다. 19.2인데 15번을 고른 식의 억지 선택이면 전면 수정한다.",
    "- 「문제 오류」「추가 조건 필요」「답은 ○이 아니라 △」「기존 풀이 오류」 같은 메타 문장과 근사(≈)만으로 결론 내리기 금지. 교과서형 단일 결론만.",
    "- 보기 ①~⑤가 보이는 객관식이면 [정답]은 1~5 한 자리만. 계산값만 [정답]에 넣는 오류를 고친다.",
    "- [정답]과 [해설] 결론의 보기 번호가 다르면 이미지 기준으로 맞는 쪽으로 통일한다.",
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
  const verifyModel = resolveCrossVerifyModel(params.solverModelProfile);
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
    const imageBase64Raw = body.imageBase64?.trim();
    const mimeHint =
      body.imageMimeType?.trim() || body.mimeType?.trim() || "image/png";
    const diagramImageBase64Raw = body.diagramImageBase64?.trim();
    const diagramMimeHint = body.diagramMimeType?.trim() || "image/png";
    const diagramImages = (body.diagramImages || [])
      .map((item) => {
        const raw = item.imageBase64?.trim() || "";
        if (!raw) return null;
        const parsed = parseInlineImage(raw, item.mimeType?.trim() || "image/png");
        return { imageBase64: parsed.base64, mimeType: parsed.mimeType };
      })
      .filter((item): item is { imageBase64: string; mimeType: string } => item !== null);
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
    const textbookReferenceBlock = await buildTextbookReferencePromptBlock({
      unit: body.textbookUnit?.trim(),
      type: body.textbookType?.trim(),
      difficulty: body.textbookDifficulty?.trim(),
      includeAllWhenNoTag: true,
      maxItems: 12,
    });
    const openAiApiKey =
      process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_KEY?.trim() || "";
    /** Gemini 실패 시 OpenAI 비전 폴백 — killer 만 상위 모델 기본(비용·품질 트레이드오프는 env로 조정) */
    const openAiModel =
      solverModelProfile === "killer"
        ? process.env.OPENAI_MODEL_GENERATE_FALLBACK_KILLER?.trim() ||
          process.env.OPENAI_MODEL_GENERATE_FALLBACK?.trim() ||
          "gpt-4o"
        : solverModelProfile === "easy"
          ? process.env.OPENAI_MODEL_GENERATE_FALLBACK_EASY?.trim() ||
            process.env.OPENAI_MODEL_GENERATE_FALLBACK?.trim() ||
            "gpt-4o-mini"
          : process.env.OPENAI_MODEL_GENERATE_FALLBACK_BALANCED?.trim() ||
            process.env.OPENAI_MODEL_GENERATE_FALLBACK?.trim() ||
            "gpt-4o-mini";

    if (!imageBase64Raw) {
      return NextResponse.json(
        { error: "문제 이미지 데이터가 없습니다." },
        { status: 400 },
      );
    }

    const questionImage = parseInlineImage(imageBase64Raw, mimeHint);
    if (!questionImage.base64) {
      return NextResponse.json(
        { error: "문제 이미지(Base64)가 비어 있거나 올바르지 않습니다." },
        { status: 400 },
      );
    }

    const diagramInline = diagramImageBase64Raw
      ? parseInlineImage(diagramImageBase64Raw, diagramMimeHint)
      : undefined;

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
      "- 대수·공통형이면 문과(수학 나)까지 따라올 수 있는 **교과서 정리**(보각·요각, sin²+cos²=1, 좌표 거리 등)로 정통 풀이를 끝낸다. **삼각함수 단원은 수열의 합(Σ)보다 앞**이므로 삼각 중심 정통 풀이에서는 Σ 없이 항 나열·1+1+… 교재형으로 쓰고, Σ·닫힌 합 공식·배각 위주 전개는 맨 뒤 '(참고·다른 풀이)'·'(다른 풀이 — 이과·참고)'로만 둔다.",
      "- [문제]에 ㄱ·ㄴ·ㄷ 보기가 있으면 <보기> 한 줄로 시작해 보기를 세로로 쓰고 </보기>로 닫는다(시스템 프롬프트와 동일).",
      "- 내부 토론 과정은 출력하지 말고, 최종 결론만 제시해.",
      "- 내부 순서: 근호 범위 확정 → 식 구조 한 줄로 재기술(KaTeX) → 등식 전개 → 검산 → [정답]. 출력에서는 내부 순서를 장문으로 설명하지 마라.",
      "- 출력 양식을 정확히 지켜줘.",
      "- 수식은 웹 미리보기용 KaTeX로 인라인 $ ... $ 안에만 쓴다(\\sqrt{}, \\sqrt[3]{}, \\frac{}{}, \\sin\\theta 등). 2^(1/2) 같은 캐럿(^)만으로 지수를 쌓지 마라.",
      "- [근호·식 구조] 이미지에서 제곱근·세제곱근 위선이 어디까지인지 먼저 확정한다. $\\sqrt{2\\sqrt[3]{4}}$ 와 $\\sqrt{2}\\times\\sqrt[3]{4}$ 는 완전히 다른 식이다. 추측하지 말고 인쇄 범위를 따른다.",
      "- [해설] 첫 등식 줄에 읽은 문제 식을 그 구조 그대로 한 번 적는다(예: $\\bigl(\\sqrt{2\\sqrt[3]{4}}\\bigr)^3$). 여기서 구조를 틀리면 이후 전개는 무효다.",
      "- 삼각방정식·지수·로그 등은 중간 전개 후 최종 답을 원조건에 대입해 한 줄로 성립 여부를 확인한다.",
      "- 삼각방정식은 양변에 cosθ 등을 한 번 곱해 정리한 뒤, 같은 줄에 또 cosθ를 곱해 cos²θ 항을 임의로 만들지 마라. 단계마다 한 번의 정당한 연산만.",
      "- 조합은 반드시 nCk 표기(예: 10C3)로 작성해.",
      "- [해설] 본문 첫 줄에 문제 번호(예: 17.)를 다시 쓰지 마.",
      "- [해설] 스타일: 수식·등호 연쇄를 본문 축으로 쓴다. '먼저/다음으로/이제'로 문장을 늘리지 말 것. 1.2.3. 줄번호 금지(예외: 복잡한 분기만 최소). 객관식은 보기를 일일이 검토하며 늘리지 말고 필요한 비교만.",
      "- [정답], [해설] 형식을 엄격히 유지해.",
      "- 이미지에서 선택지 ①~⑤ 또는 (1)~(5) 보기가 보이면 객관식으로 판단해.",
      "- 객관식이면 [정답]에는 **계산으로 나온 수치가 아니라** 선택한 **보기 번호만** 1~5 한 자리로 출력해. 산술 결과는 [해설]에만 쓴다.",
      "- [해설] 마지막 결론의 보기 번호와 [정답] 한 줄이 반드시 같아야 한다.",
      "- 단답형이면 [정답]에 최종 식/값만 간단히 출력해.",
      "- 서술형(예: 서술하시오/증명하시오/과정을 쓰시오 지시가 명시된 경우)일 때만 [정답]은 '해설참고'로 출력하고, 실제 답안은 [해설]에 작성해.",
      "- 문제 유형이 애매하면 서술형으로 가정하지 말고 객관식/단답형 기준으로 정답을 출력해.",
      "- 이미지가 일부 흐리거나 누락되어도 '이미지가 제공되지 않았다'고 쓰지 말고, 판독 가능한 정보 기준으로 최선의 해설을 작성해.",
      "- 반드시 중고등학교 교육과정 내 용어/기호만 사용하고 대학 수준 용어/기호는 사용하지 마.",
      "- 영문 수학 용어 대신 한국어 용어를 사용해.",
      "- 정석 풀이가 가능한 문제에서 근삿값/추정/어림 계산으로 답을 내지 마.",
      "- 쉬운·중간 난이도는 [해설]을 짧게 끝낸다. 같은 내용을 말과 식에 중복 쓰지 마라.",
      "- 단순 계산·근호 정리형은 **자명한 지수 중간단계를 한 줄씩만 길게 늘리지 마라.** $(\\sqrt\\cdot)^n$, $(\\sqrt[3]\\cdot)^3$ 등으로 줄일 수 있으면 그 경로를 우선하고, 부등·보기 비교는 필요한 한 블록만.",
      "- 로그: 이전 식이 $...=1$로 끝나면 다음 단계를 **새 줄·새 $...$**로 쓰고, `=1` 바로 옆에 `4\\\\log`를 붙이지 마라(14로 오인). `1\\\\log` 대신 계수 1 생략 또는 `1\\\\cdot\\\\log`.",
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
      textbookReferenceBlock,
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
          data: questionImage.base64,
          mimeType: questionImage.mimeType,
        },
      },
    ];

    if (diagramInline?.base64) {
      contents.push({
        text: "추가 그림(도형/그래프) 참고 이미지",
      });
      contents.push({
        inlineData: {
          data: diagramInline.base64,
          mimeType: diagramInline.mimeType,
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
            maxOutputTokens: resolveGeminiExplanationMaxOutputTokens(),
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
        const consistencyEffective = mergeConsistencyIssues(generatedText);
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
            imageBase64: questionImage.base64,
            mimeType: questionImage.mimeType,
            diagramImageBase64: diagramInline?.base64,
            diagramMimeType: diagramInline?.mimeType,
            diagramImages: diagramImages.map((item) => ({
              imageBase64: item.imageBase64,
              mimeType: item.mimeType,
            })),
            generationMode,
            solverModelProfile,
          });
          const verifyModelTag = resolveCrossVerifyModel(solverModelProfile);
          const qualityWarningsCross = cross.verifyWarning ? [cross.verifyWarning] : [];
          return jsonSuccessWithProgress(
            {
              result: cross.text,
              model: cross.crossVerified
                ? `${modelName}+${verifyModelTag}(cross-verify)`
                : modelName,
              qualityWarnings: qualityWarningsCross,
              diagramAidRecommendation: diagramAid,
              crossVerified: cross.crossVerified,
            },
            solverModelProfile,
            cross.verifyWarning,
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
        const retryConsistencyEffective = mergeConsistencyIssues(retryText);
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
          imageBase64: questionImage.base64,
          mimeType: questionImage.mimeType,
          diagramImageBase64: diagramInline?.base64,
          diagramMimeType: diagramInline?.mimeType,
          diagramImages: diagramImages.map((item) => ({
            imageBase64: item.imageBase64,
            mimeType: item.mimeType,
          })),
          generationMode,
          solverModelProfile,
        });
        const verifyModelTagRetry = resolveCrossVerifyModel(solverModelProfile);
        const qualityWarningsMerged = [...qualityWarnings];
        if (crossRetry.verifyWarning) qualityWarningsMerged.push(crossRetry.verifyWarning);
        return jsonSuccessWithProgress(
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
          solverModelProfile,
          crossRetry.verifyWarning,
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
          imageBase64: questionImage.base64,
          mimeType: questionImage.mimeType,
          diagramImageBase64: diagramInline?.base64,
          diagramMimeType: diagramInline?.mimeType,
          diagramImages: diagramImages.map((item) => ({
            imageBase64: item.imageBase64,
            mimeType: item.mimeType,
          })),
        });
        if (openAiText) {
          const formatCheck = validateExplanationFormat(openAiText);
          const consistencyEffective = mergeConsistencyIssues(openAiText);
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
            return jsonSuccessWithProgress(
              {
                result: openAiText,
                model: `${openAiModel} (openai-fallback)`,
                qualityWarnings: pedagogySplit.warnings,
                diagramAidRecommendation: diagramAid,
                crossVerified: false,
              },
              solverModelProfile,
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
              imageBase64: questionImage.base64,
              mimeType: questionImage.mimeType,
              diagramImageBase64: diagramInline?.base64,
              diagramMimeType: diagramInline?.mimeType,
              diagramImages: diagramImages.map((item) => ({
                imageBase64: item.imageBase64,
                mimeType: item.mimeType,
              })),
            });
            if (retryText) {
              const retryFormatCheck = validateExplanationFormat(retryText);
              const retryConsistencyEffective = mergeConsistencyIssues(retryText);
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
                return jsonSuccessWithProgress(
                  {
                    result: retryText,
                    model: `${openAiModel} (openai-fallback)`,
                    retriedForFormat: true,
                    qualityWarnings: retryPedagogySplit.warnings,
                    diagramAidRecommendation: diagramAid,
                    crossVerified: false,
                  },
                  solverModelProfile,
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
