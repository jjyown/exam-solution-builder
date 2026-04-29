import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

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
    default:
      return "application/octet-stream";
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "").trim();
    if (!name) {
      return NextResponse.json(
        { error: "파일명이 필요합니다." },
        { status: 400 },
      );
    }

    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { error: "지원하지 않는 파일 형식입니다." },
        { status: 400 },
      );
    }

    const normalized = path.normalize(name);
    if (normalized.includes("..") || path.isAbsolute(normalized)) {
      return NextResponse.json(
        { error: "잘못된 파일 경로입니다." },
        { status: 400 },
      );
    }

    let targetPath = "";
    for (const dirPath of EXAM_DIR_CANDIDATES) {
      const candidatePath = path.join(dirPath, normalized);
      try {
        await fs.access(candidatePath);
        targetPath = candidatePath;
        break;
      } catch {
        continue;
      }
    }

    if (!targetPath) {
      return NextResponse.json(
        { error: "시험지 파일을 찾을 수 없습니다." },
        { status: 404 },
      );
    }

    const data = await fs.readFile(targetPath);
    return new NextResponse(data, {
      headers: {
        "Content-Type": getMimeType(ext),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Failed to read exam file:", error);
    return NextResponse.json(
      { error: "시험지 이미지를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
