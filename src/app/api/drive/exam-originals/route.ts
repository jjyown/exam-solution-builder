/**
 * src/app/api/drive/exam-originals/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  GET /api/drive/exam-originals
 *    Google Drive 「해설제작/시험지 원안」 폴더의 이미지 파일 목록.
 *    시험지 편집 탭(/edit)이 이 결과로 dropdown 을 만든다.
 *
 *  응답: { ok, configured, folderResolved, folderId?, files: [...] }
 *  - configured=false: Drive 키 미설정
 *  - folderResolved=false: 키는 있지만 「시험지 원안」 폴더가 Drive 에 없음
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import {
  getDriveClient,
  isGoogleDriveConfigured,
  listDriveFolderFiles,
  resolveDriveExamOriginalsFolderId,
} from "@/lib/googleDrive";

// 편집기는 이미지/PDF 가 모두 입력 가능. PDF 는 페이지별 분해 후 다룬다.
const ALLOWED_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif"]);

export async function GET() {
  if (!isGoogleDriveConfigured()) {
    return NextResponse.json({
      ok: true,
      configured: false,
      folderResolved: false,
      files: [],
      reason:
        "GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN 미설정 — Drive 연동을 쓰려면 Railway Variables 에 등록하세요.",
    });
  }
  try {
    const drive = getDriveClient();
    const folderId = await resolveDriveExamOriginalsFolderId(drive);
    if (!folderId) {
      return NextResponse.json({
        ok: true,
        configured: true,
        folderResolved: false,
        files: [],
        reason:
          "「시험지 원안」 폴더를 찾지 못했습니다. Drive 의 「해설제작」 안에 「시험지 원안」 폴더를 만들거나 GOOGLE_DRIVE_EXAM_ORIGINALS_FOLDER_ID 를 직접 지정하세요.",
      });
    }
    const files = await listDriveFolderFiles(folderId, ALLOWED_EXTS);
    return NextResponse.json({
      ok: true,
      configured: true,
      folderResolved: true,
      folderId,
      files,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        folderResolved: false,
        files: [],
        error: (e as Error).message,
      },
      { status: 500 },
    );
  }
}
