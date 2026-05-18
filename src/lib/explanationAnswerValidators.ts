/** generate-explanation · progressReport 에서 공유하는 답안 형식 검사 */

/** 선택 `[문제]` 블록이 앞에 있으면 `[정답]`부터 검증한다. */
export function sliceFromFirstAnswerHeader(text: string): string {
  const t = text.trim();
  const idx = t.search(/\[정답\]/i);
  if (idx < 0) return t;
  return t.slice(idx).trim();
}

export function normalizeChoice(value: string) {
  return value
    .trim()
    .replace("①", "1")
    .replace("②", "2")
    .replace("③", "3")
    .replace("④", "4")
    .replace("⑤", "5");
}

/**
 * 객관식 문항인데 [정답]에 계산값만 적거나, [정답]과 해설 결론의 보기 번호가 어긋나는 패턴을 잡는다.
 */
export function validateObjectiveMcAnswer(text: string) {
  const issues: string[] = [];
  const normalized = sliceFromFirstAnswerHeader(text).trim();
  const answerRaw = normalized.match(/\[정답\]\s*([^\n\r]*)/i)?.[1]?.trim() ?? "";
  const explanation = normalized.match(/\[해설\]\s*([\s\S]+)/i)?.[1] ?? "";
  if (!answerRaw || !explanation.trim()) return { ok: true, issues };

  const ansNorm = normalizeChoice(answerRaw);
  const ansIsMcSlot = /^[1-5]$/.test(ansNorm) || /^[①②③④⑤]$/.test(answerRaw.trim());

  const closureWithCircled = explanation.match(
    /(?:따라서|그러므로|정답(?:은|이|으로))\s*[①②③④⑤]/,
  );
  const closureWithDigit = explanation.match(
    /(?:따라서|그러므로|정답(?:은|이))\s*(?:보기\s*)?([1-5])(?:\s*번)?(?:\.|,|$|\s)/,
  );
  let conclusionChoice: string | undefined;
  if (closureWithCircled) {
    const ch = closureWithCircled[0].match(/[①②③④⑤]/);
    if (ch) conclusionChoice = normalizeChoice(ch[0]);
  } else if (closureWithDigit?.[1]) {
    conclusionChoice = closureWithDigit[1];
  }

  if (
    conclusionChoice &&
    /^[1-5]$/.test(conclusionChoice) &&
    /^[1-5]$/.test(ansNorm) &&
    conclusionChoice !== ansNorm
  ) {
    issues.push(
      `[정답]의 보기 번호(${answerRaw})와 [해설] 결론 문장의 번호가 서로 다릅니다. 한 가지로 통일하세요.`,
    );
  }

  const head = explanation.slice(0, Math.min(explanation.length, 1200));
  const mentionsExamChoices =
    /(?:보기|선택지|객관식)/.test(head) ||
    /[①②③④⑤].{0,200}[①②③④⑤]/.test(explanation.slice(0, 900));

  const digitsOnly = answerRaw.replace(/\s/g, "");
  const ansLooksComputed =
    Boolean(answerRaw.match(/\d/) && !ansIsMcSlot) &&
    (/\//.test(answerRaw) ||
      (/^[\d]+$/.test(digitsOnly) && Number(digitsOnly) > 5) ||
      /\\frac|\\sqrt|\\pi|\^\{/.test(answerRaw));

  if (mentionsExamChoices && ansLooksComputed) {
    issues.push(
      "[정답]에 계산 결과만 적혀 있습니다. 보기 ①~⑤가 보이면 [정답]에는 보기 번호 1~5 한 자리만 적고, 계산은 [해설]에만 쓰세요.",
    );
  }

  // PR-1 Commit 4 보강 (solution-writer 권고):
  // 객관식인데 [해설] 결론에 보기 번호가 아예 없는 경우 silently OK 회귀 차단.
  // 본 자동 검증은 사후 표시용 — 4배지 UI (Commit 5.7) 가 의뢰인에게 통지.
  if (
    mentionsExamChoices &&
    ansIsMcSlot &&
    !closureWithCircled &&
    !closureWithDigit
  ) {
    issues.push(
      "[해설] 결론 문장에 보기 번호 ①~⑤(또는 1~5번) 가 없습니다. 객관식이면 '따라서 ③' 같이 명시하세요.",
    );
  }

  return { ok: issues.length === 0, issues };
}

/**
 * PR-1 Commit 4 자동 검증 5종 — LLM 호출 X (정규식·구조만, 비용 0).
 *
 * 검토창 권고:
 *   1. OMML 변환 fallback 발생률 (황 30% / 적 50%) — 호출처가 발생 카운트 전달
 *   2. LaTeX 잔존 정규식 (`\frac`, `\sqrt`, `\sum`, `^{`, `_{` 등)
 *   3. OMML 트리 sanity (분수 num/den 빈, sup base 누락) — 호출처 후처리 검증
 *   4. 객관식 정답·결론 일치 (validateObjectiveMcAnswer 활용)
 *   5. equation 필드 길이 150자 sanity (단계 비대 회귀 차단)
 *
 * 본 함수는 검증 결과만 반환. UI 통지 (4배지) 는 Commit 5.7 에서.
 *
 * @param explanationText [정답]/[해설] 마커 포함된 전체 해설 텍스트
 * @param stepEquations explanation_steps[].equation 배열 (sanity 길이 검사)
 * @param ommlFallbackStats 호출처에서 측정한 OMML 변환 fallback 통계
 *   (없으면 OMML 모드 아닌 것으로 간주, 검증 1 skip)
 */
export type ValidationSeverity = "ok" | "warn" | "error";
export type ValidationResult = {
  severity: ValidationSeverity;
  issues: string[];
};

export type OmmlFallbackStats = {
  /** 변환 시도 횟수 (LaTeX equation 라인 수) */
  attempts: number;
  /** 변환 실패 후 평문 fallback 발생 횟수 */
  fallbacks: number;
};

export function validateExplanationConsistency(
  explanationText: string,
  stepEquations: readonly string[] = [],
  ommlFallbackStats?: OmmlFallbackStats,
): ValidationResult {
  const issues: string[] = [];
  let severity: ValidationSeverity = "ok";
  const escalate = (level: ValidationSeverity) => {
    if (level === "error") severity = "error";
    else if (level === "warn" && severity === "ok") severity = "warn";
  };

  // 1. OMML 변환 fallback 발생률
  if (ommlFallbackStats && ommlFallbackStats.attempts > 0) {
    const rate = ommlFallbackStats.fallbacks / ommlFallbackStats.attempts;
    if (rate >= 0.5) {
      issues.push(
        `OMML 변환 실패율 ${Math.round(rate * 100)}% — 절반 이상의 수식이 평문 fallback 으로 떨어졌습니다. 변환기 토큰 보강 필요.`,
      );
      escalate("error");
    } else if (rate >= 0.3) {
      issues.push(
        `OMML 변환 실패율 ${Math.round(rate * 100)}% — 30% 이상이 평문 fallback. 변환기 토큰 추가 검토.`,
      );
      escalate("warn");
    }
  }

  // 2. LaTeX 잔존 정규식 (LLM 룰 위반 — 텍스트 안에 raw LaTeX 명령 박힘)
  const latexLeftoverPatterns = [
    /\\frac\b/,
    /\\sqrt\b/,
    /\\sum\b/,
    /\\int\b/,
    /\\(?:alpha|beta|gamma|delta|pi|theta|sigma|lambda|omega)\b/,
    /[\^_]\{[^}]+\}/,
  ];
  // $$..$$ / $..$ 토큰 안은 정상 — 토큰 밖에서만 잔존 검사
  const explanationOutsideTokens = explanationText
    .replace(/\$\$[\s\S]+?\$\$/g, "")
    .replace(/\$[^$\n]+\$/g, "");
  for (const pat of latexLeftoverPatterns) {
    if (pat.test(explanationOutsideTokens)) {
      issues.push(
        "[해설] 본문에 raw LaTeX 명령(\\frac/\\sqrt/^{}/_{} 등) 이 남아있습니다. LLM 이 룰을 위반했거나 토큰 감싸기 누락.",
      );
      escalate("warn");
      break;
    }
  }

  // 3. OMML 트리 sanity — 호출처가 변환 후 결과 검증
  //    (본 함수는 호출처에서 받은 OmmlFallbackStats 의 attempts 0 면 OMML 모드 아닌 것)
  //    트리 자체 검증은 호출처 책임 (변환 결과 직접 들고 있어야 함)

  // 4. 객관식 정답·결론 일치 — validateObjectiveMcAnswer 호출
  const mcResult = validateObjectiveMcAnswer(explanationText);
  if (!mcResult.ok) {
    issues.push(...mcResult.issues);
    escalate("warn");
  }

  // 5. equation 필드 길이 sanity (단계 비대 회귀)
  const longEquations = stepEquations.filter((eq) => eq.length > 150);
  if (longEquations.length > 0) {
    issues.push(
      `[해설] equation 필드 ${longEquations.length}개가 150자를 초과 — 단계 비대 회귀 가능 (한 줄 한 변형 룰).`,
    );
    escalate("warn");
  }

  return { severity, issues };
}
