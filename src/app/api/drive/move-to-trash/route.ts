/**
 * src/app/api/drive/move-to-trash/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST /api/drive/move-to-trash
 *    body: { fileId: string }
 *    Drive 「해설제작 / 휴지통」 폴더로 파일을 이동한다.
 *    시험지 편집 탭에서 처리 끝난 원본(시험지 편집 전 폴더의 파일)을 정리할 때 사용.
 *  응답: { ok, fileId, name } 또는 { ok: false, error }
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import {
  getDriveClient,
  isGoogleDriveConfigured,
  moveDriveFileToFolder,
  resolveDriveTrashFolderId,
} from "@/lib/googleDrive";

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
    const drive = getDriveClient();
    const trashId = await resolveDriveTrashFolderId(drive);
    if (!trashId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "「휴지통」 폴더를 찾지 못했습니다. Drive 의 「해설제작」 안에 「휴지통」 폴더를 만들거나 GOOGLE_DRIVE_TRASH_FOLDER_ID 를 직접 지정하세요.",
        },
        { status: 500 },
      );
    }
    const r = await moveDriveFileToFolder(drive, body.fileId, trashId);
    return NextResponse.json({ ok: true, fileId: r.id, name: r.name });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
