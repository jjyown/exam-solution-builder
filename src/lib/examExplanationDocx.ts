import path from "node:path";
import {
  Document,
  ImageRun,
  Packer,
  Paragraph,
  ParagraphChild,
  TextRun,
  AlignmentType,
  SectionType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  TableLayoutType,
} from "docx";
import { explanationLineToParagraphChildren } from "@/lib/docxOmmlBuilder";
import {
  imageRunFromBuffer,
  isDocxOmittedTypingReferenceCropMarkdownLine,
  parseMarkdownImageLine,
  readImageRelativeToBase,
} from "@/lib/docxMarkdownImage";
import {
  EXAM_DOCX_BODY_PARAGRAPH_SPACING,
  EXAM_DOCX_BODY_SIZE_HALF_PT,
  EXAM_DOCX_EXPLANATION_PARAGRAPH_INDENT_TWIPS,
  EXAM_DOCX_FONT,
  EXAM_DOCX_HML_PAGE,
  EXAM_DOCX_INTER_QUESTION_BEFORE_TWIPS,
  EXAM_DOCX_SECTION_TITLE_HALF_PT,
  EXAM_DOCX_SINGLE_COLUMN_WIDTH_TWIPS,
} from "@/lib/examDocxTheme";
import { explanationLatexToPlain, quickAnswerToPlainLine } from "@/lib/latexToPlainText";
import { normalizeLatexSourceText } from "@/lib/latexSourceNormalize";
import { splitLabeledQuestionChunks } from "@/lib/explanationBlocks";

function bodyTextRun(opts: { text: string; bold?: boolean; size?: number }) {
  return new TextRun({
    text: opts.text,
    bold: opts.bold,
    size: opts.size ?? EXAM_DOCX_BODY_SIZE_HALF_PT,
    font: EXAM_DOCX_FONT,
  });
}

export function safeExamFileName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

type ExplanationBlock = {
  questionLabel: string;
  /** 선택 `[문제]` 블록(읽은 식·조건). DOCX에서 OMML 수식으로 출력 */
  problemLinesRaw: string[];
  answer: string;
  explanationLines: string[];
  explanationLinesRaw: string[];
};

/** 마크다운 이미지 줄(문제 원본·도형) */
const MD_IMAGE_LINE = /^\s*!\[[^\]]*]\([^)]+\)\s*$/;

/** DOCX에서 ㄱㄴㄷ·①~⑤ 보기 묶음을 테두리 박스로 넣기 위한 마커 */
const OPEN_BOGI = /^\s*<보기>\s*$/i;
const CLOSE_BOGI = /^\s*<\/보기>\s*$/i;

const EXAM_DOCX_CHOICES_BOX_BORDER = {
  style: BorderStyle.SINGLE,
  size: 4,
  color: "666666",
} as const;

/** 문항 블록을 한 덩어리로 묶어 페이지 경계에서 잘리지 않게 한다(HML과 동일하게 통째로 다음 페이지). */
const EXAM_DOCX_QUESTION_WRAPPER_BORDERS = {
  top: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
  left: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
  insideHorizontal: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
  insideVertical: { style: BorderStyle.NIL, size: 0, color: "FFFFFF" },
} as const;

function wrapQuestionBlockInCantSplitTable(children: (Paragraph | Table)[]): Table {
  const colW = EXAM_DOCX_SINGLE_COLUMN_WIDTH_TWIPS;
  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: colW, type: WidthType.DXA },
    columnWidths: [colW],
    borders: EXAM_DOCX_QUESTION_WRAPPER_BORDERS,
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: colW, type: WidthType.DXA },
            children,
          }),
        ],
      }),
    ],
  });
}

type ProblemLineSegment = { type: "line"; line: string } | { type: "choices"; lines: string[] };

/** `<보기>`~`</보기>`(또는 빈 줄·닫는 태그 생략 시 연속 보기 줄)을 한 덩어리로 분리한다. */
function segmentProblemLinesForChoicesBox(rawLines: string[]): ProblemLineSegment[] {
  const out: ProblemLineSegment[] = [];
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i]!;
    if (OPEN_BOGI.test(line)) {
      i += 1;
      const bucket: string[] = [];
      while (i < rawLines.length) {
        const L = rawLines[i]!;
        if (CLOSE_BOGI.test(L)) {
          i += 1;
          break;
        }
        if (L.trim() === "") {
          if (bucket.length > 0) break;
          i += 1;
          continue;
        }
        bucket.push(L);
        i += 1;
      }
      if (bucket.length > 0) out.push({ type: "choices", lines: bucket });
      continue;
    }
    out.push({ type: "line", line });
    i += 1;
  }
  return out;
}

/** `[문제]…[빠른 정답]/[정답]` 선행이 있으면 분리한다. `[문항 n]` 직후 `![](...)` 줄은 문제 블록 앞에 붙인다. */
function extractLeadingProblemBlock(chunk: string): { problemLinesRaw: string[]; rest: string } {
  const raw = chunk.trim();
  const lines = raw.split("\n");
  let i = 0;
  const leadingImages: string[] = [];
  while (i < lines.length && MD_IMAGE_LINE.test(lines[i] ?? "")) {
    leadingImages.push((lines[i] ?? "").trim());
    i += 1;
  }
  const t = lines.slice(i).join("\n").trim();
  const m = t.match(
    /^\[문제(?:\s+\d+)?\]\s*([\s\S]*?)(?=\n\s*(?:\[빠른\s*정답\]|\[정답\])|(?:\[빠른\s*정답\]|\[정답\]))/i,
  );
  if (m) {
    const problemLinesRaw = [
      ...leadingImages,
      ...m[1]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ];
    const rest = t.slice((m.index ?? 0) + m[0].length).trim();
    return { problemLinesRaw, rest };
  }

  const splitAtAnswer = t.split(/(?=\n\s*(?:\[빠른\s*정답\]|\[정답\]))/i);
  if (splitAtAnswer.length >= 2) {
    const problemBody = splitAtAnswer[0]?.trim() ?? "";
    const rest = splitAtAnswer.slice(1).join("").trim();
    const problemLines = problemBody
      ? problemBody.split("\n").map((line) => line.trim()).filter(Boolean)
      : [];
    return { problemLinesRaw: [...leadingImages, ...problemLines], rest };
  }
  if (/^(?:\[빠른\s*정답\]|\[정답\])/i.test(t)) {
    return { problemLinesRaw: leadingImages, rest: t };
  }
  return { problemLinesRaw: [...leadingImages, ...t.split("\n").map((l) => l.trim()).filter(Boolean)], rest: "" };
}

type QuickAnswerKind = "objective" | "short" | "essay";

function parseExplanationBlocks(explanationBody: string, fallbackQuickAnswer: string) {
  const raw = normalizeLatexSourceText(explanationBody).replace(/\r\n/g, "\n");
  const hasLabeledQuestions = /\[문항\s*\d+\]/.test(raw);

  const blocks: ExplanationBlock[] = [];

  if (hasLabeledQuestions) {
    const labeled = splitLabeledQuestionChunks(raw);
    labeled.forEach((item) => {
      const { label, chunk } = item;
      const { problemLinesRaw, rest: chunkRest } = extractLeadingProblemBlock(chunk);
      const answerMatch = chunkRest.match(/\[(?:빠른\s*정답|정답)\]\s*([^\n\r]*)/i);
      const answerLineMatch = chunkRest.match(/\[(?:빠른\s*정답|정답)\]\s*\n\s*([^\n\r]+)/i);
      const answer =
        answerLineMatch?.[1]?.trim() || answerMatch?.[1]?.trim() || fallbackQuickAnswer || "-";
      const explMatch = chunkRest.match(/\[해설\]\s*([\s\S]*)/i);
      const explanationLinesRaw = explMatch
        ? explMatch[1]
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
      const explanationLines = explanationLinesRaw.map((line) => explanationLatexToPlain(line));
      blocks.push({
        questionLabel: label,
        problemLinesRaw,
        answer,
        explanationLines,
        explanationLinesRaw,
      });
    });
    if (blocks.length > 0) return blocks;
  }

  const { problemLinesRaw: leadingProblem, rest: rawRest } = extractLeadingProblemBlock(raw);
  const answers = [...rawRest.matchAll(/\[(?:빠른\s*정답|정답)\]\s*([^\n\r]*)/gi)].map(
    (item) => item[1]?.trim() || "-",
  );
  const explanationsRaw = [
    ...rawRest.matchAll(
      /\[해설\]\s*([\s\S]*?)(?=\n\s*(?:\[빠른\s*정답\]|\[정답\])|\s*$)/gi,
    ),
  ].map((item) =>
    item[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const maxLen = Math.max(answers.length, explanationsRaw.length, 1);
  for (let i = 0; i < maxLen; i += 1) {
    const explanationLinesRaw = explanationsRaw[i] || [];
    blocks.push({
      questionLabel: String(i + 1),
      problemLinesRaw: i === 0 ? leadingProblem : [],
      answer: answers[i] || (i === 0 ? fallbackQuickAnswer || "-" : "-"),
      explanationLines: explanationLinesRaw.map((line) => explanationLatexToPlain(line)),
      explanationLinesRaw,
    });
  }
  return blocks;
}

function normalizeObjectiveAnswer(answer: string) {
  let t = answer.trim();
  if (!t) return null;
  const circledMap: Record<string, string> = {
    "①": "1",
    "②": "2",
    "③": "3",
    "④": "4",
    "⑤": "5",
  };
  const dollarDigit = t.match(/^\$\s*([1-5])\s*\$$/);
  if (dollarDigit) return dollarDigit[1];
  t = t.replace(/\s*번\s*$/u, "").trim();
  if (/^[①②③④⑤]$/.test(t)) return circledMap[t] ?? null;
  if (/^[1-5]$/.test(t)) return t;
  const parenOnly = t.match(/^\(([1-5])\)$/);
  if (parenOnly) return parenOnly[1];
  const bracketOnly = t.match(/^\[([1-5])\]$/);
  if (bracketOnly) return bracketOnly[1];
  const combo = t.match(/^([①②③④⑤])\s*\(([1-5])\)$/);
  if (combo) {
    const fromCircled = circledMap[combo[1]];
    if (fromCircled === combo[2]) return fromCircled;
  }
  return null;
}

function toCircledObjectiveAnswer(answer: string) {
  if (answer === "1") return "①";
  if (answer === "2") return "②";
  if (answer === "3") return "③";
  if (answer === "4") return "④";
  if (answer === "5") return "⑤";
  return answer;
}

function classifyQuickAnswerKind(answer: string, explanationLines: string[]): QuickAnswerKind {
  if (normalizeObjectiveAnswer(answer)) return "objective";
  const clean = answer.trim();
  const explanationText = explanationLines.join(" ");
  const essayCue = /서술|논술|증명|과정을\s*쓰|풀이를\s*쓰|설명하|해설참고|서술형/.test(
    `${clean} ${explanationText}`,
  );
  /** 괄호·보조 설명이 붙은 객관식 요약(예: ②번 (값 6))은 길이만으로 서술형 처리하지 않는다 */
  const looksLikeMcWithNote =
    /^[①②③④⑤]/.test(clean) || /^[1-5]\s*번/u.test(clean) || /^\(\s*[1-5]\s*\)/.test(clean);
  const longProse =
    clean.length >= 36 && !looksLikeMcWithNote && /[.!?。…]\s*\S/.test(clean.replace(/\([^)]*\)/g, ""));
  if (essayCue || longProse) return "essay";
  return "short";
}

/** `[문제]` 블록 전용: 작업용「문제 원본」크롭 줄은 DOCX에 출력하지 않는다. */
async function paragraphChildrenForProblemDocxLine(
  line: string,
  assetBaseDir: string | undefined,
): Promise<ParagraphChild[] | null> {
  if (isDocxOmittedTypingReferenceCropMarkdownLine(line)) return null;
  return paragraphChildrenForDocxLine(line, assetBaseDir, { boldContent: true });
}

type DocxLineRenderOpts = {
  /** [문제]·[해설] 본문: 평문·한글 구간 굵게 */
  boldContent?: boolean;
};

async function paragraphChildrenForDocxLine(
  line: string,
  assetBaseDir: string | undefined,
  renderOpts?: DocxLineRenderOpts,
): Promise<ParagraphChild[]> {
  const img = parseMarkdownImageLine(line);
  if (img && assetBaseDir) {
    const buf = await readImageRelativeToBase(assetBaseDir, img.src);
    if (buf) {
      const run = imageRunFromBuffer(buf, img.alt);
      if (run) return [run];
      return [
        new TextRun({
          text: `〔DOCX에 넣을 수 없는 이미지 형식〕 ${img.src}`,
          italics: true,
          bold: renderOpts?.boldContent,
          font: EXAM_DOCX_FONT,
          size: EXAM_DOCX_BODY_SIZE_HALF_PT,
        }),
      ];
    }
    return [
      new TextRun({
        text: `〔그림 파일 없음〕 ${img.src}`,
        italics: true,
        bold: renderOpts?.boldContent,
        font: EXAM_DOCX_FONT,
        size: EXAM_DOCX_BODY_SIZE_HALF_PT,
      }),
    ];
  }
  return explanationLineToParagraphChildren(line, { bold: renderOpts?.boldContent });
}

function isSingleImageRunParagraph(children: ParagraphChild[]): boolean {
  return children.length === 1 && children[0] instanceof ImageRun;
}

/** DOCX 「문제」: `N. [문제]` 대신 `N. 발문…` 한 덩어리로 붙인다. */
function prependQuestionNumberToProblemChildren(
  questionLabel: string,
  children: ParagraphChild[],
): ParagraphChild[] {
  return [bodyTextRun({ text: `${questionLabel}. `, bold: true }), ...children];
}

async function buildDocxChoicesBoxTable(lines: string[], assetBaseDir?: string): Promise<Table> {
  const b = EXAM_DOCX_CHOICES_BOX_BORDER;
  /** 2단 칼럼 너비에 맞춘 고정 그리드 — `WidthType.PERCENTAGE` 단독 사용 시 보기 박스가 가로로 눌리는 경우가 있어 DXA + fixed 레이아웃으로 통일 */
  const colW = EXAM_DOCX_SINGLE_COLUMN_WIDTH_TWIPS;
  const cellChildren: Paragraph[] = [
    new Paragraph({
      children: [bodyTextRun({ text: "보기", bold: true })],
      spacing: { ...EXAM_DOCX_BODY_PARAGRAPH_SPACING, after: 60 },
    }),
  ];
  for (const line of lines) {
    const children = await paragraphChildrenForProblemDocxLine(line, assetBaseDir);
    if (!children) continue;
    const figureOnly = isSingleImageRunParagraph(children);
    cellChildren.push(
      new Paragraph({
        children,
        alignment: figureOnly ? AlignmentType.CENTER : undefined,
        spacing: {
          ...EXAM_DOCX_BODY_PARAGRAPH_SPACING,
          after: figureOnly ? 140 : 80,
        },
      }),
    );
  }
  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: colW, type: WidthType.DXA },
    columnWidths: [colW],
    borders: {
      top: b,
      bottom: b,
      left: b,
      right: b,
      insideHorizontal: b,
      insideVertical: b,
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: colW, type: WidthType.DXA },
            margins: { top: 120, bottom: 120, left: 200, right: 200 },
            children: cellChildren,
          }),
        ],
      }),
    ],
  });
}

function quickAnswerDisplayText(block: ExplanationBlock): string {
  const answerKind = classifyQuickAnswerKind(block.answer, block.explanationLines);
  const objective = normalizeObjectiveAnswer(block.answer);
  const rawAnswer = block.answer.trim();
  const objectiveWithExtra =
    Boolean(objective) &&
    (/번/u.test(rawAnswer) || /\([^)]+\)/u.test(rawAnswer) || rawAnswer.replace(/\s/g, "").length > 2);
  if (answerKind === "essay") return "해설참고";
  if (objectiveWithExtra) return quickAnswerToPlainLine(block.answer || "-");
  if (objective) return toCircledObjectiveAnswer(objective);
  return quickAnswerToPlainLine(block.answer || "-");
}

/**
 * HML·`[TEST] TEST1.hml` 과 같은 **대역 순서**(편집본 DOCX와 동일한 **구분 폼**):
 * 1) 문항 순서대로 **문제** 전체(섹션·2단) — `N. 발문…`, 문항은 `w:cantSplit` 표로 묶어 페이지 가운데에서 잘리지 않게 함
 * 2) **다음 면**에서 **`[빠른정답]`**(1단·전체 너비) — 문항마다 `N.` → `[정답]` → 값
 * 3) **그다음 면**에서 **`[해설]`**(2단) — 문항마다 `N.` → `[정답]` → 값 → `[해설]` → 해설 본문 줄
 */
type ExamExplanationSectionChildren = {
  /** 2단 본문 — 문항 단위 `cantSplit` 표로 감싼 블록 */
  problemChildren: (Paragraph | Table)[];
  /** 1단 — `[빠른정답]` 다음 페이지(HML 표 전체 너비에 가깝게) */
  quickAnswerChildren: (Paragraph | Table)[];
  /** 2단 — `[해설]` 다음 페이지 */
  explanationChildren: (Paragraph | Table)[];
};

async function buildExplanationSectionChildren(
  blocks: ExplanationBlock[],
  assetBaseDir?: string,
): Promise<ExamExplanationSectionChildren> {
  const problemChildren: (Paragraph | Table)[] = [];

  for (let idx = 0; idx < blocks.length; idx += 1) {
    const block = blocks[idx]!;
    if (block.problemLinesRaw.length === 0) continue;

    const inner: (Paragraph | Table)[] = [];
    let problemNumberPrefixApplied = false;
    for (const seg of segmentProblemLinesForChoicesBox(block.problemLinesRaw)) {
      if (seg.type === "choices") {
        if (!problemNumberPrefixApplied) {
          inner.push(
            new Paragraph({
              children: [bodyTextRun({ text: `${block.questionLabel}. `, bold: true })],
              spacing: {
                ...EXAM_DOCX_BODY_PARAGRAPH_SPACING,
                before: idx === 0 ? 0 : EXAM_DOCX_INTER_QUESTION_BEFORE_TWIPS,
                after: 80,
              },
            }),
          );
          problemNumberPrefixApplied = true;
        }
        inner.push(await buildDocxChoicesBoxTable(seg.lines, assetBaseDir));
        continue;
      }
      let children = await paragraphChildrenForProblemDocxLine(seg.line, assetBaseDir);
      if (!children) continue;
      const isFirstProblemParagraph = !problemNumberPrefixApplied;
      if (isFirstProblemParagraph) {
        children = prependQuestionNumberToProblemChildren(block.questionLabel, children);
        problemNumberPrefixApplied = true;
      }
      const figureOnly = isSingleImageRunParagraph(children);
      inner.push(
        new Paragraph({
          children,
          alignment: figureOnly ? AlignmentType.CENTER : undefined,
          spacing: {
            ...EXAM_DOCX_BODY_PARAGRAPH_SPACING,
            before: isFirstProblemParagraph
              ? idx === 0
                ? 0
                : EXAM_DOCX_INTER_QUESTION_BEFORE_TWIPS
              : undefined,
            after: figureOnly ? 140 : 100,
          },
        }),
      );
    }
    if (inner.length > 0) {
      problemChildren.push(wrapQuestionBlockInCantSplitTable(inner));
    }
  }

  const quickAnswerChildren: (Paragraph | Table)[] = [
    new Paragraph({
      children: [bodyTextRun({ text: "[빠른정답]", bold: true })],
      spacing: {
        ...EXAM_DOCX_BODY_PARAGRAPH_SPACING,
        before: 0,
        after: 160,
      },
    }),
  ];

  for (let idx = 0; idx < blocks.length; idx += 1) {
    const block = blocks[idx]!;
    const quickAnswerText = quickAnswerDisplayText(block);
    quickAnswerChildren.push(
      new Paragraph({
        children: [bodyTextRun({ text: `${block.questionLabel}.`, bold: true })],
        spacing: {
          ...EXAM_DOCX_BODY_PARAGRAPH_SPACING,
          before: idx === 0 ? 80 : 160,
          after: 60,
        },
      }),
    );
    quickAnswerChildren.push(
      new Paragraph({
        children: [bodyTextRun({ text: "[정답]", bold: true })],
        spacing: { ...EXAM_DOCX_BODY_PARAGRAPH_SPACING, after: 60 },
      }),
    );
    quickAnswerChildren.push(
      new Paragraph({
        children: [bodyTextRun({ text: quickAnswerText, bold: true })],
        spacing: { ...EXAM_DOCX_BODY_PARAGRAPH_SPACING, after: 220 },
      }),
    );
  }

  const explIndent = EXAM_DOCX_EXPLANATION_PARAGRAPH_INDENT_TWIPS;
  const explanationChildren: (Paragraph | Table)[] = [
    new Paragraph({
      children: [bodyTextRun({ text: "[해설]", bold: true })],
      indent: explIndent,
      spacing: {
        ...EXAM_DOCX_BODY_PARAGRAPH_SPACING,
        before: 0,
        after: 160,
      },
    }),
  ];

  for (let idx = 0; idx < blocks.length; idx += 1) {
    const block = blocks[idx]!;
    const quickAnswerText = quickAnswerDisplayText(block);
    explanationChildren.push(
      new Paragraph({
        children: [bodyTextRun({ text: `${block.questionLabel}.`, bold: true })],
        indent: explIndent,
        spacing: {
          ...EXAM_DOCX_BODY_PARAGRAPH_SPACING,
          before: idx === 0 ? 100 : 240,
          after: 60,
        },
      }),
    );
    explanationChildren.push(
      new Paragraph({
        children: [bodyTextRun({ text: "[정답]", bold: true })],
        indent: explIndent,
        spacing: { ...EXAM_DOCX_BODY_PARAGRAPH_SPACING, after: 60 },
      }),
    );
    explanationChildren.push(
      new Paragraph({
        children: [bodyTextRun({ text: quickAnswerText, bold: true })],
        indent: explIndent,
        spacing: { ...EXAM_DOCX_BODY_PARAGRAPH_SPACING, after: 60 },
      }),
    );
    explanationChildren.push(
      new Paragraph({
        children: [bodyTextRun({ text: "[해설]", bold: true })],
        indent: explIndent,
        spacing: { ...EXAM_DOCX_BODY_PARAGRAPH_SPACING, after: 100 },
      }),
    );
    if (block.explanationLinesRaw.length === 0) {
      explanationChildren.push(
        new Paragraph({
          children: [bodyTextRun({ text: "해설 본문이 제공되지 않았습니다.", bold: true })],
          indent: explIndent,
          spacing: { ...EXAM_DOCX_BODY_PARAGRAPH_SPACING, after: 200 },
        }),
      );
      continue;
    }
    for (const line of block.explanationLinesRaw) {
      const children = await paragraphChildrenForDocxLine(line, assetBaseDir, { boldContent: true });
      const figureOnly = isSingleImageRunParagraph(children);
      explanationChildren.push(
        new Paragraph({
          children,
          alignment: figureOnly ? AlignmentType.CENTER : undefined,
          indent: explIndent,
          spacing: {
            ...EXAM_DOCX_BODY_PARAGRAPH_SPACING,
            after: figureOnly ? 140 : EXAM_DOCX_BODY_PARAGRAPH_SPACING.after,
          },
        }),
      );
    }
  }

  return { problemChildren, quickAnswerChildren, explanationChildren };
}

export type BuildExamExplanationDocxParams = {
  examName: string;
  explanationBody: string;
  quickAnswer?: string;
  /** `![](상대경로.png)` 를 DOCX에 삽입할 때 기준 디렉터리(보통 `합본_편집용.md` 가 있는 폴더) */
  assetBaseDir?: string;
  now?: Date;
};

/** save-result·스크립트 공용: 문제(본문)+빠른정답+2단 해설 레이아웃 DOCX */
export async function buildExamExplanationDocxBuffer(params: BuildExamExplanationDocxParams) {
  const now = params.now ?? new Date();
  const quickAnswer = params.quickAnswer ?? "-";
  const examName = params.examName.trim() || "미지정시험지";
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate(),
  ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
    now.getMinutes(),
  ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const baseName = safeExamFileName(`${path.parse(examName).name}_해설_${stamp}`);
  const docxFileName = `${baseName}.docx`;

  const blocks = parseExplanationBlocks(params.explanationBody, quickAnswer);
  const sectionsBody = await buildExplanationSectionChildren(
    blocks,
    params.assetBaseDir?.trim() || undefined,
  );
  const noProblemPlaceholder: (Paragraph | Table)[] = [
    new Paragraph({
      children: [bodyTextRun({ text: "〔문제 본문이 없습니다.〕" })],
      spacing: EXAM_DOCX_BODY_PARAGRAPH_SPACING,
    }),
  ];
  const emptyExplFallback: (Paragraph | Table)[] = [
    new Paragraph({
      children: [bodyTextRun({ text: "해설 본문이 제공되지 않았습니다." })],
      spacing: EXAM_DOCX_BODY_PARAGRAPH_SPACING,
    }),
  ];
  const headerTitle = `${path.parse(examName).name}(해설)`;
  const docDate = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: EXAM_DOCX_FONT,
            size: EXAM_DOCX_BODY_SIZE_HALF_PT,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: EXAM_DOCX_HML_PAGE.size,
            margin: EXAM_DOCX_HML_PAGE.margin,
          },
        },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              bodyTextRun({ text: "수학영역", bold: true, size: EXAM_DOCX_SECTION_TITLE_HALF_PT }),
            ],
            spacing: { after: 100 },
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [bodyTextRun({ text: headerTitle, bold: true, size: EXAM_DOCX_SECTION_TITLE_HALF_PT })],
            spacing: { after: 60 },
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [bodyTextRun({ text: docDate })],
            spacing: { after: 120 },
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: "※ (1) **문제** 2단·문항 단위 `cantSplit` (2) **빠른정답**은 다음 **1단** 면 (3) **해설**은 그다음 **2단** 면. 문항 번호+발문, `![문제 원본](…)` 크롭은 DOCX에 넣지 않음. **N.** → **[정답]** → 값·**[해설]** 풀이. <보기>는 테두리 박스. 용지·여백·단 간격은 `[TEST] TEST1.hml` PAGEDEF/SECDEF·PARAMARGIN에 맞춤(B4 세로).",
                italics: true,
                size: EXAM_DOCX_BODY_SIZE_HALF_PT,
                font: EXAM_DOCX_FONT,
              }),
            ],
            spacing: { after: 180 },
          }),
        ],
      },
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            size: EXAM_DOCX_HML_PAGE.size,
            margin: EXAM_DOCX_HML_PAGE.margin,
          },
          column: {
            count: 2,
            space: EXAM_DOCX_HML_PAGE.columnSpaceTwips,
            separate: true,
          },
        },
        children:
          sectionsBody.problemChildren.length > 0 ? sectionsBody.problemChildren : noProblemPlaceholder,
      },
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            size: EXAM_DOCX_HML_PAGE.size,
            margin: EXAM_DOCX_HML_PAGE.margin,
          },
          column: { count: 1 },
        },
        children: sectionsBody.quickAnswerChildren,
      },
      {
        properties: {
          type: SectionType.NEXT_PAGE,
          page: {
            size: EXAM_DOCX_HML_PAGE.size,
            margin: EXAM_DOCX_HML_PAGE.margin,
          },
          column: {
            count: 2,
            space: EXAM_DOCX_HML_PAGE.columnSpaceTwips,
            separate: true,
          },
        },
        children:
          sectionsBody.explanationChildren.length > 0
            ? sectionsBody.explanationChildren
            : emptyExplFallback,
      },
    ],
  });

  const buffer = Buffer.from(await Packer.toBuffer(doc));
  return { buffer, docxFileName, baseName };
}
