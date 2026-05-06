import { normalizeChoice, sliceFromFirstAnswerHeader } from "@/lib/explanationAnswerValidators";

export function validateExplanationFormat(text: string) {
  const normalized = sliceFromFirstAnswerHeader(text).trim();
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

export function isLikelyTruncatedResult(text: string) {
  const explanation = text.match(/\[해설\]\s*([\s\S]*)/i)?.[1]?.trim() ?? "";
  if (explanation.length < 50) return true;
  if (/[,:+\-*/=]$/.test(explanation)) return true;
  const openParen = (explanation.match(/[({\[]/g) ?? []).length;
  const closeParen = (explanation.match(/[)}\]]/g) ?? []).length;
  return openParen > closeParen;
}

export function validateExplanationConsistency(text: string) {
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
export function validateCrossProblemBleed(text: string) {
  const issues: string[] = [];
  const explanation = text.match(/\[해설\]\s*([\s\S]+)/i)?.[1]?.trim() ?? "";
  if (!explanation) return { ok: true, issues };

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
