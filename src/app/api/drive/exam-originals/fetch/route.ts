/**
 * src/app/api/drive/exam-originals/fetch/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST /api/drive/exam-originals/fetch
 *    body: { fileId: string }
 *    응답: { ok, fileName, mimeType, fileData (base64 raw) }
 *  /api/drive/exams/fetch 와 같은 패턴 — 「시험지 원안」 폴더용.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { downloadDriveFileById, isGoogleDriveConfigured } from "@/lib/googleDrive";

export async function POST(req: Request) {
  if (!isGoogleDriveConfigured()) {
    return NextResponse.json({ ok: false, error: "Google Drive 키 미설정" }, { status: 400 });
  }
  let body: { fileId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.fileId) {
    return NextResponse.json({ ok: false, error: "fileId is required" }, { status: 400 });
  }
  try {
    const { buffer, mimeType, name } = await downloadDriveFileById(body.fileId);
    return NextResponse.json({
      ok: true,
      fileName: name,
      mimeType,
      fileData: buffer.toString("base64"),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
