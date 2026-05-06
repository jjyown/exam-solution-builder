import type { ContentIssue, DraftItemForGate } from "./contentGate.ts";
import type { QuestionVisuals } from "../recognition/questionVisuals.ts";

export function runCompletenessGate(
  drafts: DraftItemForGate[],
  questionVisuals: QuestionVisuals,
): ContentIssue[] {
  const issues: ContentIssue[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i]!;
    if (!d.answer || d.answer.trim() === "-" || !d.answer.trim()) {
      issues.push({
        questionNo: d.questionNo,
        severity: "fatal",
        code: "E_COMPLETENESS_NO_ANSWER",
        message: "빠른 정답이 비어 있습니다.",
      });
    }
    if (!d.explanation || d.explanation.trim().length < 5) {
      issues.push({
        questionNo: d.questionNo,
        severity: "fatal",
        code: "E_COMPLETENESS_NO_EXPLANATION",
        message: "해설 본문이 비어 있습니다.",
      });
    }
    const fromManifest = questionVisuals.byQuestion.get(d.questionNo);
    const hasMainByManifest = Boolean(fromManifest?.main);
    if (questionVisuals.byQuestion.size > 0 && !hasMainByManifest) {
      issues.push({
        questionNo: d.questionNo,
        severity: "warn",
        code: "W_COMPLETENESS_NO_MAIN_IMAGE",
        message: "manifest 기준 문제 원본 이미지가 연결되지 않았습니다.",
      });
    }
  }
  return issues;
}
