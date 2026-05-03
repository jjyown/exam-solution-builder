import { LineRuleType } from "docx";

/**
 * 수학비서 HML 참고: `Downloads/[TEST] TEST 2.hml`
 * - 본문: CharShape Id=0, Height=1150(HWP 단위 → 약 11.5pt), Face Hangul Id=0 → **한양신명조**
 * - 단락: ParaShape Id=1, LineSpacing=165%, LineSpacingType=Percent
 * 문제 안 그림은 크롭 이미지로 별도 처리(본 DOCX는 텍스트·수식 위주).
 */
export const EXAM_DOCX_FONT = {
  ascii: "한양신명조",
  eastAsia: "한양신명조",
  hAnsi: "한양신명조",
} as const;

/** half-points (docx `size`): 11.5pt */
export const EXAM_DOCX_BODY_SIZE_HALF_PT = 23;

/** 표지 중간 제목 근사: HML CharShape Id=2 Height=1500 → 15pt */
export const EXAM_DOCX_SECTION_TITLE_HALF_PT = 30;

/** 165% 줄간격 (Word `w:lineRule=auto` 시 배수 = line/240) */
export const EXAM_DOCX_BODY_LINE_SPACING = {
  line: Math.round(240 * 1.65),
  lineRule: LineRuleType.AUTO,
} as const;

export const EXAM_DOCX_BODY_PARAGRAPH_SPACING = {
  ...EXAM_DOCX_BODY_LINE_SPACING,
  /** 단락 후 간격(twips) */
  after: 120,
} as const;
