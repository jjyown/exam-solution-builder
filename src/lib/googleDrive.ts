import { google } from "googleapis";
import type { drive_v3 } from "googleapis";

const DEFAULT_PARENT_FOLDER_NAME = "해설제작";
const DEFAULT_EXAMS_FOLDER_NAME = "시험지";
const DEFAULT_COMPLETED_FOLDER_NAME = "작업완료";

function env(key: string) {
  return process.env[key];
}

function hasGoogleDriveEnv() {
  return Boolean(
    env("GOOGLE_CLIENT_ID") &&
      env("GOOGLE_CLIENT_SECRET") &&
      env("GOOGLE_REFRESH_TOKEN"),
  );
}

function getDriveFoldersFromEnv() {
  return {
    parentFolderName: env("GOOGLE_DRIVE_PARENT_FOLDER_NAME") ?? DEFAULT_PARENT_FOLDER_NAME,
    examsFolderName: env("GOOGLE_DRIVE_EXAMS_FOLDER_NAME") ?? DEFAULT_EXAMS_FOLDER_NAME,
    completedFolderName:
      env("GOOGLE_DRIVE_COMPLETED_FOLDER_NAME") ?? DEFAULT_COMPLETED_FOLDER_NAME,
  };
}

function escapeDriveQueryString(value: string) {
  // Drive API q string 에서 작은따옴표가 있으면 escape 필요
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

let driveClient: drive_v3.Drive | null = null;

function getDriveClient(): drive_v3.Drive {
  if (!hasGoogleDriveEnv()) {
    throw new Error(
      "Google Drive 환경변수가 설정되지 않았습니다. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN을 Vercel 환경변수에 추가해 주세요.",
    );
  }

  if (driveClient) return driveClient;

  const oauth2Client = new google.auth.OAuth2({
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
  });
  oauth2Client.setCredentials({
    refresh_token: env("GOOGLE_REFRESH_TOKEN"),
  });

  driveClient = google.drive({ version: "v3", auth: oauth2Client });
  return driveClient;
}

async function findFolderIdByName(name: string, parentFolderId?: string) {
  const drive = getDriveClient();
  const { parentFolderName } = getDriveFoldersFromEnv();

  // name 검색은 반드시 folder mimeType 조건을 포함
  const base = [
    "mimeType = 'application/vnd.google-apps.folder'",
    `name = '${escapeDriveQueryString(name)}'`,
    "trashed = false",
  ];

  // parentFolderId가 주어지면 해당 parent 내에서만 찾습니다.
  if (parentFolderId) base.push(`'${parentFolderId}' in parents`);
  // parentFolderId가 없으면 폴더 이름만으로(Drive 전체) 찾습니다.
  // 같은 이름이 여러 개면 첫 번째를 사용합니다.

  const q = base.join(" and ");
  const res = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 10,
    spaces: "drive",
    supportsAllDrives: true,
  });

  const files = res.data.files ?? [];
  if (files.length === 0) {
    throw new Error(
      `Drive 폴더를 찾지 못했습니다: name="${name}"${parentFolderId ? ` parentId=${parentFolderId}` : ""}`,
    );
  }

  // 같은 이름 폴더가 여러 개인 경우가 생기면 첫 번째를 사용합니다.
  // (원칙적으로 폴더 이름이 유일하다는 전제)
  return files[0].id as string;
}

async function getExamAndCompletedFolderIds() {
  const { parentFolderName, examsFolderName, completedFolderName } =
    getDriveFoldersFromEnv();

  const parentId = await findFolderIdByName(parentFolderName);
  const examsId = await findFolderIdByName(examsFolderName, parentId);
  const completedId = await findFolderIdByName(completedFolderName, parentId);

  return { parentId, examsId, completedId };
}

function getExtensionLower(name: string) {
  const idx = name.lastIndexOf(".");
  if (idx === -1) return "";
  return name.slice(idx).toLowerCase();
}

export async function listExamFiles(allowedExtensions: Set<string>) {
  const drive = getDriveClient();
  const { examsId } = await getExamAndCompletedFolderIds();

  const res = await drive.files.list({
    q: `'${examsId}' in parents and trashed = false`,
    fields: "files(id,name,mimeType)",
    pageSize: 1000,
    spaces: "drive",
    supportsAllDrives: true,
  });

  const files = res.data.files ?? [];
  return files
    .filter((f) => f.id && f.name)
    .filter((f) => (f.mimeType ?? "") !== "application/vnd.google-apps.folder")
    .filter((f) => allowedExtensions.has(getExtensionLower(f.name as string)))
    .map((f) => f.name as string);
}

export async function downloadExamFileByName(fileName: string) {
  const drive = getDriveClient();
  const { examsId } = await getExamAndCompletedFolderIds();

  const safeName = fileName.trim();
  if (!safeName || safeName.includes("/") || safeName.includes("\\") || safeName.includes("..")) {
    throw new Error("잘못된 파일 이름입니다.");
  }

  // 파일 ID 찾기(정확히 name 일치)
  const q = [
    `'${examsId}' in parents`,
    `name = '${escapeDriveQueryString(safeName)}'`,
    "trashed = false",
    "mimeType != 'application/vnd.google-apps.folder'",
  ].join(" and ");

  const listRes = await drive.files.list({
    q,
    fields: "files(id,name,mimeType)",
    pageSize: 5,
    spaces: "drive",
    supportsAllDrives: true,
  });
  const candidates = listRes.data.files ?? [];
  if (candidates.length === 0) {
    throw new Error(`시험지 파일을 찾을 수 없습니다: ${safeName}`);
  }

  const file = candidates[0];
  const fileId = file.id as string;
  const mimeType = file.mimeType ?? "application/octet-stream";

  const mediaRes = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" as any },
  );

  const buffer = await streamToBuffer(mediaRes.data as unknown as NodeJS.ReadableStream);
  return { buffer, mimeType, fileName: safeName };
}

export async function uploadCompletedDocx(buffer: Buffer, fileName: string) {
  const drive = getDriveClient();
  const { completedId } = await getExamAndCompletedFolderIds();

  const mimeType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [completedId],
    },
    media: {
      mimeType,
      body: buffer,
    },
    fields: "id,name",
    supportsAllDrives: true,
  });

  return {
    id: created.data.id,
    name: created.data.name,
  };
}

export function isGoogleDriveConfigured() {
  return hasGoogleDriveEnv();
}

