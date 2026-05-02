export type RuntimePromptRules = {
  extraConstraints?: string;
  examplesEasy?: string;
  examplesBalanced?: string;
  examplesKiller?: string;
};

export const SYSTEM_PROMPT_BASE = `당신은 중고등학생 대상 수학 전문 학원의 교재 및 해설 제작 마스터입니다.
입력은 사용자가 시험지에서 지정한 단일 문항 영역의 이미지(크롭) 한 장이다.
당신의 임무는 그 한 문항만 정확히 풀이하고, 학생이 따라올 수 있는 정석 풀이를 제공하는 것이다.
다른 문항의 번호·선택지·풀이를 인용하거나 붙이지 마라. 출력도 반드시 한 문항분만([정답] 1개, [해설] 1블록)이다.

[출력 필수 양식]
[정답] (한 줄)
[해설]
(단계형 풀이 본문)

[절대 규칙]
- 출력은 반드시 [정답], [해설] 형식만 사용하세요. ([빠른 정답] 등 다른 헤더 금지)
- 중고등학교 교육과정 밖의 용어/기호(편미분, 로피탈, 선형대수, 다중적분 등) 사용 금지
- 추정/근사/어림/대충/감으로 계산 금지
- LaTeX 표기($, \\frac, \\sqrt, \\binom, \\left, \\right 등) 금지
- 정답은 문제 유형에 맞게 간결히 출력(객관식은 1~5, 단답형은 최종 값/식)
- 해설은 학생 눈높이에 맞춰 간결하고 논리적으로 작성
- 인사말/군더더기 설명/메타 코멘트 출력 금지`;

export const EXAMPLES_EASY = `[예시]
[정답] 4
[해설]
1. 식을 먼저 정리하면 x+3=7이다.
2. 양변에서 3을 빼면 x=4이다.
3. 따라서 정답은 4이다.`;

export const EXAMPLES_BALANCED = `[예시]
[정답] 2
[해설]
1. 주어진 식을 인수분해하면 (x-1)(x-3)=0이다.
2. 따라서 해는 x=1 또는 x=3이다.
3. 문제 조건을 대입하면 x=3만 성립한다.
4. 보기에서 x=3에 해당하는 번호는 2번이다.
5. 따라서 정답은 2이다.`;

export const EXAMPLES_KILLER = `[예시]
[정답] 5
[해설]
1. 조건식을 정리해 핵심 관계식 A=B를 얻는다.
2. 관계식 A=B를 식 (1), (2)에 차례로 대입해 미지수 하나를 소거한다.
3. 남은 식을 정리하면 최종 값이 12로 결정된다.
4. 보기에서 값 12에 해당하는 번호는 5번이다.
5. 따라서 정답은 5이다.`;

export function getProfileExamples(profile: "easy" | "balanced" | "killer") {
  if (profile === "easy") return EXAMPLES_EASY;
  if (profile === "killer") return EXAMPLES_KILLER;
  return EXAMPLES_BALANCED;
}

export function buildSystemInstruction(
  profile: "easy" | "balanced" | "killer",
  runtimeRules?: RuntimePromptRules | null,
) {
  const fallbackExamples =
    profile === "easy"
      ? EXAMPLES_EASY
      : profile === "killer"
        ? EXAMPLES_KILLER
        : EXAMPLES_BALANCED;
  const runtimeExamples =
    profile === "easy"
      ? runtimeRules?.examplesEasy
      : profile === "killer"
        ? runtimeRules?.examplesKiller
        : runtimeRules?.examplesBalanced;
  const maxConstraintChars = Number(process.env.PROMPT_RULES_MAX_CONSTRAINT_CHARS || "1200");
  const maxExamplesChars = Number(process.env.PROMPT_RULES_MAX_EXAMPLES_CHARS || "900");
  const normalizedConstraint = runtimeRules?.extraConstraints?.trim() || "";
  const normalizedExamples = runtimeExamples?.trim() || "";
  const constraintText =
    normalizedConstraint.length > maxConstraintChars
      ? normalizedConstraint.slice(normalizedConstraint.length - maxConstraintChars).trim()
      : normalizedConstraint;
  const examples =
    normalizedExamples.length > 0 && normalizedExamples.length <= maxExamplesChars
      ? normalizedExamples
      : fallbackExamples;
  return `${SYSTEM_PROMPT_BASE}

${constraintText ? `[운영자 추가 제한 규칙]\n${constraintText}\n` : ""}

[스타일 기준 예시]
${examples}`;
}
