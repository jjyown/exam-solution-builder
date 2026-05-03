/**
 * DOCX 내보내기 전 클라이언트·repair API 공통 품질 규칙.
 * page.tsx / repair-explanations 가 동일 기준을 쓰도록 단일화한다.
 */

import { explanationLatexToPlain, quickAnswerToPlainLine } from "./latexToPlainText";

export type ExportDocEntry = {
  questionNo: string;
  quickAnswer: string;
  body: string;
};

export const DEFAULT_EXPLANATION_BODY = `해설 생성 버튼을 누르면 이 영역에 결과가 표시됩니다.

[해설]
문제의 핵심 개념과 단계별 풀이를 학생 눈높이에 맞게 작성합니다.`;

const PLACEHOLDER_TRIM = DEFAULT_EXPLANATION_BODY.trim();

export function isPlaceholderExplanationBody(body: string) {
  const t = body.trim();
  if (!t) return true;
  return t === PLACEHOLDER_TRIM;
}

export const EXPORT_LATEX_PATTERN =
  /\$\$?[^$]*\$?\$?|\\(frac|sqrt|binom|left|right|cdot|times|div|pi|sin|cos|tan|log|ln|alpha|beta|gamma|theta)\b|\\[()[\]{}]/i;

export const EXPORT_ESTIMATION_PATTERN =
  /추정|근사|어림|대략|감으로|찍어서|적당히|approx|approximately|대충/i;

const IMAGE_ABSENT_PATTERN = /이미지가\s*제공되지\s*않/i;

/** 본문에 타 문항으로 확장하는 패턴(생성 혼입·붙여넣기 오염 완화) */
const EXPORT_MULTI_PROBLEM_PHRASE = /(?:^|\n)\s*(?:다음|이어서|또\s*다른)\s*문제/m;

const MIN_EXPLANATION_BODY_LENGTH = 35;

/** KaTeX/LaTeX 구간을 평문(√, 분수 등)으로 바꾼 뒤 불필요 공백 정리 */
export function sanitizeExportPlainText(value: string): string {
  return explanationLatexToPlain(value);
}

/** 빠른정답 필드: 한 줄·길이 상한( DOCX TextRun / 검수 게이트와 동일 취지) */
export function sanitizeExportQuickAnswer(value: string): string {
  return quickAnswerToPlainLine(value, 200);
}

/** 클라이언트 내보내기 직전에 결정적으로 적용 가능한 최소 패치 */
export function applyDeterministicExportPatches(entries: ExportDocEntry[]): ExportDocEntry[] {
  return entries.map((entry) => {
    let body = entry.body;
    body = body.replace(IMAGE_ABSENT_PATTERN, "");
    body = body.replace(/\s*\.\s*\.\s*\.\s*$/g, "").trim();
    return {
      questionNo: entry.questionNo,
      quickAnswer: sanitizeExportQuickAnswer(entry.quickAnswer),
      body: sanitizeExportPlainText(body),
    };
  });
}

export function validateExportDocEntries(entries: ExportDocEntry[]): { ok: boolean; issues: string[] } {
  const issues: string[] = [];

  entries.forEach((entry) => {
    const quick = entry.quickAnswer.trim();
    const body = entry.body.trim();
    if (!quick || quick === "-") {
      issues.push(`${entry.questionNo}번: [정답] 값이 비어 있습니다.`);
    }
    if (isPlaceholderExplanationBody(body)) {
      issues.push(`${entry.questionNo}번: [해설] 본문이 비어 있거나 기본 템플릿 상태입니다.`);
    }
    if (body.length < MIN_EXPLANATION_BODY_LENGTH) {
      issues.push(`${entry.questionNo}번: [해설] 분량이 너무 짧습니다.`);
    }
    if (EXPORT_LATEX_PATTERN.test(`${quick}\n${body}`)) {
      issues.push(`${entry.questionNo}번: LaTeX 표기(\\frac, $, \\sqrt 등)가 남아 있습니다.`);
    }
    if (EXPORT_ESTIMATION_PATTERN.test(body)) {
      issues.push(`${entry.questionNo}번: 추정/근사 중심 풀이가 감지되었습니다.`);
    }
    if (IMAGE_ABSENT_PATTERN.test(body)) {
      issues.push(`${entry.questionNo}번: 이미지 부재 문구가 포함되어 있습니다.`);
    }
    if (/\[정답\]/i.test(body)) {
      issues.push(
        `${entry.questionNo}번: 해설 본문에 [정답] 헤더가 포함되어 있습니다. 빠른정답 필드와 본문을 분리하세요.`,
      );
    }
    if (EXPORT_MULTI_PROBLEM_PHRASE.test(body)) {
      issues.push(`${entry.questionNo}번: 다른 문항으로 이어지는 표현이 감지되었습니다.`);
    }
  });

  return { ok: issues.length === 0, issues };
}

/** 자동 보정 결과에 대한 비차단 경고(장문 등) */
export function getExportRepairWarnings(entry: ExportDocEntry): string[] {
  const warnings: string[] = [];
  const methodCount = (entry.body.match(/\[방법\s*\d+\]/g) ?? []).length;
  const lines = entry.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const numbered = lines.filter((l) => /^\d+\.\s/.test(l)).length;
  const stepHeavy =
    lines.length >= 3 && numbered >= 2 && numbered / lines.length >= 0.35;
  if (
    methodCount <= 1 &&
    (!stepHeavy ? entry.body.length > 3000 : lines.length > 18)
  ) {
    warnings.push("과도한 장문");
  }
  return warnings;
}
