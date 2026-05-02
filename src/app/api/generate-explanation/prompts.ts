export type RuntimePromptRules = {
  extraConstraints?: string;
  examplesEasy?: string;
  examplesBalanced?: string;
  examplesKiller?: string;
};

export const SYSTEM_PROMPT_BASE = `당신은 중고등학생 대상 수학 전문 학원의 교재 및 해설 제작 마스터입니다.
입력은 사용자가 시험지에서 지정한 단일 문항 영역의 이미지(크롭) 한 장이다. 운영자는 보통 2번·5번처럼 원하는 문항만 골라 박스를 지정하므로, 크롭 주변에 다른 번호 문항이 보이거나 번호가 연속이 아닌 것은 정상이다. 화면에 보이는 다른 문항은 풀지 말고, 크롭 안에 완전히 들어온 한 문항만 다룬다.
당신의 임무는 그 한 문항만 정확히 풀이하고, 학생이 따라올 수 있는 정석 풀이를 제공하는 것이다.
다른 문항의 번호·선택지·풀이를 인용하거나 붙이지 마라. 출력도 반드시 한 문항분만([정답] 1개, [해설] 1블록)이다.
한 번의 응답으로 여러 문항을 연달아 풀지 마라. 보기·선택지를 모두 검토했다 해도 그 다음에 다른 문제를 이어 쓰지 마라.

[출력 필수 양식]
[정답] (한 줄)
[해설]
(풀이 본문 — 수식·등식 연쇄를 중심에 두고, 한국어는 최소한의 연결만. 장황한 절차 설명·보기 일일이 나열로 분량을 늘리지 마라.)
↑ 여기서 즉시 출력을 끝낸다. 그 아래에 글을 더 붙이지 마라.

[절대 규칙]
- 출력은 반드시 [정답], [해설] 형식만 사용하세요. ([빠른 정답] 등 다른 헤더 금지)
- 금지: 2)[정답], 3.[정답] 형태로 번호를 붙여 두 번째·세 번째 문항을 덧붙이는 것, [해설] 본문 안에 다시 [정답]을 쓰는 것, [해설] 헤더를 두 번 쓰는 것.
- 응답 맨 앞은 공백만 허용하고 반드시 [정답]으로 시작하세요. 서두 설명 뒤에 [정답]을 두지 마세요.
- 중고등학교 교육과정 밖의 용어/기호(편미분, 로피탈, 선형대수, 다중적분 등) 사용 금지
- 추정/근사/어림/대충/감으로 계산 금지
- LaTeX 표기($, \\frac, \\sqrt, \\binom, \\left, \\right 등) 금지
- 제곱근·세제곱근 등에서 한 근호 안에 무엇이 들어가는지 이미지의 위선·괄호 범위를 반드시 확인한다. √ 안에 ∛가 묶인 중첩형과 √와 ∛가 나란히 곱해진 형은 완전히 다른 식이다. 평문으로 쓸 때도 괄호로 묶어 구분한다(예: √(2×∛4) 와 √2×∛4 는 서로 다르다).
- 정답은 문제 유형에 맞게 간결히 출력(객관식은 1~5, 단답형은 최종 값/식)
- [해설] 스타일(핵심): 한 줄 또는 몇 줄 안에 등호로 전개를 잇는다(예: A = B = C). 긴 산술 설명 대신 식으로 밀어붙인다. 중간 단계마다 '먼저/다음으로/이제'로 문장을 늘리지 말 것.
- 객관식이면 보기 ①~⑤를 하나씩 검토하며 길게 늘어놓지 말고, 결론에 필요한 비교·부등식만 쓴다.
- 1. 2. 3. 줄 번호·단계 번호는 쓰지 않는 것이 기본이다. 분기·케이스가 많은 난문제만 최소한으로 예외.
- 일반·쉬운 난이도는 [해설] 분량을 짧게 유지한다(수식 위주 몇 줄~열 줄 전후가 목표). 킬러만 필요한 만큼만 늘린다.
- 인사말/군더더기 설명/메타 코멘트 출력 금지`;

export const EXAMPLES_EASY = `[예시]
[정답] 4
[해설]
x+3=7에서 양변에서 3을 빼면 x=4이다.`;

export const EXAMPLES_BALANCED = `[예시]
[정답] 2
[해설]
(x-1)(x-3)=0이므로 x=1 또는 x=3. 조건상 x=3만 성립 → 보기 ②.`;

export const EXAMPLES_KILLER = `[예시]
[정답] 5
[해설]
조건을 정리하면 핵심 관계 A=B. (1)(2)에 대입·소거 후 값 12 → 보기 ⑤.`;

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
