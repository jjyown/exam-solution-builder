import type { DraftItemForGate } from "../quality/contentGate.ts";
import type { QuestionVisuals } from "../recognition/questionVisuals.ts";

export type ExplanationImageDecision = {
  questionNo: number;
  needExtraExplanationImage: boolean;
  reason: string;
  placement: "inline_with_problem_images" | "after_explanation";
};

/**
 * 해설용 추가 이미지(그래프/보조도형)가 필요한지 결정하는 정책 함수.
 * 현재 단계에서는 "문항에 fig가 있는 경우 문제 이미지와 함께 배치"를 기본으로 한다.
 * 실제 신규 이미지 생성(그리기)은 다음 단계에서 이 결정값을 입력으로 사용한다.
 */
export function decideExplanationImagePolicy(
  drafts: DraftItemForGate[],
  questionVisuals: QuestionVisuals,
): ExplanationImageDecision[] {
  return drafts.map((d) => {
    const fromManifest = questionVisuals.byQuestion.get(d.questionNo);
    const hasDiagram = (fromManifest?.diagrams?.length ?? 0) > 0;
    if (hasDiagram) {
      return {
        questionNo: d.questionNo,
        needExtraExplanationImage: true,
        reason: "문항에 연결된 fig(그래프/도형)가 있어 시각 정보 유지가 필요합니다.",
        placement: "inline_with_problem_images",
      };
    }
    return {
      questionNo: d.questionNo,
      needExtraExplanationImage: false,
      reason: "텍스트/수식만으로 해설 가능하여 추가 이미지 생성은 생략합니다.",
      placement: "after_explanation",
    };
  });
}
