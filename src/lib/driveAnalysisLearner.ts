/**
 * driveAnalysisLearner.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  Google Drive 「해설제작/분석용 자료」 폴더의 PDF/이미지를 읽어
 *  ReferenceRecord 배열로 변환한다. /auto 의 RAG 검색이 다음 호출부터
 *  이 자료를 자동으로 참고 예시로 활용한다.
 *
 *  추출은 Gemini multimodal (한국어 시험지 친화 프롬프트) 사용.
 *  파일별로 in-memory cache 를 두어, 같은 파일은 modifiedTime 변경 전까지
 *  재호출하지 않는다. (Railway 콜드 스타트 시 1회 비용 발생)
 *
 *  사용처: src/app/api/auto-pipeline/route.ts 의 getRetriever() — 첫 호출 시
 *           kb.jsonl 로드 후 이 모듈로 추가 자료를 합쳐 인덱싱.
 *  강제 재동기화: POST /api/drive/analysis/sync
 * ────────────────────────────────────────────────────────────────────────────
 */
import path from "node:path";
import {
  getDriveClient,
  isGoogleDriveConfigured,
  resolveDriveAnalysisFolderId,
  listDriveFolderFilesRecursive,
  downloadDriveFileById,
} from "./googleDrive";
import { extractTextWithGeminiVision, isGeminiVisionAvailable } from "./geminiVisionExtract";
import type { ReferenceRecord } from "./referenceRetriever";

type CacheEntry = {
  modifiedTime: string | null;
  records: ReferenceRecord[];
};

const fileCache = new Map<string, CacheEntry>(); // key = drive fileId

const ALLOWED_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

export type AnalysisLearnSummary = {
  configured: boolean;
  folderResolved: boolean;
  totalFiles: number;
  newOrChanged: number;
  records: number;
  errors: string[];
  /** 서브폴더(시중교재 / 개인자료 등) 별 파일 수 */
  bySubfolder: Record<string, number>;
};

/**
 * 분석용 자료 폴더의 모든 파일을 ReferenceRecord 로 변환해 반환.
 * 캐시된 파일은 재추출하지 않고 재사용.
 */
export async function loadDriveAnalysisRecords(): Promise<{
  records: ReferenceRecord[];
  summary: AnalysisLearnSummary;
}> {
  const summary: AnalysisLearnSummary = {
    configured: false,
    folderResolved: false,
    totalFiles: 0,
    newOrChanged: 0,
    records: 0,
    errors: [],
    bySubfolder: {},
  };

  if (!isGoogleDriveConfigured()) {
    return { records: [], summary };
  }
  summary.configured = true;

  if (!isGeminiVisionAvailable()) {
    summary.errors.push("GEMINI_API_KEY 미설정 — 분석용 자료를 텍스트로 변환할 수 없습니다.");
    return { records: [], summary };
  }

  let drive: ReturnType<typeof getDriveClient>;
  try {
    drive = getDriveClient();
  } catch (e) {
    summary.errors.push(`Drive 클라이언트 초기화 실패: ${(e as Error).message}`);
    return { records: [], summary };
  }

  const folderId = await resolveDriveAnalysisFolderId(drive);
  if (!folderId) {
    summary.errors.push("「분석용 자료」 폴더를 찾지 못했습니다 (선택 기능 — 만들지 않으면 동작 안 함).");
    return { records: [], summary };
  }
  summary.folderResolved = true;

  let files;
  try {
    files = await listDriveFolderFilesRecursive(folderId, ALLOWED_EXTS);
  } catch (e) {
    summary.errors.push(`분석용 자료 폴더 목록 조회 실패: ${(e as Error).message}`);
    return { records: [], summary };
  }
  summary.totalFiles = files.length;
  // 서브폴더별 파일 수 집계
  for (const f of files) {
    const key = f.pathSegments.length === 0 ? "(루트)" : f.pathSegments.join(" / ");
    summary.bySubfolder[key] = (summary.bySubfolder[key] ?? 0) + 1;
  }

  const all: ReferenceRecord[] = [];
  for (const f of files) {
    const cached = fileCache.get(f.id);
    if (cached && cached.modifiedTime === f.modifiedTime) {
      all.push(...cached.records);
      continue;
    }
    try {
      const { buffer, mimeType } = await downloadDriveFileById(f.id);
      const ext = path.extname(f.name).toLowerCase();
      const effectiveMime =
        mimeType ||
        (ext === ".pdf"
          ? "application/pdf"
          : ext === ".png"
            ? "image/png"
            : "image/jpeg");
      const v = await extractTextWithGeminiVision(buffer.toString("base64"), effectiveMime);
      if (!v.ok) {
        summary.errors.push(`${f.name}: ${v.error}`);
        continue;
      }
      const records = splitTextIntoRecords(f.id, f.name, f.pathSegments, v.text);
      fileCache.set(f.id, { modifiedTime: f.modifiedTime, records });
      all.push(...records);
      summary.newOrChanged += 1;
    } catch (e) {
      summary.errors.push(`${f.name}: ${(e as Error).message}`);
    }
  }

  summary.records = all.length;
  return { records: all, summary };
}

/** 캐시 강제 무효화 — sync 엔드포인트가 사용 */
export function invalidateAnalysisCache(): void {
  fileCache.clear();
}

/**
 * 추출된 텍스트를 적당한 단위로 잘라 ReferenceRecord 로 만든다.
 * 단위:
 *   - `[문항 N]` 헤더가 있으면 문항 단위
 *   - 그 외엔 빈 줄 2개 단위 chunk (최대 1500자)
 */
function splitTextIntoRecords(
  fileId: string,
  fileName: string,
  pathSegments: string[],
  text: string,
): ReferenceRecord[] {
  const cleaned = text.trim();
  if (!cleaned) return [];

  // 문항 헤더 분리
  const labeled = cleaned.match(/\[문항\s*\d+\][\s\S]*?(?=\[문항\s*\d+\]|$)/g);
  if (labeled && labeled.length >= 2) {
    return labeled.map((chunk, idx) => buildRecord(fileId, fileName, pathSegments, idx, chunk.trim()));
  }

  // 문항 헤더가 없는 경우 — 1500자 단위 chunk
  const chunks: string[] = [];
  const MAX = 1500;
  let buf = "";
  for (const para of cleaned.split(/\n\s*\n+/)) {
    if (!para.trim()) continue;
    if ((buf + "\n\n" + para).length > MAX && buf) {
      chunks.push(buf.trim());
      buf = para;
    } else {
      buf = buf ? buf + "\n\n" + para : para;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  if (chunks.length === 0) return [];
  return chunks.map((chunk, idx) => buildRecord(fileId, fileName, pathSegments, idx, chunk));
}

function buildRecord(
  fileId: string,
  fileName: string,
  pathSegments: string[],
  idx: number,
  content: string,
): ReferenceRecord {
  // 서브폴더(시중교재 / 개인자료 등)는 출처에 명시해 RAG 디버깅 시 어디서 매칭됐는지 추적 가능
  const subPath = pathSegments.length > 0 ? `${pathSegments.join("/")}/` : "";
  return {
    id: `drive:${fileId}#${idx}`,
    source: `drive/분석용자료/${subPath}${fileName}`,
    answer: "",
    problem_hint: `${subPath}${fileName} (참고자료 #${idx + 1})`,
    content,
    equations: extractEquationsHeuristic(content),
  };
}

function extractEquationsHeuristic(text: string): string[] {
  const out: string[] = [];
  const blockRe = /\$\$([\s\S]+?)\$\$/g;
  const inlineRe = /\$([^$\n]+)\$/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) out.push(m[1].trim());
  while ((m = inlineRe.exec(text)) !== null) out.push(m[1].trim());
  return Array.from(new Set(out)).slice(0, 12);
}
