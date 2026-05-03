import { LineRuleType } from "docx";

/**
 * 시험지 HML `FACENAMELIST`와 동일한 기본 글꼴 (예: `[TEST] TEST1.hml` → FONT Id=0 **한양신명조**).
 * CharShape Id=0 Height≈1150(HWP 단위 → 약 11.5pt), ParaShape 줄간격 165%는 아래 상수와 대응.
 * OMML 수식 기호는 Word가 보통 Cambria Math로 그리므로, 한글 본문·라틴 문자만 여기서 통일한다.
 */
export const EXAM_DOCX_FACE_PRIMARY = "한양신명조";

/** OOXML `w:rFonts`: ascii/hAnsi/cs/eastAsia + hint로 한글 문서에서 글꼴 치환을 줄인다. */
export const EXAM_DOCX_FONT = {
  ascii: EXAM_DOCX_FACE_PRIMARY,
  eastAsia: EXAM_DOCX_FACE_PRIMARY,
  hAnsi: EXAM_DOCX_FACE_PRIMARY,
  cs: EXAM_DOCX_FACE_PRIMARY,
  hint: "eastAsia",
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
