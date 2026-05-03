import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { CROPPED_EXAMS_DIR_NAME } from "@/lib/outputPaths";

export const runtime = "nodejs";

type ManifestItem = { questionNo?: string; file?: string };
type Manifest = { examName?: string; items?: ManifestItem[] };

function safeSegment(s: string) {
  const t = s.trim();
  if (!t || t.includes("..") || path.isAbsolute(t)) return null;
  return t;
}

/**
 * 로컬 `크롭된 시험지/<묶음>/manifest.json` 과 PNG 를 찾아 이미지 바이너리 반환.
 * 배포 서버에 크롭 폴더가 없으면 404.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const examName = (url.searchParams.get("examName") || "").trim();
  const questionNo = (url.searchParams.get("questionNo") || "").trim();
  if (!examName || !questionNo) {
    return NextResponse.json({ error: "examName, questionNo 가 필요합니다." }, { status: 400 });
  }

  const root = path.join(process.cwd(), CROPPED_EXAMS_DIR_NAME);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return NextResponse.json({ error: "크롭 폴더가 없습니다." }, { status: 404 });
  }

  const bundles = entries.filter((e) => !e.startsWith("."));
  const candidates: string[] = [];
  for (const dir of bundles) {
    const manifestPath = path.join(root, dir, "manifest.json");
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const m = JSON.parse(raw) as Manifest;
      if ((m.examName || "").trim() === examName) {
        candidates.push(path.join(root, dir));
      }
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) {
    return NextResponse.json({ error: "해당 시험의 크롭 묶음을 찾지 못했습니다." }, { status: 404 });
  }

  candidates.sort((a, b) => b.localeCompare(a));
  const bundleDir = candidates[0]!;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(bundleDir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return NextResponse.json({ error: "manifest.json 읽기 실패" }, { status: 500 });
  }

  const item = manifest.items?.find((it) => String(it.questionNo ?? "").trim() === questionNo);
  const fileName = item?.file?.trim();
  if (!fileName || !safeSegment(fileName)) {
    return NextResponse.json({ error: "문항에 해당하는 이미지 파일이 manifest 에 없습니다." }, { status: 404 });
  }

  const imagePath = path.join(bundleDir, fileName);
  try {
    const buf = await fs.readFile(imagePath);
    const lower = fileName.toLowerCase();
    const mime = lower.endsWith(".png")
      ? "image/png"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
        ? "image/jpeg"
        : "application/octet-stream";
    return new NextResponse(buf, {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "이미지 파일을 읽을 수 없습니다." }, { status: 404 });
  }
}
