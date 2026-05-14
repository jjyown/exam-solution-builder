/**
 * GET /api/textbook-ocr/diagnose/manifest?folderId=...
 *
 * P8 lazy load — diagnose 1차 응답에서 hasManifest 만 측정한 그룹의 manifest 상세를
 * 사용자가 그룹 카드 클릭 시 단건으로 다운로드.
 *
 * 응답: { ok, hasManifest, processedPages?, totalPages?, manifestStale? }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getDriveClient,
  countDriveFolderChildren,
  downloadDriveFileById,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

export type DiagnoseManifestResponse =
  | {
      ok: true;
      hasManifest: boolean;
      processedPages?: number;
      totalPages?: number;
      manifestStale?: boolean;
      fileCount?: number;
    }
  | { ok: false; error: string };

export async function GET(req: NextRequest): Promise<Response> {
  const folderId = req.nextUrl.searchParams.get("folderId")?.trim() || "";
  if (!folderId) {
    return NextResponse.json<DiagnoseManifestResponse>(
      { ok: false, error: "folderId 가 필요합니다." },
      { status: 400 },
    );
  }

  try {
    const drive = getDriveClient();
    const counts = await countDriveFolderChildren(folderId);
    if (!counts.hasManifest) {
      return NextResponse.json<DiagnoseManifestResponse>({
        ok: true,
        hasManifest: false,
        fileCount: counts.fileCount,
      });
    }

    const list = await drive.files.list({
      q: `name='manifest.json' and '${folderId}' in parents and trashed=false`,
      fields: "files(id)",
      pageSize: 1,
    });
    const manifestId = list.data.files?.[0]?.id;
    if (!manifestId) {
      return NextResponse.json<DiagnoseManifestResponse>({
        ok: true,
        hasManifest: false,
        fileCount: counts.fileCount,
      });
    }

    const dl = await downloadDriveFileById(manifestId);
    const parsed = JSON.parse(dl.buffer.toString("utf-8")) as {
      totalPages?: number;
      processedPages?: number;
    };
    const processedPages =
      typeof parsed.processedPages === "number" ? parsed.processedPages : undefined;
    const totalPages =
      typeof parsed.totalPages === "number" ? parsed.totalPages : undefined;
    const manifestStale =
      typeof processedPages === "number" && processedPages !== counts.fileCount;

    return NextResponse.json<DiagnoseManifestResponse>({
      ok: true,
      hasManifest: true,
      processedPages,
      totalPages,
      manifestStale,
      fileCount: counts.fileCount,
    });
  } catch (e) {
    return NextResponse.json<DiagnoseManifestResponse>(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
