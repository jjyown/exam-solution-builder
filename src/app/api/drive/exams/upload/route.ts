/**
 * src/app/api/drive/exams/upload/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST /api/drive/exams/upload
 *    body: { fileName: string, fileData: base64, mimeType: string }
 *    Drive 「해설제작/시험지」 폴더에 편집 완료된 파일을 업로드.
 *    시험지 편집 탭(/edit)이 결과물을 자동/크롭 탭에서 바로 쓸 수 있게 모음.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import {
  getDriveClient,
  isGoogleDriveConfigured,
  resolveDriveExamsFolderId,
  uploadBufferToDriveFolder,
} from "@/lib/googleDrive";

export async function POST(req: Request) {
  if (!isGoogleDriveConfigured()) {
    return NextResponse.json({ ok: false, error: "Google Drive 키 미설정" }, { status: 400 });
  }
  let body: { fileName?: string; fileData?: string; mimeType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.fileName || !body.fileData || !body.mimeType) {
    return NextResponse.json(
      { ok: false, error: "fileName, fileData(base64), mimeType 필요" },
      { status: 400 },
    );
  }
  try {
    const drive = getDriveClient();
    const folderId = await resolveDriveExamsFolderId(drive);
    const buffer = Buffer.from(body.fileData, "base64");
    if (buffer.length === 0) {
      return NextResponse.json({ ok: false, error: "빈 파일" }, { status: 400 });
    }
    const r = await uploadBufferToDriveFolder({
      folderId,
      fileName: body.fileName,
      buffer,
      mimeType: body.mimeType,
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
