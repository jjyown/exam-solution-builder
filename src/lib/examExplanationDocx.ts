import path from "node:path";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  HeadingLevel,
  SectionType,
  TabStopType,
} from "docx";
import { explanationLineToParagraphChildren } from "@/lib/docxOmmlBuilder";
import { explanationLatexToPlain } from "@/lib/latexToPlainText";

const DOC_BODY_FONT = {
  ascii: "Malgun Gothic",
  eastAsia: "Malgun Gothic",
  hAnsi: "Malgun Gothic",
} as const;

function bodyTextRun(opts: { text: string; bold?: boolean; size?: number }) {
  return new TextRun({
    text: opts.text,
    bold: opts.bold,
    size: opts.size,
    font: DOC_BODY_FONT,
  });
}

function splitLabeledQuestionChunks(raw: string): Array<{ label: string; chunk: string }> {
  const re = /\[문항\s*(\d+)\]\s*/gi;
  const matches = [...raw.matchAll(re)];
  if (matches.length === 0) return [];
  const out: Array<{ label: string; chunk: string }> = [];
  for (let i = 0; i < matches.length; i += 1) {
    const label = matches[i][1] ?? String(i + 1);
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
    const chunk = raw.slice(start, end).trim();
    if (chunk) out.push({ label, chunk });
  }
  return out;
}

export function safeExamFileName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

type ExplanationBlock = {
  questionLabel: string;
  answer: string;
  explanationLines: string[];
  explanationLinesRaw: string[];
};

type QuickAnswerKind = "objective" | "short" | "essay";

function parseExplanationBlocks(explanationBody: string, fallbackQuickAnswer: string) {
  const raw = explanationBody.replace(/\r\n/g, "\n");
  const hasLabeledQuestions = /\[문항\s*\d+\]/.test(raw);

  const blocks: ExplanationBlock[] = [];

  if (hasLabeledQuestions) {
    const labeled = splitLabeledQuestionChunks(raw);
    labeled.forEach((item) => {
      const { label, chunk } = item;
      const answerMatch = chunk.match(/\[정답\]\s*([^\n\r]*)/i);
      const answer = answerMatch?.[1]?.trim() || fallbackQuickAnswer || "-";
      const explanationText = chunk
        .replace(/\[정답\]\s*[^\n\r]*/i, "")
        .replace(/\[해설\]/gi, "")
        .trim();
      const explanationLinesRaw = explanationText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const explanationLines = explanationLinesRaw.map((line) => explanationLatexToPlain(line));
      blocks.push({
        questionLabel: label,
        answer,
        explanationLines,
        explanationLinesRaw,
      });
    });
    if (blocks.length > 0) return blocks;
  }

  const answers = [...raw.matchAll(/\[정답\]\s*([^\n\r]*)/gi)].map(
    (item) => item[1]?.trim() || "-",
  );
  const explanationsRaw = [...raw.matchAll(/\[해설\]\s*([\s\S]*?)(?=\n\s*\[정답\]|\s*$)/gi)].map(
    (item) =>
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
      answer: answers[i] || (i === 0 ? fallbackQuickAnswer || "-" : "-"),
      explanationLines: explanationLinesRaw.map((line) => explanationLatexToPlain(line)),
      explanationLinesRaw,
    });
  }
  return blocks;
}

function normalizeObjectiveAnswer(answer: string) {
  const t = answer.trim();
  if (!t) return null;
  const circledMap: Record<string, string> = {
    "①": "1",
    "②": "2",
    "③": "3",
    "④": "4",
    "⑤": "5",
  };
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
  if (
    /서술|논술|증명|과정을\s*쓰|풀이를\s*쓰|설명하/.test(`${clean} ${explanationText}`) ||
    clean.length >= 24
  ) {
    return "essay";
  }
  return "short";
}

function buildExplanationParagraphs(blocks: ExplanationBlock[]) {
  const paragraphs: Paragraph[] = [];

  blocks.forEach((block, idx) => {
    const answerKind = classifyQuickAnswerKind(block.answer, block.explanationLines);
    const objective = normalizeObjectiveAnswer(block.answer);
    const quickAnswerText =
      answerKind === "essay"
        ? "해설참고"
        : objective
          ? toCircledObjectiveAnswer(objective)
          : block.answer || "-";
    paragraphs.push(
      new Paragraph({
        tabStops: [{ type: TabStopType.LEFT, position: 1800 }],
        children: [
          bodyTextRun({ text: `${block.questionLabel})`, bold: true }),
          bodyTextRun({ text: "\t[정답] ", bold: true }),
          bodyTextRun({ text: quickAnswerText, bold: true }),
        ],
        spacing: { before: idx === 0 ? 0 : 220, after: 80 },
      }),
    );
    paragraphs.push(
      new Paragraph({
        children: [bodyTextRun({ text: "[해설]", bold: true })],
        spacing: { after: 120 },
      }),
    );
    if (block.explanationLinesRaw.length === 0) {
      paragraphs.push(
        new Paragraph({
          children: [bodyTextRun({ text: "해설 본문이 제공되지 않았습니다." })],
          spacing: { after: 140 },
        }),
      );
      return;
    }
    block.explanationLinesRaw.forEach((line) => {
      paragraphs.push(
        new Paragraph({
          children: explanationLineToParagraphChildren(line),
          spacing: { after: 140 },
        }),
      );
    });
  });

  return paragraphs;
}

function buildQuickAnswerRows(blocks: ExplanationBlock[]) {
  const entries = blocks.map((block) => {
    const answerKind = classifyQuickAnswerKind(block.answer, block.explanationLines);
    const objective = normalizeObjectiveAnswer(block.answer);
    const displayAnswer =
      answerKind === "essay"
        ? "해설참고"
        : objective
          ? toCircledObjectiveAnswer(objective)
          : block.answer || "-";
    return `${block.questionLabel}) ${displayAnswer}`;
  });
  return entries.map(
    (entry) =>
      new Paragraph({
        children: [bodyTextRun({ text: entry, bold: true })],
        spacing: { after: 110 },
      }),
  );
}

export type BuildExamExplanationDocxParams = {
  examName: string;
  explanationBody: string;
  quickAnswer?: string;
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
  const explanationParagraphs = buildExplanationParagraphs(blocks);
  const headerTitle = `${path.parse(examName).name}(해설)`;
  const docDate = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(
    now.getDate(),
  ).padStart(2, "0")}`;
  const quickAnswerRows = buildQuickAnswerRows(blocks);

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: {
            font: DOC_BODY_FONT,
            size: 22,
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
            children: [bodyTextRun({ text: "수학영역", bold: true, size: 40 })],
            spacing: { after: 100 },
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            heading: HeadingLevel.HEADING_1,
            children: [
              bodyTextRun({
                text: headerTitle,
                bold: true,
              }),
            ],
            spacing: { after: 60 },
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [bodyTextRun({ text: docDate })],
            spacing: { after: 180 },
          }),
          new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [bodyTextRun({ text: "[빠른 정답]", bold: true })],
            spacing: { after: 90 },
          }),
          ...(quickAnswerRows.length > 0
            ? quickAnswerRows
            : [new Paragraph({ children: [bodyTextRun({ text: "추출/생성된 정답 없음" })] })]),
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
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [bodyTextRun({ text: "[해설]", bold: true })],
            spacing: { before: 180, after: 180 },
          }),
          ...(explanationParagraphs.length > 0
            ? explanationParagraphs
            : [
                new Paragraph({
                  children: [bodyTextRun({ text: "해설 본문이 제공되지 않았습니다." })],
                }),
              ]),
        ],
      },
    ],
  });

  const buffer = Buffer.from(await Packer.toBuffer(doc));
  return { buffer, docxFileName, baseName };
}
