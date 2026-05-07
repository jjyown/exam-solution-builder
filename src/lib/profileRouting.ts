/**
 * profileRouting.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  문항 난이도(easy/balanced/killer)를 추정하고 그에 맞는 LLM 모델을 고른다.
 *  비용 최적화 — 쉬운 문제에 비싼 모델을 쓰지 않게.
 *
 *  매핑 (기본값, 환경변수로 오버라이드 가능):
 *    easy     → gemini-2.0-flash-lite  / gpt-4o-mini   (저렴·빠름)
 *    balanced → gemini-2.0-flash       / gpt-4o-mini   (보통)
 *    killer   → gemini-2.5-pro         / gpt-4o        (정확·고비용)
 *
 *  추정 규칙 (한국 수능·내신 패턴):
 *    - 객관식 1~7번 + 본문 짧음 → easy
 *    - 객관식 8~16번 → balanced
 *    - 17번 이상, 서술형, "이라 하자/조건을 만족/증명" 키워드, 긴 본문, 적분/시그마 → killer
 * ────────────────────────────────────────────────────────────────────────────
 */

export type Profile = "easy" | "balanced" | "killer";

const COMPLEX_KEYWORDS =
  /(?:이라\s*하자|조건을?\s*만족|풀이\s*과정|증명|구하는?\s*과정|서술하시오|\\sum|\\int|\\lim|\\frac|극한|급수|적분|미분|좌표평면\s*위의|일\s*때.*값을\s*구하시오)/;

const CHOICE_MARKER = /[①②③④⑤⑥⑦⑧⑨⑩]/;

export type DifficultyInference = {
  profile: Profile;
  reason: string;
};

/** 문항 번호 + 본문에서 난이도 추정 */
export function inferDifficulty(
  questionNo: string,
  questionText: string,
): DifficultyInference {
  const n = parseInt(questionNo.replace(/[^\d]/g, ""), 10);
  const len = questionText.length;
  const hasChoices = CHOICE_MARKER.test(questionText);
  const hasComplex = COMPLEX_KEYWORDS.test(questionText);
  const longBody = len >= 350;
  const veryLong = len >= 600;

  // 1) 시험지 후반부 (17번 이상) → 사실상 모두 killer
  if (Number.isFinite(n) && n >= 17) {
    return { profile: "killer", reason: `문항 번호 ${n}번 (후반부 킬러·서술형 영역)` };
  }
  // 2) 길고 복잡 → killer
  if (veryLong || (longBody && hasComplex)) {
    return {
      profile: "killer",
      reason: `긴 본문(${len}자)${hasComplex ? " + 복합 키워드" : ""}`,
    };
  }
  // 3) 1~7번 + 보기 + 짧음 → easy
  if (Number.isFinite(n) && n >= 1 && n <= 7 && hasChoices && len < 220) {
    return { profile: "easy", reason: `1~7번 객관식 단답·짧은 본문(${len}자)` };
  }
  // 4) 짧은 객관식 (번호 모를 때)
  if (hasChoices && len < 150) {
    return { profile: "easy", reason: `짧은 객관식(${len}자)` };
  }
  // 5) 복합 키워드 있으면 한 단계 위로
  if (hasComplex) {
    return { profile: "killer", reason: `복합 키워드 (${len}자)` };
  }
  // 기본
  return {
    profile: "balanced",
    reason: `중간 난이도 (${n ? `${n}번` : "?"}, ${len}자${hasChoices ? ", 객관식" : ""})`,
  };
}

/** 환경변수 우선, 없으면 기본값으로 Gemini 모델 선택 */
export function geminiModelFor(profile: Profile): string {
  const env = process.env;
  if (profile === "killer") {
    return (
      env.GEMINI_MODEL_KILLER?.trim() ||
      pickFirstFromList(env.GEMINI_MODELS_GENERATE_KILLER) ||
      env.GEMINI_MODEL?.trim() ||
      "gemini-2.5-pro"
    );
  }
  if (profile === "easy") {
    return (
      env.GEMINI_MODEL_EASY?.trim() ||
      pickFirstFromList(env.GEMINI_MODELS_GENERATE_EASY) ||
      "gemini-2.0-flash-lite"
    );
  }
  return (
    env.GEMINI_MODEL_BALANCED?.trim() ||
    pickFirstFromList(env.GEMINI_MODELS_GENERATE_BALANCED) ||
    env.GEMINI_MODEL?.trim() ||
    "gemini-2.0-flash"
  );
}

/** 환경변수 우선, 없으면 기본값으로 OpenAI 모델 선택 */
export function openaiModelFor(profile: Profile): string {
  const env = process.env;
  if (profile === "killer") {
    return (
      env.OPENAI_MODEL_KILLER?.trim() ||
      env.OPENAI_MODEL_CROSS_VERIFY_KILLER?.trim() ||
      env.OPENAI_MODEL?.trim() ||
      "gpt-4o"
    );
  }
  if (profile === "easy") {
    return (
      env.OPENAI_MODEL_EASY?.trim() ||
      env.OPENAI_MODEL_CROSS_VERIFY_EASY?.trim() ||
      env.OPENAI_MODEL_GENERATE_FALLBACK?.trim() ||
      "gpt-4o-mini"
    );
  }
  return (
    env.OPENAI_MODEL_BALANCED?.trim() ||
    env.OPENAI_MODEL_CROSS_VERIFY_BALANCED?.trim() ||
    env.OPENAI_MODEL?.trim() ||
    "gpt-4o-mini"
  );
}

function pickFirstFromList(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const first = s.split(",")[0]?.trim();
  return first || undefined;
}

/**
 * 단순 비용 추정 — prompt 글자수 + 응답 추정으로 대략 cents 단위.
 * 진짜 토큰 수가 아니라 모델·서비스별 절대 비교를 위한 휴리스틱.
 */
const APPROX_COST_CENTS_PER_KCHAR: Record<string, number> = {
  // 1k char ≈ 250 token (한글 비율 고려), 1M token 가격을 cents 기준으로 환산
  "gemini-2.0-flash-lite": 0.0125, // ~$0.05/M tokens 입력 + ~$0.20/M 출력 → 평균 0.0125 c/kchar
  "gemini-2.0-flash": 0.025,
  "gemini-2.5-flash": 0.025,
  "gemini-2.5-pro": 0.18,
  "gpt-4o-mini": 0.025,
  "gpt-4o": 0.4,
};

export function approxCostCents(model: string, promptChars: number): number {
  const rate = APPROX_COST_CENTS_PER_KCHAR[model] ?? 0.05;
  // 응답이 prompt의 ~70% 길이라고 가정
  return ((promptChars * 1.7) / 1000) * rate;
}
