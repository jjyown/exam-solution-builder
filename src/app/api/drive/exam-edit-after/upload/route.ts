/**
 * src/app/api/drive/exam-edit-after/upload/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST /api/drive/exam-edit-after/upload
 *    body: { fileName: string, fileData: base64, mimeType: string }
 *    Drive 「해설제작/분석용 자료/시험지 편집/시험지 편집 후」 폴더에 편집 결과 PDF 업로드.
 *
 *  주의: 이 폴더는 시험지 편집 워크플로우의 출력 전용. 해설 제작 탭의 시험지
 *  picker 와는 별개 (해설 제작은 기존 「시험지」 폴더 사용).
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import {
  getDriveClient,
  isGoogleDriveConfigured,
  resolveDriveExamEditAfterFolderId,
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
    const folderId = await resolveDriveExamEditAfterFolderId(drive);
    if (!folderId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "「시험지 편집 후」 폴더를 찾지 못했습니다. Drive 의 「해설제작/분석용 자료/시험지 편집」 안에 「시험지 편집 후」 폴더를 만들거나 GOOGLE_DRIVE_EXAM_EDIT_AFTER_FOLDER_ID 를 직접 지정하세요.",
        },
        { status: 500 },
      );
    }
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
