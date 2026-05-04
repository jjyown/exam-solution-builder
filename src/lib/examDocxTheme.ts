import { LineRuleType } from "docx";

/**
 * HML(HWPML) 길이 단위 → Word twips(dxa).  
 * `PAGEDEF`/`PAGEMARGIN`/`PARAMARGIN`/`SECDEF SpaceColumns` 등과 동일 수식으로 맞춘다.  
 * 1 HWP 단위 = 1/7200 인치, 1인치 = 1440 twips ⇒ `twips = round(unit * 1440/7200)`.
 */
export function hmlLengthUnitToTwips(unit: number): number {
  return Math.round((unit * 1440) / 7200);
}

/**
 * 사용자 제공 `[TEST] TEST1.hml` `SECDEF`/`PAGEDEF`/`PAGEMARGIN` 과 동일한 용지·여백(B4 세로).
 * `SpaceColumns` → Word 2단 사이 간격(twips).
 */
export const EXAM_DOCX_HML_PAGE = {
  size: {
    width: hmlLengthUnitToTwips(72852),
    height: hmlLengthUnitToTwips(103180),
  },
  margin: {
    top: hmlLengthUnitToTwips(4251),
    right: hmlLengthUnitToTwips(5102),
    bottom: hmlLengthUnitToTwips(3685),
    left: hmlLengthUnitToTwips(5102),
    header: hmlLengthUnitToTwips(5669),
    footer: hmlLengthUnitToTwips(3685),
    gutter: 0,
  },
  /**
   * `SECDEF SpaceColumns` → Word `w:cols w:space`(단 사이 간격, twips).
   * 본문 `COLDEF SameGap="2268"` 과 수치가 다르다(약 2배). 레이아웃 기준은 Word열 간격에 맞춘 **SpaceColumns** 를 쓴다.
   */
  columnSpaceTwips: hmlLengthUnitToTwips(1134),
} as const;

/** 본문 영역(좌우 여백 제외) 너비(twips). 2단 시 한 칼럼은 아래 값의 약 절반. */
export const EXAM_DOCX_BODY_TEXT_WIDTH_TWIPS =
  EXAM_DOCX_HML_PAGE.size.width -
  EXAM_DOCX_HML_PAGE.margin.left -
  EXAM_DOCX_HML_PAGE.margin.right;

/** 2단일 때 한 칼럼에 들어갈 수 있는 너비(twips) — 보기 박스 테이블 `tblW`·`gridCol`에 사용해 눌림을 줄인다. */
export const EXAM_DOCX_SINGLE_COLUMN_WIDTH_TWIPS = Math.max(
  3600,
  Math.floor((EXAM_DOCX_BODY_TEXT_WIDTH_TWIPS - EXAM_DOCX_HML_PAGE.columnSpaceTwips) / 2),
);

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

/** 165% 줄간격 — `[TEST] TEST1.hml` `PARAMARGIN LineSpacing="165"` LineSpacingType="Percent" */
export const EXAM_DOCX_BODY_LINE_SPACING = {
  line: Math.round(240 * 1.65),
  lineRule: LineRuleType.AUTO,
} as const;

/** HML `PARAMARGIN` Prev="0" Next="0" 에 가깝게, 본문 단락 끝 추가 간격만 최소로 둔다. */
export const EXAM_DOCX_BODY_PARAGRAPH_SPACING = {
  ...EXAM_DOCX_BODY_LINE_SPACING,
  after: hmlLengthUnitToTwips(600),
} as const;

/** 문항 사이 위쪽 여백 — 약 `1100` HML 단위에 해당하는 twips(기존 220tw 유지) */
export const EXAM_DOCX_INTER_QUESTION_BEFORE_TWIPS = hmlLengthUnitToTwips(1100);

/**
 * HML `PARAMARGIN` Left/Right="1000"(본문·표지 일반 단락) → 단락 좌·우 안쪽 여백에 대응하는 twips.
 * 테이블 셀·들여쓰기에 재사용한다.
 */
export const EXAM_DOCX_HML_PARAMARGIN_LR_TWIPS = hmlLengthUnitToTwips(1000);

/**
 * 2단 본문 **해설** 단락: `firstLine`만 주면 **첫 줄만** 안쪽이고, 같은 단락의 둘째 줄부터는 칼럼 왼쪽에 붙어 들쭉날쭉해 보인다.
 * 좌·우 **블록 들여쓰기**로 줄 전체를 같은 시작선에 맞추고, 안쪽(중앙 분리선 쪽) 여유도 확보한다.
 */
export const EXAM_DOCX_EXPLANATION_PARAGRAPH_INDENT_TWIPS = {
  /** `[TEST] TEST1.hml` ParaShape 15 `PARAMARGIN Left="1000"` */
  left: EXAM_DOCX_HML_PARAMARGIN_LR_TWIPS,
  /** 동일 `PARAMARGIN Right="1000"` */
  right: EXAM_DOCX_HML_PARAMARGIN_LR_TWIPS,
} as const;

/** @deprecated `EXAM_DOCX_EXPLANATION_PARAGRAPH_INDENT_TWIPS.left` 와 동일. 예전 첫줄-only 들여쓰기 호환용 */
export const EXAM_DOCX_EXPLANATION_FIRST_LINE_INDENT_TWIPS = EXAM_DOCX_EXPLANATION_PARAGRAPH_INDENT_TWIPS.left;
