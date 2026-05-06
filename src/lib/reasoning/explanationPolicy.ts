import type { SolverProfile } from "@/lib/explanationProgressReport";

export function validateCurriculumScope(text: string) {
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

export function validatePedagogicalPolicy(
  text: string,
  solverModelProfile: SolverProfile = "balanced",
) {
  const issues: string[] = [];
  const answer = text.match(/\[정답\]\s*([^\n\r]*)/i)?.[1]?.trim() ?? "";
  const explanation = text.match(/\[해설\]\s*([\s\S]+)/i)?.[1]?.trim() ?? "";
  const combined = `${answer}\n${explanation}`.trim();
  const estimationPattern =
    /근삿?값|추정|근사|어림|대략|감으로|찍어서|적당히|approx(?:imately)?|≈|≒|약\s*\d/i;
  if (estimationPattern.test(combined)) {
    const exactAnswerLike =
      /[①②③④⑤]|\b\d+\s*\/\s*\d+\b|[=<>≤≥]|\\frac|\\sqrt|π|pi/i.test(answer) ||
      /따라서\s*정답|그러므로\s*정답|결론적으로/.test(explanation);
    if (exactAnswerLike) {
      issues.push(
        "근삿값/추정 관련 표현이 있으나 최종 결론은 정확값으로 보입니다. 해당 표현은 제거를 권장합니다.",
      );
    } else {
      issues.push("근삿값/추정 중심 풀이 표현이 감지되었습니다.");
    }
  }
  const methodCount = (explanation.match(/\[방법\s*\d+\]/g) ?? []).length;
  const lines = explanation.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numberedLines = lines.filter((line) => /^\d+\.\s/.test(line)).length;
  const stepHeavy =
    lines.length >= 3 && numberedLines >= 2 && numberedLines / lines.length >= 0.35;
  const maxChars =
    solverModelProfile === "killer" ? 5500 : solverModelProfile === "easy" ? 1800 : 2800;
  const maxLines =
    solverModelProfile === "killer" ? 26 : solverModelProfile === "easy" ? 12 : 16;
  if (methodCount <= 1) {
    const tooLongByChars = explanation.length > maxChars;
    const tooLongBySteps = stepHeavy && lines.length > maxLines;
    if (tooLongBySteps || (!stepHeavy && tooLongByChars)) {
      issues.push("단일 풀이 기준으로 해설이 과도하게 장문입니다. 핵심 수식 중심으로 압축해 주세요.");
    }
  }
  return { ok: issues.length === 0, issues };
}

export function splitPedagogyIssues(issues: string[]) {
  const critical = issues.filter((issue) => /근삿값\/추정 중심 풀이 표현/.test(issue));
  const warnings = issues.filter((issue) => !/근삿값\/추정 중심 풀이 표현/.test(issue));
  return { critical, warnings };
}

export function buildRetryInstruction(
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

export function inferDiagramAidNeed(questionText: string) {
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
    {
      label: "삼각·이차함수·그래프 필수 신호",
      regex: /(삼각함수|사인|코사인|탄젠트|\\sin|\\cos|\\tan|주기|위상|이차함수|꼭짓점|포물선의\s*그래프|함수\s*y\s*=)/,
      score: 3,
    },
    {
      label: "함수·수평(수직)선 교점·좌표",
      regex: /(교점|만나는\s*점|서로\s*만나|x좌표|y좌표|좌표의\s*합|y\s*=\s*[0-9]|수평선|직선\s*y)/,
      score: 3,
    },
    {
      label: "x범위·반개구간·해의 개수(그래프 맥락)",
      regex: /(\d\s*≤\s*x|x\s*≤\s*\d|x\s*<\s*\d|0\s*≤\s*x|몇\s*개의|서로\s*다른\s*실근)/,
      score: 2,
    },
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
