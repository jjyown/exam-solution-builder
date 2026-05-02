import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { buildExamExplanationDocxBuffer } from "@/lib/examExplanationDocx";
import { FINAL_EXPLANATION_DIR_NAME } from "@/lib/outputPaths";

const OUTPUT_DIR = path.join(process.cwd(), FINAL_EXPLANATION_DIR_NAME);

/** 최종 DOCX는 로컬 `해설지 최종본`에만 저장합니다. Drive로 다시 올리지 않습니다. */
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const examName = String(formData.get("examName") || "미지정시험지");
    const quickAnswer = String(formData.get("quickAnswer") || "-");
    const explanationBody = String(formData.get("explanationBody") || "");

    const now = new Date();
    const { buffer, docxFileName } = await buildExamExplanationDocxBuffer({
      examName,
      explanationBody,
      quickAnswer,
      now,
    });
    const docxPath = path.join(OUTPUT_DIR, docxFileName);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(docxPath, buffer);

    return NextResponse.json({
      message: `「${FINAL_EXPLANATION_DIR_NAME}」폴더에 DOCX로 저장했습니다.`,
      docxPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    console.error("Failed to save result:", message, error);
    return NextResponse.json(
      { error: `「${FINAL_EXPLANATION_DIR_NAME}」저장 중 오류가 발생했습니다: ${message}` },
      { status: 500 },
    );
  }
}
