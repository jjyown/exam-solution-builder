import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { isGoogleDriveConfigured, listExamFiles } from "@/lib/googleDrive";

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
]);

export async function GET() {
  try {
    const files = isGoogleDriveConfigured()
      ? await listExamFiles(ALLOWED_EXTENSIONS)
      : await (async () => {
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
        })();

    const sorted = files.sort((a, b) => a.localeCompare(b, "ko"));
    return NextResponse.json({ files: sorted });
  } catch (error) {
    console.error("Failed to list exam files:", error);
    return NextResponse.json(
      { error: "시험지 폴더를 읽지 못했습니다." },
      { status: 500 },
    );
  }
}
