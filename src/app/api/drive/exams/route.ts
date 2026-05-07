/**
 * src/app/api/drive/exams/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  GET /api/drive/exams
 *    Google Drive 「해설제작/시험지」 폴더의 PDF·이미지 파일을 메타데이터와 함께 반환.
 *    /auto 페이지의 Drive Picker UI 가 이 결과로 dropdown 을 만든다.
 *
 *  응답: { ok, configured, files: [{ id, name, mimeType, modifiedTime, size }] }
 *  configured=false → Drive 키 미설정. UI 는 안내만 띄우고 기존 파일 업로드 사용.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import {
  getDriveClient,
  isGoogleDriveConfigured,
  listDriveFolderFiles,
  resolveDriveExamsFolderId,
} from "@/lib/googleDrive";

const ALLOWED_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export async function GET() {
  if (!isGoogleDriveConfigured()) {
    return NextResponse.json({
      ok: true,
      configured: false,
      files: [],
      reason:
        "GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN 미설정 — Drive 연동을 쓰려면 Railway Variables 에 등록하세요.",
    });
  }
  try {
    const drive = getDriveClient();
    const folderId = await resolveDriveExamsFolderId(drive);
    const files = await listDriveFolderFiles(folderId, ALLOWED_EXTS);
    return NextResponse.json({ ok: true, configured: true, folderId, files });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        files: [],
        error: (e as Error).message,
      },
      { status: 500 },
    );
  }
}
