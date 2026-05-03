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

  return { ok: issues.length === 0, issues };
}
