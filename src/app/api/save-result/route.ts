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
} from "docx";

const OUTPUT_DIR = path.join(process.cwd(), "작업 완료");

function safeName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

function buildExplanationParagraphs(explanationBody: string) {
  const lines = explanationBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const paragraphs: Paragraph[] = [];
  for (const line of lines) {
    const isSectionTitle = /^\[[^\]]+\]\s*:/.test(line) || /^\[[^\]]+\]$/.test(line);
    if (isSectionTitle) {
      paragraphs.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: [new TextRun({ text: line, bold: true })],
          spacing: { before: 240, after: 120 },
        }),
      );
      continue;
    }

    paragraphs.push(
      new Paragraph({
        children: [new TextRun({ text: line })],
        spacing: { after: 140 },
      }),
    );
  }

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

    const explanationParagraphs = buildExplanationParagraphs(explanationBody);

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              heading: HeadingLevel.HEADING_1,
              children: [
                new TextRun({
                  text: "수학 해설지",
                  bold: true,
                }),
              ],
              spacing: { after: 220 },
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: "[빠른 정답 체크]",
                  bold: true,
                }),
              ],
              spacing: { after: 200 },
            }),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: quickAnswer, bold: true, size: 36 })],
              spacing: { after: 300 },
            }),
            new Paragraph({
              heading: HeadingLevel.HEADING_2,
              children: [
                new TextRun({
                  text: "[해설]",
                  bold: true,
                }),
              ],
              spacing: { before: 120, after: 180 },
            }),
            ...explanationParagraphs,
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
