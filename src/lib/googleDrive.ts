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

function getDriveClient(): drive_v3.Drive {
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

/** Railway 크롭 묶음(읽기 전용)이 있는 Drive 폴더 ID */
export async function resolveDriveExamsFolderId(drive: drive_v3.Drive): Promise<string> {
  const direct = env("GOOGLE_DRIVE_EXAMS_FOLDER_ID");
  if (direct) return direct;

  const parentFolderId = env("GOOGLE_DRIVE_PARENT_FOLDER_ID");
  const parentName = env("GOOGLE_DRIVE_PARENT_FOLDER_NAME") || "해설제작";
  const examsName = env("GOOGLE_DRIVE_EXAMS_FOLDER_NAME") || "시험지";

  let parentId = parentFolderId;
  if (!parentId) {
    const qRoot = `name='${escapeDriveQueryString(parentName)}' and 'root' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const rootRes = await drive.files.list({ q: qRoot, fields: "files(id)", pageSize: 1 });
    parentId = rootRes.data.files?.[0]?.id ?? "root";
  }

  const examsId = await findChildFolderId(drive, parentId, examsName);
  if (!examsId) {
    throw new Error(
      `Drive에서 시험지 폴더를 찾지 못했습니다. GOOGLE_DRIVE_EXAMS_FOLDER_ID 를 직접 지정하거나, 부모 「${parentName}」 아래 「${examsName}」 폴더를 만드세요.`,
    );
  }
  return examsId;
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
