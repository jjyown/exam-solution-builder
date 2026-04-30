import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { isGoogleDriveConfigured, uploadCompletedDocx } from "@/lib/googleDrive";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  HeadingLevel,
  TabStopType,
} from "docx";

const OUTPUT_DIR = path.join(process.cwd(), "작업 완료");

function safeName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

function simplifyMathText(value: string) {
  return value
    .replace(/\$\$?/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\times|\\cdot/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\pi/g, "π")
    .replace(/\\sqrt\{([^}]+)\}/g, "√$1")
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "$1/$2")
    .replace(/\\geq|\\ge/g, "≥")
    .replace(/\\leq|\\le/g, "≤")
    .replace(/\\neq/g, "≠")
    .replace(/\\pm/g, "±")
    .replace(/\\sin/g, "sin")
    .replace(/\\cos/g, "cos")
    .replace(/\\tan/g, "tan")
    .replace(/\\log/g, "log")
    .replace(/\\ln/g, "ln")
    .replace(/\\alpha/g, "α")
    .replace(/\\beta/g, "β")
    .replace(/\\gamma/g, "γ")
    .replace(/\\theta/g, "θ")
    .replace(/\\,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type ExplanationBlock = {
  questionLabel: string;
  answer: string;
  explanationLines: string[];
};

function parseExplanationBlocks(explanationBody: string, fallbackQuickAnswer: string) {
  const normalized = simplifyMathText(explanationBody);
  const chunks = normalized
    .split(/\[문항\s*\d+\]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const hasLabeledQuestions = /\[문항\s*\d+\]/.test(normalized);

  const blocks: ExplanationBlock[] = [];

  if (hasLabeledQuestions && chunks.length > 0) {
    chunks.forEach((chunk, idx) => {
      const answerMatch = chunk.match(/\[정답\]\s*([^\n\r]*)/i);
      const answer = answerMatch?.[1]?.trim() || fallbackQuickAnswer || "-";
      const explanationText = chunk
        .replace(/\[정답\]\s*[^\n\r]*/i, "")
        .replace(/\[해설\]/gi, "")
        .trim();
      const explanationLines = explanationText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      blocks.push({
        questionLabel: String(idx + 1),
        answer,
        explanationLines,
      });
    });
    return blocks;
  }

  const answers = [...normalized.matchAll(/\[정답\]\s*([^\n\r]*)/gi)].map(
    (item) => item[1]?.trim() || "-",
  );
  const explanations = [...normalized.matchAll(/\[해설\]\s*([\s\S]*?)(?=\n\s*\[정답\]|\s*$)/gi)].map(
    (item) =>
      item[1]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
  );
  const maxLen = Math.max(answers.length, explanations.length, 1);
  for (let i = 0; i < maxLen; i += 1) {
    blocks.push({
      questionLabel: String(i + 1),
      answer: answers[i] || (i === 0 ? fallbackQuickAnswer || "-" : "-"),
      explanationLines: explanations[i] || [],
    });
  }
  return blocks;
}

function buildExplanationParagraphs(blocks: ExplanationBlock[]) {
  const paragraphs: Paragraph[] = [];

  blocks.forEach((block, idx) => {
    paragraphs.push(
      new Paragraph({
        tabStops: [{ type: TabStopType.LEFT, position: 1800 }],
        children: [
          new TextRun({ text: `${block.questionLabel})`, bold: true }),
          new TextRun({ text: "\t[정답] ", bold: true }),
          new TextRun({ text: block.answer, bold: true }),
        ],
        spacing: { before: idx === 0 ? 0 : 220, after: 80 },
      }),
    );
    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: "[해설]", bold: true })],
        spacing: { after: 120 },
      }),
    );
    if (block.explanationLines.length === 0) {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: "해설 본문이 제공되지 않았습니다." })],
          spacing: { after: 140 },
        }),
      );
      return;
    }
    block.explanationLines.forEach((line) => {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: line })],
          spacing: { after: 140 },
        }),
      );
    });
  });

  return paragraphs;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const examName = String(formData.get("examName") || "미지정시험지");
    const questionNo = String(formData.get("questionNo") || "1");
    const quickAnswer = String(formData.get("quickAnswer") || "-");
    const explanationBody = String(formData.get("explanationBody") || "");

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate(),
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
      now.getMinutes(),
    ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;

    const baseName = safeName(`${path.parse(examName).name}_해설_${stamp}`);

    const docxFileName = `${baseName}.docx`;
    const docxPath = path.join(OUTPUT_DIR, docxFileName);

    const blocks = parseExplanationBlocks(explanationBody, quickAnswer);
    const explanationParagraphs = buildExplanationParagraphs(blocks);
    const quickAnswerSummary = blocks
      .map((item) => `${item.questionLabel}) ${item.answer || "-"}`)
      .join("   ");
    const headerTitle = `${path.parse(examName).name}(해설)`;
    const docDate = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(
      now.getDate(),
    ).padStart(2, "0")}`;

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: "수학영역", bold: true, size: 40 })],
              spacing: { after: 100 },
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              heading: HeadingLevel.HEADING_1,
              children: [
                new TextRun({
                  text: headerTitle,
                  bold: true,
                }),
              ],
              spacing: { after: 60 },
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: docDate })],
              spacing: { after: 180 },
            }),
            new Paragraph({
              alignment: AlignmentType.LEFT,
              children: [
                new TextRun({
                  text: "[빠른 정답]",
                  bold: true,
                }),
              ],
              spacing: { after: 100 },
            }),
            new Paragraph({
              alignment: AlignmentType.LEFT,
              children: [new TextRun({ text: quickAnswerSummary, bold: true })],
              spacing: { after: 260 },
            }),
          ],
        },
        {
          properties: {
            column: {
              count: 2,
              space: 708,
            },
          },
          children: [
            new Paragraph({
              heading: HeadingLevel.HEADING_2,
              children: [new TextRun({ text: "[해설]", bold: true })],
              spacing: { before: 120, after: 180 },
            }),
            ...(explanationParagraphs.length > 0
              ? explanationParagraphs
              : [
                  new Paragraph({
                    children: [new TextRun({ text: "해설 본문이 제공되지 않았습니다." })],
                  }),
                ]),
          ],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);

    if (isGoogleDriveConfigured()) {
      await uploadCompletedDocx(buffer, docxFileName);
      return NextResponse.json({
        message: "작업 완료 폴더(Drive)에 DOCX로 업로드했습니다.",
      });
    }

    // 로컬 개발/테스트를 위한 폴백
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(docxPath, buffer);
    return NextResponse.json({
      message: "작업 완료 폴더에 DOCX로 저장했습니다.",
      docxPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    console.error("Failed to save result:", message, error);
    return NextResponse.json(
      { error: `작업 완료 폴더 저장 중 오류가 발생했습니다: ${message}` },
      { status: 500 },
    );
  }
}
