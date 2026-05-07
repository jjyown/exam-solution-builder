/**
 * src/app/api/drive/exams/fetch/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST /api/drive/exams/fetch
 *    body: { fileId: string }
 *    응답: { ok, fileName, mimeType, fileData (base64 raw, no data: prefix) }
 *
 *  Drive 시험지 폴더에서 선택한 파일을 base64 로 받아 /auto 페이지의 기존 파일
 *  업로드 파이프라인에 그대로 흘려넣을 수 있게 한다.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { downloadDriveFileById, isGoogleDriveConfigured } from "@/lib/googleDrive";

export async function POST(req: Request) {
  if (!isGoogleDriveConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Google Drive 키 미설정" },
      { status: 400 },
    );
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
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
