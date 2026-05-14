/**
 * GET /api/textbook-ocr/diagnose?scope=textbook|exam
 *
 * 분석용 자료 / 시중교재 (또는 시험지 원안) 안에서 같은 이름의 중복 폴더를 찾아 진단.
 *
 * Plan P4·P9 알고리즘 적용:
 *  - 책 이름 폴더 그룹: hasManifest 우선 (manifest 가진 쪽 keep, 빈 쪽 trash)
 *  - 서브폴더 (ocr/pages) 그룹: manifest 없는 게 정상 → fileCount 만으로 판단
 *  - 양쪽 다 파일 있으면 bothHaveFiles=true, requiresManualMerge=true (자동 추천 X)
 *  - 동률은 oldest createdTime keep
 *
 * P8 단계적 측정: 1차 응답은 hasManifest 만 (다운로드 X).
 *  manifest 상세 (processedPages 등) 는 그룹 5개까지만 측정, 나머지는 manifestPending=true.
 *  사용자가 그룹 카드 클릭 시 /api/textbook-ocr/diagnose/manifest?folderId=... lazy load.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  getDriveClient,
  resolveDriveAnalysisFolderId,
  findOrCreateChildFolder,
  listDriveChildFolders,
  countDriveFolderChildren,
  downloadDriveFileById,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

const SCOPE_TO_FOLDER: Record<"textbook" | "exam", string> = {
  textbook: "시중교재",
  exam: "시험지 원안",
};

const MANIFEST_DETAIL_LIMIT = 5;

export type DiagnoseFolderInfo = {
  id: string;
  fileCount: number;
  folderCount: number;
  createdTime: string | null;
  hasManifest: boolean;
  manifestProcessedPages?: number;
  manifestTotalPages?: number;
  manifestStale?: boolean;
  manifestPending?: boolean;
};

export type DiagnoseGroup = {
  name: string;
  folders: DiagnoseFolderInfo[];
  recommendedKeepId: string | null;
  recommendedTrashIds: string[];
  bothHaveFiles: boolean;
  requiresManualMerge: boolean;
  manifestStale: boolean;
};

export type DiagnoseSubGroup = DiagnoseGroup & {
  bookName: string;
  subName: string;
};

export type DiagnoseResponse = {
  ok: true;
  scope: "textbook" | "exam";
  duplicateBookFolders: DiagnoseGroup[];
  duplicateSubFolders: DiagnoseSubGroup[];
  summary: {
    duplicateGroupCount: number;
    autoSafeGroupCount: number;
    requiresManualMergeCount: number;
  };
};

function applyRecommendation(
  folders: DiagnoseFolderInfo[],
  isBookFolder: boolean,
): Pick<DiagnoseGroup, "recommendedKeepId" | "recommendedTrashIds" | "bothHaveFiles" | "requiresManualMerge" | "manifestStale"> {
  // P9: 서브폴더는 manifest 무시.
  const considerManifest = isBookFolder;
  const withFilesCount = folders.filter((f) => f.fileCount > 0).length;
  const bothHaveFiles = withFilesCount >= 2;

  if (considerManifest) {
    const withManifest = folders.filter((f) => f.hasManifest);

    // P4-4: 둘 다 manifest → 사람이 판단해야 함
    if (withManifest.length >= 2) {
      return {
        recommendedKeepId: null,
        recommendedTrashIds: [],
        bothHaveFiles,
        requiresManualMerge: true,
        manifestStale: true,
      };
    }

    if (withManifest.length === 1) {
      const manifestOne = withManifest[0]!;
      const others = folders.filter((f) => f.id !== manifestOne.id);
      const othersWithFiles = others.filter((f) => f.fileCount > 0);
      if (othersWithFiles.length === 0) {
        // P4-1: manifest 가진 쪽이 살아있고 다른 쪽은 빈 폴더
        return {
          recommendedKeepId: manifestOne.id,
          recommendedTrashIds: others.map((f) => f.id),
          bothHaveFiles: false,
          requiresManualMerge: false,
          manifestStale: false,
        };
      }
      // P4-2: manifest 한쪽 + 다른 쪽에도 파일
      return {
        recommendedKeepId: null,
        recommendedTrashIds: [],
        bothHaveFiles: true,
        requiresManualMerge: true,
        manifestStale: false,
      };
    }
  }

  // P4-3 / 서브폴더: 둘 다 manifest 없음 (또는 manifest 의미 없음)
  if (bothHaveFiles) {
    return {
      recommendedKeepId: null,
      recommendedTrashIds: [],
      bothHaveFiles: true,
      requiresManualMerge: true,
      manifestStale: false,
    };
  }

  // fileCount 많은 쪽 keep, 0 인 것만 trash 후보. 동률은 oldest createdTime (P4-5).
  const sorted = [...folders].sort((a, b) => {
    if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
    const aTime = a.createdTime ? new Date(a.createdTime).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.createdTime ? new Date(b.createdTime).getTime() : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });
  const keep = sorted[0]!;
  const trash = sorted.slice(1).filter((f) => f.fileCount === 0);
  return {
    recommendedKeepId: keep.id,
    recommendedTrashIds: trash.map((f) => f.id),
    bothHaveFiles: false,
    requiresManualMerge: false,
    manifestStale: false,
  };
}

async function buildFolderInfo(
  folderId: string,
  createdTime: string | null,
  detailIndex: number,
): Promise<DiagnoseFolderInfo> {
  const counts = await countDriveFolderChildren(folderId);
  const base: DiagnoseFolderInfo = {
    id: folderId,
    fileCount: counts.fileCount,
    folderCount: counts.folderCount,
    createdTime,
    hasManifest: counts.hasManifest,
  };

  // P8: 그룹 5개까지만 manifest 다운로드 — 그 이후는 lazy.
  if (!counts.hasManifest) return base;
  if (detailIndex >= MANIFEST_DETAIL_LIMIT) {
    return { ...base, manifestPending: true };
  }

  try {
    const drive = getDriveClient();
    const list = await drive.files.list({
      q: `name='manifest.json' and '${folderId}' in parents and trashed=false`,
      fields: "files(id)",
      pageSize: 1,
    });
    const manifestId = list.data.files?.[0]?.id;
    if (!manifestId) return base;
    const dl = await downloadDriveFileById(manifestId);
    const parsed = JSON.parse(dl.buffer.toString("utf-8")) as {
      totalPages?: number;
      processedPages?: number;
    };
    const manifestProcessedPages =
      typeof parsed.processedPages === "number" ? parsed.processedPages : undefined;
    const manifestTotalPages =
      typeof parsed.totalPages === "number" ? parsed.totalPages : undefined;
    const manifestStale =
      typeof manifestProcessedPages === "number" &&
      manifestProcessedPages !== counts.fileCount;
    return {
      ...base,
      manifestProcessedPages,
      manifestTotalPages,
      manifestStale,
    };
  } catch {
    return base;
  }
}

function groupByName<T extends { name: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const arr = map.get(item.name) ?? [];
    arr.push(item);
    map.set(item.name, arr);
  }
  return map;
}

export async function GET(req: NextRequest): Promise<Response> {
  const scopeParam = req.nextUrl.searchParams.get("scope");
  const scope: "textbook" | "exam" = scopeParam === "exam" ? "exam" : "textbook";
  const folderName = SCOPE_TO_FOLDER[scope];

  try {
    const drive = getDriveClient();
    const analysisRootId = await resolveDriveAnalysisFolderId(drive);
    if (!analysisRootId) {
      return NextResponse.json(
        { ok: false, error: "「분석용 자료」 Drive 폴더를 찾지 못했습니다." },
        { status: 500 },
      );
    }
    const targetFolderId = await findOrCreateChildFolder(analysisRootId, folderName);

    // 1) 책 이름 폴더 그룹화 (시중교재 또는 시험지 원안 바로 아래)
    const allBookFolders = await listDriveChildFolders(targetFolderId);
    const bookGroups = groupByName(allBookFolders);

    const duplicateBookFolders: DiagnoseGroup[] = [];
    let bookGroupDetailIndex = 0;
    for (const [name, items] of bookGroups) {
      if (items.length < 2) continue;
      const folderInfos = await Promise.all(
        items.map((item) => buildFolderInfo(item.id, item.createdTime, bookGroupDetailIndex++)),
      );
      duplicateBookFolders.push({
        name,
        folders: folderInfos,
        ...applyRecommendation(folderInfos, true),
      });
    }

    // 2) 각 책 폴더 안 서브폴더 (ocr/pages 등) 중복 검사
    //    중복 책 그룹의 모든 인스턴스 + 단일 책 그룹의 폴더 모두 대상
    const duplicateSubFolders: DiagnoseSubGroup[] = [];
    let subDetailIndex = 0;
    for (const [bookName, items] of bookGroups) {
      for (const bookFolder of items) {
        const subFolders = await listDriveChildFolders(bookFolder.id);
        const subGroups = groupByName(subFolders);
        for (const [subName, subItems] of subGroups) {
          if (subItems.length < 2) continue;
          const folderInfos = await Promise.all(
            subItems.map((item) =>
              buildFolderInfo(item.id, item.createdTime, subDetailIndex++),
            ),
          );
          duplicateSubFolders.push({
            bookName,
            subName,
            name: subName,
            folders: folderInfos,
            ...applyRecommendation(folderInfos, false),
          });
        }
      }
    }

    const all = [...duplicateBookFolders, ...duplicateSubFolders];
    const summary = {
      duplicateGroupCount: all.length,
      autoSafeGroupCount: all.filter((g) => !g.requiresManualMerge && g.recommendedKeepId).length,
      requiresManualMergeCount: all.filter((g) => g.requiresManualMerge).length,
    };

    const response: DiagnoseResponse = {
      ok: true,
      scope,
      duplicateBookFolders,
      duplicateSubFolders,
      summary,
    };
    return NextResponse.json(response);
  } catch (e) {
    return NextResponse.json(
      { ok: false, scope, error: (e as Error).message },
      { status: 500 },
    );
  }
}
