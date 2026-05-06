export type DraftItemForGate = {
  questionNo: number;
  answer: string;
  explanation: string;
};

export type ContentIssue = {
  questionNo: number;
  severity: "fatal" | "warn";
  code: string;
  message: string;
};

function normalizeChoiceToken(text: string): string {
  const t = text.trim();
  const circled = t.match(/[①②③④⑤]/)?.[0];
  if (circled) return circled;
  const num = t.match(/\b([1-5])\b/)?.[1];
  if (num) return ["", "①", "②", "③", "④", "⑤"][Number(num)] ?? t;
  return t;
}

function evaluateNumericExpression(raw: string): number | null {
  const expr = raw
    .replace(/[×x]/g, "*")
    .replace(/÷/g, "/")
    .replace(/\s+/g, "")
    .trim();
  if (!expr) return null;
  if (!/^[0-9+\-*/().]+$/.test(expr)) return null;
  try {
    const v = Function(`"use strict"; return (${expr});`)();
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

function checkArithmeticEqualities(questionNo: number, explanation: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const lines = explanation.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.replace(/\$/g, "").trim();
    if (!cleaned.includes("=")) continue;
    if ((cleaned.match(/=/g) ?? []).length !== 1) continue;
    if (/[A-Za-z가-힣\\_^]/.test(cleaned)) continue;
    const [lhsRaw, rhsRaw] = cleaned.split("=");
    if (!lhsRaw || !rhsRaw) continue;
    const lhs = evaluateNumericExpression(lhsRaw);
    const rhs = evaluateNumericExpression(rhsRaw);
    if (lhs == null || rhs == null) continue;
    if (Math.abs(lhs - rhs) > 1e-9) {
      issues.push({
        questionNo,
        severity: "fatal",
        code: "E_ARITH_MISMATCH",
        message: `산술 등식 불일치 감지: ${cleaned} (계산값 ${lhs} != ${rhs})`,
      });
    }
  }
  return issues;
}

function checkChainEqualities(questionNo: number, explanation: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const lines = explanation.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.replace(/\$/g, "").trim();
    const eqCount = (cleaned.match(/=/g) ?? []).length;
    if (eqCount < 2) continue;
    if (/[A-Za-z가-힣\\_^]/.test(cleaned)) continue;
    const parts = cleaned.split("=").map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    const values = parts.map((p) => evaluateNumericExpression(p));
    if (values.some((v) => v == null)) continue;
    for (let i = 1; i < values.length; i += 1) {
      const prev = values[i - 1]!;
      const cur = values[i]!;
      if (Math.abs(prev - cur) > 1e-9) {
        issues.push({
          questionNo,
          severity: "fatal",
          code: "E_CHAIN_EQ_MISMATCH",
          message: `체인 등식 불일치 감지: ${cleaned} (항 ${i}와 ${i + 1} 불일치)`,
        });
        break;
      }
    }
  }
  return issues;
}

function checkInequalityChains(questionNo: number, explanation: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const lines = explanation.split(/\r?\n/);
  const opRe = /(<=|>=|<|>)/g;
  for (const line of lines) {
    const cleaned = line.replace(/\$/g, "").trim();
    const ops = cleaned.match(opRe) ?? [];
    if (ops.length < 2) continue;
    if (/[A-Za-z가-힣\\_^]/.test(cleaned)) continue;

    const parts = cleaned.split(opRe).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 5 || parts.length % 2 === 0) continue;

    let failed = false;
    for (let i = 0; i + 2 < parts.length; i += 2) {
      const lhsExpr = parts[i]!;
      const op = parts[i + 1]!;
      const rhsExpr = parts[i + 2]!;
      const lhs = evaluateNumericExpression(lhsExpr);
      const rhs = evaluateNumericExpression(rhsExpr);
      if (lhs == null || rhs == null) {
        failed = false;
        break;
      }
      const ok =
        op === "<" ? lhs < rhs
        : op === "<=" ? lhs <= rhs
        : op === ">" ? lhs > rhs
        : op === ">=" ? lhs >= rhs
        : true;
      if (!ok) {
        issues.push({
          questionNo,
          severity: "fatal",
          code: "E_INEQ_CHAIN_MISMATCH",
          message: `부등식 체인 불일치 감지: ${cleaned} (비교 ${lhs} ${op} ${rhs} 실패)`,
        });
        failed = true;
        break;
      }
    }
    if (failed) continue;
  }
  return issues;
}

function checkMathShorthandSubstitution(questionNo: number, explanation: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const normalized = explanation.replace(/\s+/g, " ");
  const shorthandRe =
    /\b(?:s|c)\s*=\s*\\?(?:sin|cos)\b[\s\S]{0,120}?\b(?:s|c)\s*=\s*\\?(?:sin|cos)\b/i;
  if (shorthandRe.test(normalized)) {
    issues.push({
      questionNo,
      severity: "fatal",
      code: "E_MATH_SHORTHAND_SUBSTITUTION",
      message:
        "삼각함수/로그를 단일 문자로 치환한 축약 표기(예: s=sin..., c=cos...)가 감지되었습니다. 해설용 표기로 부적합합니다.",
    });
  }
  return issues;
}

function checkTrailingPeriodAfterMath(questionNo: number, explanation: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const lines = explanation.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/(\$[^$\n]+\$|\$\$[\s\S]*\$\$)\s*\.\s*$/.test(trimmed)) {
      issues.push({
        questionNo,
        severity: "fatal",
        code: "E_MATH_TRAILING_PERIOD",
        message: "수식 끝 마침표가 감지되었습니다. 수식 끝의 마침표는 제거해야 합니다.",
      });
      break;
    }
  }
  return issues;
}

function checkIffToken(questionNo: number, explanation: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  if (/\biff\b/i.test(explanation) || /\\iff\b/i.test(explanation)) {
    issues.push({
      questionNo,
      severity: "fatal",
      code: "E_IFF_TOKEN",
      message: "`iff` 표기가 감지되었습니다. `동치` 또는 `<=>` 형태로 명시적으로 정리해야 합니다.",
    });
  }
  return issues;
}

function checkCurriculumScopeViolation(questionNo: number, explanation: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const bannedConcepts: Array<{ code: string; re: RegExp; label: string }> = [
    { code: "E_CURRICULUM_OUT_OF_SCOPE", re: /\b(라플라스 변환|Laplace transform)\b/i, label: "라플라스 변환" },
    { code: "E_CURRICULUM_OUT_OF_SCOPE", re: /\b(푸리에 (급수|변환)|Fourier)\b/i, label: "푸리에 해석" },
    { code: "E_CURRICULUM_OUT_OF_SCOPE", re: /\b(테일러 급수|Taylor series|맥클로린|Maclaurin)\b/i, label: "테일러/맥클로린 급수" },
    { code: "E_CURRICULUM_OUT_OF_SCOPE", re: /\b(편미분|partial derivative)\b/i, label: "편미분" },
    { code: "E_CURRICULUM_OUT_OF_SCOPE", re: /\b(중적분|이중적분|삼중적분|double integral|triple integral)\b/i, label: "다중적분" },
    { code: "E_CURRICULUM_OUT_OF_SCOPE", re: /\b(선적분|면적분|경로적분)\b/i, label: "선적분/면적분" },
    { code: "E_CURRICULUM_OUT_OF_SCOPE", re: /\b(미분방정식|differential equation)\b/i, label: "미분방정식" },
    { code: "E_CURRICULUM_OUT_OF_SCOPE", re: /\b(고유값|고유벡터|eigenvalue|eigenvector)\b/i, label: "고유값/고유벡터" },
    { code: "E_CURRICULUM_OUT_OF_SCOPE", re: /\b(행렬식|determinant)\b/i, label: "행렬식" },
    { code: "E_CURRICULUM_OUT_OF_SCOPE", re: /\b(복소평면|복소해석|유수정리|Cauchy)\b/i, label: "복소해석" },
  ];
  for (const item of bannedConcepts) {
    if (item.re.test(explanation)) {
      issues.push({
        questionNo,
        severity: "fatal",
        code: item.code,
        message: `교육과정 범위를 벗어난 개념이 감지되었습니다: ${item.label}`,
      });
      break;
    }
  }
  return issues;
}

export function runContentGate(drafts: DraftItemForGate[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const banned = /(풀 수 없|알 수 없|판독 불가|모르겠|추정됩니다|화질)/i;
  const conclusionRe = /정답은?\s*([①②③④⑤1-5])/g;
  for (const d of drafts) {
    const exp = d.explanation.trim();
    if (exp.length < 40) {
      issues.push({
        questionNo: d.questionNo,
        severity: "fatal",
        code: "E_CONTENT_SHORT",
        message: "해설 길이가 너무 짧아 내용 검증이 불충분합니다.",
      });
    }
    if (banned.test(exp)) {
      issues.push({
        questionNo: d.questionNo,
        severity: "fatal",
        code: "E_CONTENT_BANNED_PHRASE",
        message: "포기/회피 문구가 감지되었습니다.",
      });
    }
    const answerNorm = normalizeChoiceToken(d.answer);
    let m: RegExpExecArray | null = null;
    const conclusionTokens: string[] = [];
    while ((m = conclusionRe.exec(exp)) !== null) {
      if (m[1]) conclusionTokens.push(normalizeChoiceToken(m[1]));
    }
    if (conclusionTokens.length > 0) {
      const last = conclusionTokens[conclusionTokens.length - 1]!;
      if (answerNorm && last && answerNorm !== last) {
        issues.push({
          questionNo: d.questionNo,
          severity: "fatal",
          code: "E_ANSWER_MISMATCH",
          message: `해설 결론(${last})과 빠른 정답(${answerNorm})이 불일치합니다.`,
        });
      }
    }
    issues.push(...checkArithmeticEqualities(d.questionNo, exp));
    issues.push(...checkChainEqualities(d.questionNo, exp));
    issues.push(...checkInequalityChains(d.questionNo, exp));
    issues.push(...checkMathShorthandSubstitution(d.questionNo, exp));
    issues.push(...checkTrailingPeriodAfterMath(d.questionNo, exp));
    issues.push(...checkIffToken(d.questionNo, exp));
    issues.push(...checkCurriculumScopeViolation(d.questionNo, exp));
  }
  return issues;
}
