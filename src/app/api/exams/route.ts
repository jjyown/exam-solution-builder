import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { isGoogleDriveConfigured, listDriveExamFiles } from "@/lib/googleDrive";

const EXAM_DIR_KO = path.join(process.cwd(), "시험지");
const EXAM_DIR_EN = path.join(process.cwd(), "exams");
const EXAM_DIR_CANDIDATES = [EXAM_DIR_KO, EXAM_DIR_EN];
const ALLOWED_EXTENSIONS = new Set<string>([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf",
  ".hml",
  ".hwp",
  ".hwpx",
]);

async function listLocalExamFiles(): Promise<string[]> {
  const foundFiles = new Set<string>();
  for (const dirPath of EXAM_DIR_CANDIDATES) {
    await fs.mkdir(dirPath, { recursive: true });
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase()))
      .forEach((name) => foundFiles.add(name));
  }
  return Array.from(foundFiles);
}

export async function GET() {
  try {
    const foundFiles = new Set<string>();
    const warnings: string[] = [];

    for (const name of await listLocalExamFiles()) {
      foundFiles.add(name);
    }

    if (isGoogleDriveConfigured()) {
      try {
        for (const name of await listDriveExamFiles(ALLOWED_EXTENSIONS)) {
          foundFiles.add(name);
        }
      } catch (e) {
        console.error("Drive 시험지 목록 실패:", e);
        warnings.push(
          `Google Drive 목록 생략: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const sorted = Array.from(foundFiles).sort((a, b) => a.localeCompare(b, "ko"));
    return NextResponse.json({
      files: sorted,
      sources: {
        local: true,
        googleDrive: isGoogleDriveConfigured(),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    console.error("Failed to list exam files:", message, error);
    return NextResponse.json(
      { error: `시험지 목록을 읽지 못했습니다: ${message}` },
      { status: 500 },
    );
  }
}
