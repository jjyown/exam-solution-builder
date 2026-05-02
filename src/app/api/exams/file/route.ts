import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { downloadDriveExamFileByName, isGoogleDriveConfigured } from "@/lib/googleDrive";

const EXAM_DIR_KO = path.join(process.cwd(), "시험지");
const EXAM_DIR_EN = path.join(process.cwd(), "exams");
const EXAM_DIR_CANDIDATES = [EXAM_DIR_KO, EXAM_DIR_EN];
const ALLOWED_EXTENSIONS = new Set([
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

function getMimeType(ext: string) {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".pdf":
      return "application/pdf";
    case ".hml":
      return "text/xml; charset=utf-8";
    case ".hwp":
      return "application/x-hwp";
    case ".hwpx":
      return "application/haansofthwpx";
    default:
      return "application/octet-stream";
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "").trim();
    if (!name) {
      return NextResponse.json({ error: "파일명이 필요합니다." }, { status: 400 });
    }

    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json({ error: "지원하지 않는 파일 형식입니다." }, { status: 400 });
    }

    const normalized = path.normalize(name);
    if (normalized.includes("..") || path.isAbsolute(normalized)) {
      return NextResponse.json({ error: "잘못된 파일 경로입니다." }, { status: 400 });
    }

    for (const dirPath of EXAM_DIR_CANDIDATES) {
      const candidatePath = path.join(dirPath, normalized);
      try {
        await fs.access(candidatePath);
        const data = await fs.readFile(candidatePath);
        return new NextResponse(data, {
          headers: {
            "Content-Type": getMimeType(ext),
            "Cache-Control": "no-store",
            "X-Exam-File-Source": "local",
          },
        });
      } catch {
        continue;
      }
    }

    if (isGoogleDriveConfigured()) {
      try {
        const { buffer, mimeType } = await downloadDriveExamFileByName(normalized);
        return new NextResponse(new Uint8Array(buffer), {
          headers: {
            "Content-Type": mimeType || getMimeType(ext),
            "Cache-Control": "no-store",
            "X-Exam-File-Source": "google-drive",
          },
        });
      } catch (driveErr) {
        const detail = driveErr instanceof Error ? driveErr.message : String(driveErr);
        return NextResponse.json(
          { error: "시험지 파일을 찾을 수 없습니다.", details: [detail] },
          { status: 404 },
        );
      }
    }

    return NextResponse.json({ error: "시험지 파일을 찾을 수 없습니다." }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    console.error("Failed to read exam file:", message, error);
    return NextResponse.json(
      { error: `시험지 파일을 불러오지 못했습니다: ${message}` },
      { status: 500 },
    );
  }
}
