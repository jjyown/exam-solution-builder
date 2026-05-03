import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { CROPPED_EXAMS_DIR_NAME } from "@/lib/outputPaths";

export const runtime = "nodejs";
export const maxDuration = 300;

function safeZipBaseName(raw: string): string {
  const t = raw.trim().replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_");
  return t.slice(0, 72) || "exam";
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "multipart/form-data 본문을 읽을 수 없습니다." }, { status: 400 });
  }

  const file = form.get("file");
  const examNameRaw = String(form.get("examName") ?? "").trim();

  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "file 필드에 ZIP 파일이 필요합니다." }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length < 22) {
    return NextResponse.json({ error: "ZIP 파일이 비어 있거나 너무 작습니다." }, { status: 400 });
  }

  try {
    const dir = path.join(process.cwd(), CROPPED_EXAMS_DIR_NAME);
    await mkdir(dir, { recursive: true });
    const base = safeZipBaseName(examNameRaw || "cropped");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const zipName = `${base}_크롭묶음_${stamp}.zip`;
    const filePath = path.join(dir, zipName);
    await writeFile(filePath, buf);
    const relativePath = path.join(CROPPED_EXAMS_DIR_NAME, zipName).split(path.sep).join("/");
    return NextResponse.json({
      ok: true,
      message: `「${CROPPED_EXAMS_DIR_NAME}」 폴더에 저장했습니다: ${zipName}`,
      relativePath,
      serverCwd: process.cwd(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "저장 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
