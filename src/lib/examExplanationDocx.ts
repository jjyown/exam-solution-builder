import path from "node:path";
import {
  Document,
  Packer,
  Paragraph,
  ParagraphChild,
  TextRun,
  AlignmentType,
  SectionType,
  TabStopType,
} from "docx";
import { explanationLineToParagraphChildren } from "@/lib/docxOmmlBuilder";
import {
  imageRunFromBuffer,
  parseMarkdownImageLine,
  readImageRelativeToBase,
} from "@/lib/docxMarkdownImage";
import {
  EXAM_DOCX_BODY_PARAGRAPH_SPACING,
  EXAM_DOCX_BODY_SIZE_HALF_PT,
  EXAM_DOCX_FONT,
  EXAM_DOCX_SECTION_TITLE_HALF_PT,
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

/** `[문제]…[정답]` 선행이 있으면 분리한다. `[문항 n]` 직후에 주입된 `![](...)` 줄은 문제 블록 앞에 붙인다. `[문제]`가 없으면 `[정답]` 직전까지를 발문+선지로 본다. */
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
  const m = t.match(/^\[문제(?:\s+\d+)?\]\s*([\s\S]*?)(?=\n\s*\[정답\]|\[정답\])/i);
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

  const splitAtAnswer = t.split(/(?=\n\s*\[정답\])/i);
  if (splitAtAnswer.length >= 2) {
    const problemBody = splitAtAnswer[0]?.trim() ?? "";
    const rest = splitAtAnswer.slice(1).join("").trim();
    const problemLines = problemBody
      ? problemBody.split("\n").map((line) => line.trim()).filter(Boolean)
      : [];
    return { problemLinesRaw: [...leadingImages, ...problemLines], rest };
  }
  if (/^\[정답\]/i.test(t)) {
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
      const answerMatch = chunkRest.match(/\[정답\]\s*([^\n\r]*)/i);
      const answerLineMatch = chunkRest.match(/\[정답\]\s*\n\s*([^\n\r]+)/i);
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
  const answers = [...rawRest.matchAll(/\[정답\]\s*([^\n\r]*)/gi)].map(
    (item) => item[1]?.trim() || "-",
  );
  const explanationsRaw = [
    ...rawRest.matchAll(/\[해설\]\s*([\s\S]*?)(?=\n\s*\[정답\]|\s*$)/gi),
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

async function paragraphChildrenForDocxLine(
  line: string,
  assetBaseDir: string | undefined,
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
          font: EXAM_DOCX_FONT,
          size: EXAM_DOCX_BODY_SIZE_HALF_PT,
        }),
      ];
    }
    return [
      new TextRun({
        text: `〔그림 파일 없음〕 ${img.src}`,
        italics: true,
        font: EXAM_DOCX_FONT,
        size: EXAM_DOCX_BODY_SIZE_HALF_PT,
      }),
    ];
  }
  return explanationLineToParagraphChildren(line);
}

async function buildExplanationParagraphs(blocks: ExplanationBlock[], assetBaseDir?: string) {
  const paragraphs: Paragraph[] = [];

  for (let idx = 0; idx < blocks.length; idx += 1) {
    const block = blocks[idx]!;
    const answerKind = classifyQuickAnswerKind(block.answer, block.explanationLines);
    const objective = normalizeObjectiveAnswer(block.answer);
    const rawAnswer = block.answer.trim();
    /** ③만이 아니라 「③번」「③번 (구하는 값은 6)」처럼 붙은 객관식 요약은 평문 한 줄로 유지 */
    const objectiveWithExtra =
      Boolean(objective) &&
      (/번/u.test(rawAnswer) || /\([^)]+\)/u.test(rawAnswer) || rawAnswer.replace(/\s/g, "").length > 2);
    const quickAnswerText =
      answerKind === "essay"
        ? "해설참고"
        : objectiveWithExtra
          ? quickAnswerToPlainLine(block.answer || "-")
          : objective
            ? toCircledObjectiveAnswer(objective)
            : quickAnswerToPlainLine(block.answer || "-");
    if (block.problemLinesRaw.length > 0) {
      paragraphs.push(
        new Paragraph({
          children: [
            bodyTextRun({ text: `${block.questionLabel}) `, bold: true }),
            bodyTextRun({ text: "[문제]", bold: true }),
          ],
          spacing: {
            ...EXAM_DOCX_BODY_PARAGRAPH_SPACING,
            before: idx === 0 ? 0 : 220,
            after: 70,
          },
        }),
      );
      for (const line of block.problemLinesRaw) {
        const children = await paragraphChildrenForDocxLine(line, assetBaseDir);
        paragraphs.push(
          new Paragraph({
            children,
            spacing: { ...EXAM_DOCX_BODY_PARAGRAPH_SPACING, after: 100 },
          }),
        );
      }
    }
    paragraphs.push(
      new Paragraph({
        tabStops: [{ type: TabStopType.LEFT, position: 1800 }],
        children: [
          bodyTextRun({ text: `${block.questionLabel})`, bold: true }),
          bodyTextRun({ text: "\t[빠른 정답] ", bold: true }),
          bodyTextRun({ text: quickAnswerText, bold: true }),
        ],
        spacing: {
          ...EXAM_DOCX_BODY_PARAGRAPH_SPACING,
          before: idx === 0 && block.problemLinesRaw.length === 0 ? 0 : 120,
          after: 80,
        },
      }),
    );
    paragraphs.push(
      new Paragraph({
        children: [bodyTextRun({ text: "[해설]", bold: true })],
        spacing: { ...EXAM_DOCX_BODY_PARAGRAPH_SPACING, after: 120 },
      }),
    );
    if (block.explanationLinesRaw.length === 0) {
      paragraphs.push(
        new Paragraph({
          children: [bodyTextRun({ text: "해설 본문이 제공되지 않았습니다." })],
          spacing: { ...EXAM_DOCX_BODY_PARAGRAPH_SPACING, after: 140 },
        }),
      );
      continue;
    }
    for (const line of block.explanationLinesRaw) {
      const children = await paragraphChildrenForDocxLine(line, assetBaseDir);
      paragraphs.push(
        new Paragraph({
          children,
          spacing: EXAM_DOCX_BODY_PARAGRAPH_SPACING,
        }),
      );
    }
  }

  return paragraphs;
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
  const explanationParagraphs = await buildExplanationParagraphs(
    blocks,
    params.assetBaseDir?.trim() || undefined,
  );
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
        properties: {},
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
                text: "※ 본문(2단): 문항별 [문제]·[빠른 정답]·[해설] 순 · 가운데 구분선 · 수식은 Word 수식(OMML). 마크다운 그림 경로는 본문 md와 같은 폴더를 기준으로 넣으면 DOCX에 삽입됩니다.",
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
          column: {
            count: 2,
            space: 708,
            separate: true,
          },
        },
        children: [
          ...(explanationParagraphs.length > 0
            ? explanationParagraphs
            : [
                new Paragraph({
                  children: [bodyTextRun({ text: "해설 본문이 제공되지 않았습니다." })],
                  spacing: EXAM_DOCX_BODY_PARAGRAPH_SPACING,
                }),
              ]),
        ],
      },
    ],
  });

  const buffer = Buffer.from(await Packer.toBuffer(doc));
  return { buffer, docxFileName, baseName };
}
