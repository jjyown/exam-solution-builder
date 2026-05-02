import { NextResponse } from "next/server";
import {
  getDriveClient,
  isGoogleDriveConfigured,
  resolveDriveWorkCompleteFolderId,
  uploadBufferToDriveFolder,
} from "@/lib/googleDrive";

export const runtime = "nodejs";
export const maxDuration = 300;

function safeZipBaseName(raw: string): string {
  const t = raw.trim().replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, "_");
  return t.slice(0, 72) || "exam";
}

export async function POST(request: Request) {
  if (!isGoogleDriveConfigured()) {
    return NextResponse.json(
      { error: "Google Drive OAuth(GOOGLE_CLIENT_ID/SECRET, GOOGLE_REFRESH_TOKEN)가 설정되지 않았습니다." },
      { status: 503 },
    );
  }

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
    const drive = getDriveClient();
    const folderId = await resolveDriveWorkCompleteFolderId(drive);
    const base = safeZipBaseName(examNameRaw || "cropped");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const zipName = `${base}_크롭묶음_${stamp}.zip`;

    const { id, name } = await uploadBufferToDriveFolder({
      folderId,
      fileName: zipName,
      buffer: buf,
      mimeType: "application/zip",
    });

    return NextResponse.json({
      ok: true,
      message: `Drive 「작업완료」 폴더에 업로드했습니다: ${name}`,
      fileId: id,
      fileName: name,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Drive 업로드 중 오류가 발생했습니다.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
