import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { isGoogleDriveConfigured, uploadCompletedDocx } from "@/lib/googleDrive";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
} from "docx";

const OUTPUT_DIR = path.join(process.cwd(), "작업 완료");

function safeName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const examName = String(formData.get("examName") || "미지정시험지");
    const questionNo = String(formData.get("questionNo") || "1");
    const quickAnswer = String(formData.get("quickAnswer") || "-");
    const explanationBody = String(formData.get("explanationBody") || "");

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate(),
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
      now.getMinutes(),
    ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;

    const baseName = safeName(
      `${path.parse(examName).name}_문항${safeName(questionNo)}_${stamp}`,
    );

    const docxFileName = `${baseName}.docx`;
    const docxPath = path.join(OUTPUT_DIR, docxFileName);

    const blocks = explanationBody
      .split(/\n\s*\n/g)
      .map((s) => s.trim())
      .filter(Boolean);

    // 2단(좌/우)을 "블록 단위"로 번갈아 배치합니다.
    const leftBlocks: string[] = [];
    const rightBlocks: string[] = [];
    blocks.forEach((blk, idx) => {
      if (idx % 2 === 0) leftBlocks.push(blk);
      else rightBlocks.push(blk);
    });
    const maxLen = Math.max(leftBlocks.length, rightBlocks.length);

    const tableRows: TableRow[] = [];
    for (let i = 0; i < maxLen; i++) {
      tableRows.push(
        new TableRow({
          children: [
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: leftBlocks[i] ?? "",
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: rightBlocks[i] ?? "",
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      );
    }

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
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
              text: "",
              spacing: { after: 100 },
            }),
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: tableRows,
            }),
            new Paragraph({
              text: "",
            }),
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
    await fs.writeFile(docxPath, buffer);
    return NextResponse.json({
      message: "작업 완료 폴더에 DOCX로 저장했습니다.",
      docxPath,
    });
  } catch (error) {
    console.error("Failed to save result:", error);
    return NextResponse.json(
      { error: "작업 완료 폴더 저장 중 오류가 발생했습니다." },
      { status: 500 },
    );
  }
}
