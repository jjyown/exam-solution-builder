import path from "node:path";
import { google } from "googleapis";
import type { drive_v3 } from "googleapis";

function env(key: string) {
  return process.env[key]?.trim() || "";
}

function escapeDriveQueryString(value: string) {
  return value.replace(/'/g, "\\'");
}

function streamToBuffer(stream: NodeJS.ReadableStream) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export function isGoogleDriveConfigured(): boolean {
  return Boolean(
    env("GOOGLE_CLIENT_ID") && env("GOOGLE_CLIENT_SECRET") && env("GOOGLE_REFRESH_TOKEN"),
  );
}

let driveSingleton: drive_v3.Drive | null = null;

export function getDriveClient(): drive_v3.Drive {
  if (!isGoogleDriveConfigured()) {
    throw new Error(
      "Google Drive: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN 을 설정하세요.",
    );
  }
  if (driveSingleton) return driveSingleton;
  const oauth2Client = new google.auth.OAuth2({
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
  });
  oauth2Client.setCredentials({ refresh_token: env("GOOGLE_REFRESH_TOKEN") });
  driveSingleton = google.drive({ version: "v3", auth: oauth2Client });
  return driveSingleton;
}

async function findChildFolderId(
  drive: drive_v3.Drive,
  parentId: string,
  folderName: string,
): Promise<string | null> {
  const q = `name='${escapeDriveQueryString(folderName)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q, fields: "files(id)", pageSize: 5 });
  return res.data.files?.[0]?.id ?? null;
}

/** 「해설제작」 등 부모 폴더 ID (시험지·작업완료 형제 폴더의 공통 부모) */
export async function resolveDriveParentFolderId(drive: drive_v3.Drive): Promise<string> {
  const parentFolderId = env("GOOGLE_DRIVE_PARENT_FOLDER_ID");
  if (parentFolderId) return parentFolderId;
  const parentName = env("GOOGLE_DRIVE_PARENT_FOLDER_NAME") || "해설제작";
  const qRoot = `name='${escapeDriveQueryString(parentName)}' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const rootRes = await drive.files.list({ q: qRoot, fields: "files(id)", pageSize: 1 });
  return rootRes.data.files?.[0]?.id ?? "root";
}

/** Railway 크롭 묶음(읽기 전용)이 있는 Drive 폴더 ID */
export async function resolveDriveExamsFolderId(drive: drive_v3.Drive): Promise<string> {
  const direct = env("GOOGLE_DRIVE_EXAMS_FOLDER_ID");
  if (direct) return direct;

  const parentName = env("GOOGLE_DRIVE_PARENT_FOLDER_NAME") || "해설제작";
  const examsName = env("GOOGLE_DRIVE_EXAMS_FOLDER_NAME") || "시험지";
  const parentId = await resolveDriveParentFolderId(drive);

  const examsId = await findChildFolderId(drive, parentId, examsName);
  if (!examsId) {
    throw new Error(
      `Drive에서 시험지 폴더를 찾지 못했습니다. GOOGLE_DRIVE_EXAMS_FOLDER_ID 를 직접 지정하거나, 부모 「${parentName}」 아래 「${examsName}」 폴더를 만드세요.`,
    );
  }
  return examsId;
}

/** 크롭 ZIP 업로드 대상: 기본 폴더명 「작업완료」(시험지와 같은 부모 아래) */
export async function resolveDriveWorkCompleteFolderId(drive: drive_v3.Drive): Promise<string> {
  const direct = env("GOOGLE_DRIVE_WORK_COMPLETE_FOLDER_ID");
  if (direct) return direct;

  const parentName = env("GOOGLE_DRIVE_PARENT_FOLDER_NAME") || "해설제작";
  const folderName =
    env("GOOGLE_DRIVE_WORK_COMPLETE_FOLDER_NAME") ||
    env("GOOGLE_DRIVE_COMPLETED_FOLDER_NAME") ||
    "작업완료";
  const parentId = await resolveDriveParentFolderId(drive);
  const id = await findChildFolderId(drive, parentId, folderName);
  if (!id) {
    throw new Error(
      `Drive에서 「${folderName}」 폴더를 찾지 못했습니다. 루트의 「${parentName}」 아래에 「${folderName}」 폴더를 만들거나, GOOGLE_DRIVE_WORK_COMPLETE_FOLDER_ID 를 직접 지정하세요.`,
    );
  }
  return id;
}

/** 분석용 자료 폴더 (KB 자동 학습 대상) */
export async function resolveDriveAnalysisFolderId(drive: drive_v3.Drive): Promise<string | null> {
  const direct = env("GOOGLE_DRIVE_ANALYSIS_FOLDER_ID");
  if (direct) return direct;

  const folderName = env("GOOGLE_DRIVE_ANALYSIS_FOLDER_NAME") || "분석용 자료";
  const parentId = await resolveDriveParentFolderId(drive);
  const id = await findChildFolderId(drive, parentId, folderName);
  return id ?? null;
}

/**
 * 시험지 편집 탭에서 사용하는 입력/출력 폴더 — 둘 다 다음 경로 안에 있음:
 *   해설제작 / 분석용 자료 / 시험지 편집 / [시험지 편집 전 | 시험지 편집 후]
 *
 *  - 시험지 편집 전: 사용자가 처리해야 할 원본 사진·스캔 (편집 입력)
 *  - 시험지 편집 후: 자르기·정리 끝난 결과물 (편집 출력)
 *
 *  ENV 오버라이드:
 *   - GOOGLE_DRIVE_EXAM_EDIT_BEFORE_FOLDER_ID (직접 ID 지정 — 깊은 경로 탐색 안 함)
 *   - GOOGLE_DRIVE_EXAM_EDIT_AFTER_FOLDER_ID
 *   - GOOGLE_DRIVE_EXAM_EDIT_BEFORE_FOLDER_NAME (기본 "시험지 편집 전")
 *   - GOOGLE_DRIVE_EXAM_EDIT_AFTER_FOLDER_NAME (기본 "시험지 편집 후")
 *   - GOOGLE_DRIVE_EXAM_EDIT_PARENT_FOLDER_NAME (기본 "시험지 편집")
 */
async function resolveDriveExamEditParentFolderId(
  drive: drive_v3.Drive,
): Promise<string | null> {
  const analysisId = await resolveDriveAnalysisFolderId(drive);
  if (!analysisId) return null;
  const editParentName = env("GOOGLE_DRIVE_EXAM_EDIT_PARENT_FOLDER_NAME") || "시험지 편집";
  return findChildFolderId(drive, analysisId, editParentName);
}

export async function resolveDriveExamEditBeforeFolderId(
  drive: drive_v3.Drive,
): Promise<string | null> {
  const direct = env("GOOGLE_DRIVE_EXAM_EDIT_BEFORE_FOLDER_ID");
  if (direct) return direct;
  const editParentId = await resolveDriveExamEditParentFolderId(drive);
  if (!editParentId) return null;
  const folderName = env("GOOGLE_DRIVE_EXAM_EDIT_BEFORE_FOLDER_NAME") || "시험지 편집 전";
  return findChildFolderId(drive, editParentId, folderName);
}

export async function resolveDriveExamEditAfterFolderId(
  drive: drive_v3.Drive,
): Promise<string | null> {
  const direct = env("GOOGLE_DRIVE_EXAM_EDIT_AFTER_FOLDER_ID");
  if (direct) return direct;
  const editParentId = await resolveDriveExamEditParentFolderId(drive);
  if (!editParentId) return null;
  const folderName = env("GOOGLE_DRIVE_EXAM_EDIT_AFTER_FOLDER_NAME") || "시험지 편집 후";
  return findChildFolderId(drive, editParentId, folderName);
}

/** @deprecated 폴더 구조 변경으로 시험지 편집 전 경로로 대체됨. 호환을 위해 유지. */
export async function resolveDriveExamOriginalsFolderId(
  drive: drive_v3.Drive,
): Promise<string | null> {
  return resolveDriveExamEditBeforeFolderId(drive);
}

/**
 * 「휴지통」 폴더 ID.
 * 시험지 편집 탭에서 작업 끝난 원본을 옮기는 위치 (Drive 시스템 휴지통과는 별개).
 *
 * 검색 순서:
 *  1) GOOGLE_DRIVE_TRASH_FOLDER_ID (env 직접 ID)
 *  2) 「분석용 자료/시험지 편집/휴지통」  — 시험지 편집 워크플로 안에 모은 신구조
 *  3) 「해설제작/휴지통」                — 루트 직속 구구조 (호환)
 *  ENV: GOOGLE_DRIVE_TRASH_FOLDER_NAME (기본 "휴지통")
 */
export async function resolveDriveTrashFolderId(
  drive: drive_v3.Drive,
): Promise<string | null> {
  const direct = env("GOOGLE_DRIVE_TRASH_FOLDER_ID");
  if (direct) return direct;
  const folderName = env("GOOGLE_DRIVE_TRASH_FOLDER_NAME") || "휴지통";

  // 1차: 「분석용 자료/시험지 편집」 안에서 찾기 (현재 사용자 구조)
  const editParentId = await resolveDriveExamEditParentFolderId(drive);
  if (editParentId) {
    const inEdit = await findChildFolderId(drive, editParentId, folderName);
    if (inEdit) return inEdit;
  }

  // 2차: 「해설제작」 루트 직속 (구구조 호환)
  const parentId = await resolveDriveParentFolderId(drive);
  return findChildFolderId(drive, parentId, folderName);
}

/**
 * Drive 파일을 다른 폴더로 이동.
 * 기존 부모를 모두 제거하고 destFolderId 만 부여 — 「하나의 진짜 위치」 유지.
 */
export async function moveDriveFileToFolder(
  drive: drive_v3.Drive,
  fileId: string,
  destFolderId: string,
): Promise<{ id: string; name: string }> {
  const meta = await drive.files.get({ fileId, fields: "id, name, parents" });
  const oldParents = (meta.data.parents ?? []).join(",");
  const updated = await drive.files.update({
    fileId,
    addParents: destFolderId,
    removeParents: oldParents || undefined,
    fields: "id, name, parents",
  });
  return {
    id: updated.data.id ?? fileId,
    name: updated.data.name ?? meta.data.name ?? "(unnamed)",
  };
}

export async function uploadBufferToDriveFolder(params: {
  folderId: string;
  fileName: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<{ id: string; name: string; webViewLink: string }> {
  const drive = getDriveClient();
  const { Readable } = await import("node:stream");
  const stream = Readable.from(params.buffer);
  const res = await drive.files.create({
    requestBody: {
      name: params.fileName,
      parents: [params.folderId],
    },
    media: {
      mimeType: params.mimeType,
      body: stream,
    },
    fields: "id, name, webViewLink",
  });
  const id = res.data.id;
  const name = res.data.name ?? params.fileName;
  if (!id) throw new Error("Drive 업로드 응답에 file id가 없습니다.");
  const webViewLink = res.data.webViewLink ?? `https://drive.google.com/file/d/${id}/view`;
  return { id, name, webViewLink };
}

export async function listDriveExamFiles(allowedExtensions: Set<string>): Promise<string[]> {
  const drive = getDriveClient();
  const folderId = await resolveDriveExamsFolderId(drive);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(name)",
    pageSize: 1000,
  });
  const out: string[] = [];
  for (const f of res.data.files ?? []) {
    const n = f.name ?? "";
    if (!n) continue;
    const ext = path.extname(n).toLowerCase();
    if (allowedExtensions.has(ext)) out.push(n);
  }
  return out;
}

export type DriveFileMeta = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  size: number | null;
  /**
   * Drive 가 자동 생성한 썸네일의 직접 URL (lh3.googleusercontent.com).
   *  - 시간제한 토큰이 박힌 서명 URL — 보통 수 시간 유효
   *  - URL 끝의 `=s220` 등을 다른 사이즈로 치환해 재요청 가능 (예: =s320, =s1600)
   *  - 클라이언트 `<img>` 가 직접 사용 → 서버 프록시 hop 1 회 절약 → 거의 즉시 표시
   *  - 만료/실패 시 `/api/drive/thumb?fileId=…` 프록시로 fallback
   */
  thumbnailLink: string | null;
};

/** 폴더 안 파일을 메타데이터까지 함께 반환 (UI Picker 용) */
export async function listDriveFolderFiles(
  folderId: string,
  allowedExtensions?: Set<string>,
): Promise<DriveFileMeta[]> {
  const drive = getDriveClient();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id, name, mimeType, modifiedTime, size, thumbnailLink)",
    orderBy: "modifiedTime desc",
    pageSize: 1000,
  });
  const out: DriveFileMeta[] = [];
  for (const f of res.data.files ?? []) {
    const n = f.name ?? "";
    if (!n) continue;
    if (allowedExtensions) {
      const ext = path.extname(n).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;
    }
    out.push({
      id: f.id ?? "",
      name: n,
      mimeType: f.mimeType ?? "application/octet-stream",
      modifiedTime: f.modifiedTime ?? null,
      size: f.size ? Number(f.size) : null,
      thumbnailLink: f.thumbnailLink ?? null,
    });
  }
  return out.filter((f) => f.id);
}

/**
 * 폴더 트리를 재귀로 훑어 파일 목록을 반환.
 *  - 각 파일에 `pathSegments` (하위 폴더명 배열) 부여 → "분석용 자료/시중교재/foo.pdf" 같이 출처 태깅 가능
 *  - 깊이 무한 재귀 방지를 위해 maxDepth (기본 4)
 */
export type DriveFileMetaWithPath = DriveFileMeta & { pathSegments: string[] };

export async function listDriveFolderFilesRecursive(
  rootFolderId: string,
  allowedExtensions?: Set<string>,
  maxDepth = 4,
): Promise<DriveFileMetaWithPath[]> {
  const drive = getDriveClient();
  const out: DriveFileMetaWithPath[] = [];

  async function walk(folderId: string, segments: string[], depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "files(id, name, mimeType, modifiedTime, size)",
      orderBy: "modifiedTime desc",
      pageSize: 1000,
    });
    for (const f of res.data.files ?? []) {
      const id = f.id ?? "";
      const name = f.name ?? "";
      if (!id || !name) continue;
      if (f.mimeType === "application/vnd.google-apps.folder") {
        await walk(id, [...segments, name], depth + 1);
        continue;
      }
      if (allowedExtensions) {
        const ext = path.extname(name).toLowerCase();
        if (!allowedExtensions.has(ext)) continue;
      }
      out.push({
        id,
        name,
        mimeType: f.mimeType ?? "application/octet-stream",
        modifiedTime: f.modifiedTime ?? null,
        size: f.size ? Number(f.size) : null,
        thumbnailLink: null, // 재귀 list 는 thumbnailLink 미사용 (분석자료 등) — 필요시 별도 호출
        pathSegments: segments,
      });
    }
  }

  await walk(rootFolderId, [], 0);
  return out;
}

/** ID 기반 다운로드 — 폴더 의존 없이 임의 위치 파일 가져오기 */
export async function downloadDriveFileById(
  fileId: string,
): Promise<{ buffer: Buffer; mimeType: string; name: string }> {
  const drive = getDriveClient();
  const meta = await drive.files.get({ fileId, fields: "name, mimeType" });
  const name = meta.data.name ?? fileId;
  const mimeType = meta.data.mimeType ?? "application/octet-stream";
  const dest = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  const buffer = await streamToBuffer(dest.data as NodeJS.ReadableStream);
  return { buffer, mimeType, name };
}

export async function downloadDriveExamFileByName(
  fileName: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const drive = getDriveClient();
  const folderId = await resolveDriveExamsFolderId(drive);
  const q = `name='${escapeDriveQueryString(fileName)}' and '${folderId}' in parents and trashed=false`;
  const found = await drive.files.list({ q, fields: "files(id)", pageSize: 2 });
  const id = found.data.files?.[0]?.id;
  if (!id) throw new Error(`Drive 시험지 폴더에 파일이 없습니다: ${fileName}`);

  const dest = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "stream" });
  const buffer = await streamToBuffer(dest.data as NodeJS.ReadableStream);
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
  };
  const mimeType = mimeTypes[ext] || "application/octet-stream";
  return { buffer, mimeType };
}
