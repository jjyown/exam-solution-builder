/**
 * textbookDriveReferenceLoader.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  Drive 「분석용 자료/시중교재」 와 「분석용 자료/시험지 원안」 아래 책별
 *  작업 폴더의 ocr/*.md 들을 다운로드해 ReferenceRecord[] 로 변환한다.
 *
 *  textbookReferenceLocalLoader 의 Drive 버전 — Railway 환경에서 로컬 파일
 *  시스템이 ephemeral 이라 로컬 미러를 신뢰할 수 없을 때 RAG 데이터의 진짜 출처.
 *
 *  성능:
 *   - md 파일은 작아서 (~5KB) 병렬 다운로드 안전.
 *   - 9권 × 300페이지 ≈ 2700 파일을 동시성 12 로 다운로드 → ~1 분 안에 끝.
 *   - 결과는 모듈 전역 캐시 (TTL 1시간).
 *
 *  비활성화:
 *   - TEXTBOOK_DRIVE_REFERENCE_DISABLED=true 환경변수로 끄기
 *   - Drive 미설정 시 자동 silent skip
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { drive_v3 } from "googleapis";
import { createHash } from "node:crypto";
import { getDriveClient, isGoogleDriveConfigured, resolveDriveAnalysisFolderId, downloadDriveFileById } from "./googleDrive";
import type { ReferenceRecord } from "./referenceRetriever";

const TARGET_ROOT_FOLDERS = ["시중교재", "시험지 원안"];
const DOWNLOAD_CONCURRENCY = (() => {
  const raw = Number(process.env.TEXTBOOK_DRIVE_DOWNLOAD_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 && raw <= 50 ? raw : 12;
})();
const CACHE_TTL_MS = (() => {
  const raw = Number(process.env.TEXTBOOK_DRIVE_REFERENCE_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60 * 60 * 1000; // 1시간
})();

type Cache = {
  records: ReferenceRecord[];
  fileCount: number;
  loadedAt: number;
};
let cache: Cache | null = null;
let inFlight: Promise<Cache> | null = null;

function isDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.TEXTBOOK_DRIVE_REFERENCE_DISABLED || "").trim());
}

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

function escapeQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findChildFolderId(
  drive: drive_v3.Drive,
  parentId: string,
  folderName: string,
): Promise<string | null> {
  const q = `name='${escapeQuery(folderName)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q, fields: "files(id)", pageSize: 5 });
  return res.data.files?.[0]?.id ?? null;
}

async function listChildFolders(
  drive: drive_v3.Drive,
  parentId: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
    pageSize: 1000,
  });
  const out: Array<{ id: string; name: string }> = [];
  for (const f of res.data.files ?? []) {
    if (f.id && f.name) out.push({ id: f.id, name: f.name });
  }
  return out;
}

async function listMdFiles(
  drive: drive_v3.Drive,
  folderId: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false and (mimeType='text/markdown' or name contains '.md')`,
    fields: "files(id, name)",
    pageSize: 1000,
  });
  const out: Array<{ id: string; name: string }> = [];
  for (const f of res.data.files ?? []) {
    if (f.id && f.name && f.name.toLowerCase().endsWith(".md")) {
      out.push({ id: f.id, name: f.name });
    }
  }
  return out;
}

type Frontmatter = {
  book?: string;
  page?: string;
  ocrModel?: string;
  unit?: string;
  type?: string;
  difficulty?: string;
  sourceImage?: string;
};

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fm: Frontmatter = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    fm[kv[1] as keyof Frontmatter] = kv[2];
  }
  return { fm, body: m[2] ?? "" };
}

function extractOcrBody(body: string): string {
  const idx = body.indexOf("## OCR_본문");
  if (idx < 0) return body.trim();
  return body.slice(idx + "## OCR_본문".length).replace(/^\s*\n/, "").trim();
}

/** 풀(promise.all) 동시성 제한 — 단순 배치 풀러. */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

async function buildRecord(file: {
  rootFolder: string;
  bookName: string;
  fileId: string;
  fileName: string;
}): Promise<ReferenceRecord | null> {
  try {
    const dl = await downloadDriveFileById(file.fileId);
    const raw = dl.buffer.toString("utf8");
    const { fm, body } = parseFrontmatter(raw);
    const ocr = extractOcrBody(body);
    if (ocr.length < 10) return null;

    const source = `drive/분석용자료/${file.rootFolder}/${file.bookName}/ocr/${file.fileName}`;
    const id = `textbook-drive-${shortHash(source)}`;
    const hintParts: string[] = [];
    if (fm.unit) hintParts.push(fm.unit);
    if (fm.type) hintParts.push(fm.type);
    if (fm.difficulty && !/미분류/.test(fm.difficulty)) hintParts.push(fm.difficulty);
    const problem_hint = hintParts.join(" ");

    return {
      id,
      source,
      answer: "",
      problem_hint,
      content: ocr,
      equations: [],
    };
  } catch {
    return null;
  }
}

async function loadFresh(): Promise<Cache> {
  if (isDisabled() || !isGoogleDriveConfigured()) {
    return { records: [], fileCount: 0, loadedAt: Date.now() };
  }

  const drive = getDriveClient();
  const analysisRootId = await resolveDriveAnalysisFolderId(drive);
  if (!analysisRootId) {
    return { records: [], fileCount: 0, loadedAt: Date.now() };
  }

  type Target = { rootFolder: string; bookName: string; fileId: string; fileName: string };
  const targets: Target[] = [];

  for (const rootName of TARGET_ROOT_FOLDERS) {
    const rootFolderId = await findChildFolderId(drive, analysisRootId, rootName);
    if (!rootFolderId) continue;

    const bookFolders = await listChildFolders(drive, rootFolderId);
    for (const book of bookFolders) {
      const ocrFolderId = await findChildFolderId(drive, book.id, "ocr");
      if (!ocrFolderId) continue;

      const mdFiles = await listMdFiles(drive, ocrFolderId);
      for (const md of mdFiles) {
        targets.push({
          rootFolder: rootName,
          bookName: book.name,
          fileId: md.id,
          fileName: md.name,
        });
      }
    }
  }

  if (targets.length === 0) {
    return { records: [], fileCount: 0, loadedAt: Date.now() };
  }

  const results = await mapConcurrent(targets, DOWNLOAD_CONCURRENCY, buildRecord);
  const records = results.filter((r): r is ReferenceRecord => r !== null);

  console.log(
    `[textbook-drive-loader] Drive 교재 OCR record ${records.length}개 로드 (md 파일 ${targets.length}개 스캔)`,
  );

  return { records, fileCount: targets.length, loadedAt: Date.now() };
}

/**
 * Drive 책별 ocr/*.md 들을 ReferenceRecord 로 반환. 캐시(1시간) + 동시 호출 합치기.
 */
export async function loadDriveTextbookReferenceRecords(): Promise<{
  records: ReferenceRecord[];
  fileCount: number;
}> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return { records: cache.records, fileCount: cache.fileCount };
  }
  if (inFlight) return inFlight.then((c) => ({ records: c.records, fileCount: c.fileCount }));

  inFlight = loadFresh()
    .then((c) => {
      cache = c;
      return c;
    })
    .catch((e) => {
      console.warn(
        `[textbook-drive-loader] 실패 — kb·로컬만으로 동작: ${e instanceof Error ? e.message : String(e)}`,
      );
      cache = { records: [], fileCount: 0, loadedAt: Date.now() };
      return cache;
    })
    .finally(() => {
      inFlight = null;
    });

  const result = await inFlight!;
  return { records: result.records, fileCount: result.fileCount };
}

/** 캐시 강제 무효화 — 새 책 처리 후 즉시 반영하고 싶을 때. */
export function resetDriveTextbookReferenceCache(): void {
  cache = null;
}
