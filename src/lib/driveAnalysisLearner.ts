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
import { isGeminiVisionAvailable } from "./geminiVisionExtract";
import { extractTextFromUploadedFile } from "./fileExtraction";
import { resolveMathpixCredentials } from "./mathpixV3Text";
import type { ReferenceRecord } from "./referenceRetriever";
import {
  fetchCachedRecords,
  persistRecordsForFile,
  pruneOrphanRecords,
} from "./analysisRecordsStore";

type CacheEntry = {
  modifiedTime: string | null;
  records: ReferenceRecord[];
};

const fileCache = new Map<string, CacheEntry>(); // key = drive fileId

const ALLOWED_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);

/**
 * 단일 파일 최대 크기 (바이트). 기본 35MB.
 * Gemini inlineData 한도(50MB) 안에서, base64 변환 시 추가 메모리(약 1.33배)를
 * 감안해 OOM 마진을 둔 값. 환경변수 ANALYSIS_FILE_MAX_MB 로 오버라이드 가능.
 */
const ANALYSIS_FILE_MAX_BYTES = (() => {
  const raw = Number(process.env.ANALYSIS_FILE_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 35;
  return mb * 1024 * 1024;
})();

/**
 * 너무 작은 파일은 의미 있는 텍스트가 없을 가능성 높음 — Mathpix 호출 절약.
 * 환경변수 ANALYSIS_FILE_MIN_KB 로 오버라이드 가능 (기본 30KB).
 */
const ANALYSIS_FILE_MIN_BYTES = (() => {
  const raw = Number(process.env.ANALYSIS_FILE_MIN_KB);
  const kb = Number.isFinite(raw) && raw >= 0 ? raw : 30;
  return kb * 1024;
})();

/**
 * 분석 대상 서브폴더 화이트리스트 — 「분석용 자료」 루트 직속 폴더 이름.
 * 다른 서브폴더(시험지 편집·휴지통 등) 의 파일은 분석 안 함 → Mathpix 호출 낭비 차단.
 *
 * **우선순위 순서**: 앞에 적힌 폴더 먼저 처리. 시중교재는 해설 제작 메인 참고자료이므로
 * 매쓰픽스 잔여가 떨어져도 먼저 끝나야 함.
 *
 * 환경변수: DRIVE_ANALYSIS_ALLOWED_ROOT_FOLDERS=시중교재,시험지 원안 (콤마 구분)
 */
const ALLOWED_ROOT_FOLDERS_PRIORITY: string[] = (() => {
  const env = process.env.DRIVE_ANALYSIS_ALLOWED_ROOT_FOLDERS?.trim();
  if (env) {
    return env.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return ["시중교재", "시험지 원안"]; // 디폴트: 시중교재 우선
})();
const ALLOWED_ROOT_FOLDERS = new Set(ALLOWED_ROOT_FOLDERS_PRIORITY);

/** Mathpix·Gemini 호출 동시 처리 수 — Hobby tier 안전 마진. */
const ANALYSIS_CONCURRENCY = (() => {
  const raw = Number(process.env.ANALYSIS_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 && raw <= 16 ? raw : 4;
})();

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

  // OCR 백엔드: Mathpix 또는 Gemini 중 하나는 있어야 함 (Mathpix 우선, 소진 시 Gemini 자동 폴백)
  if (!isGeminiVisionAvailable() && !resolveMathpixCredentials()) {
    summary.errors.push(
      "OCR 백엔드 미설정 — GEMINI_API_KEY 또는 MATHPIX_APP_ID/KEY 가 필요합니다.",
    );
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

  let allFiles;
  try {
    allFiles = await listDriveFolderFilesRecursive(folderId, ALLOWED_EXTS);
  } catch (e) {
    summary.errors.push(`분석용 자료 폴더 목록 조회 실패: ${(e as Error).message}`);
    return { records: [], summary };
  }

  // 폴더 화이트리스트 적용 — 시중교재·시험지 원안 외 폴더 제외 (Mathpix 호출 절약)
  const allowedFiles = allFiles.filter((f) => {
    const root = f.pathSegments[0];
    return root && ALLOWED_ROOT_FOLDERS.has(root);
  });

  // 우선순위 정렬 — ALLOWED_ROOT_FOLDERS_PRIORITY 앞쪽 폴더 먼저 처리
  // (시중교재 우선 — 해설 제작 메인 참고자료)
  const priorityIndex = new Map<string, number>(
    ALLOWED_ROOT_FOLDERS_PRIORITY.map((name, i) => [name, i]),
  );
  allowedFiles.sort((a, b) => {
    const ra = priorityIndex.get(a.pathSegments[0] ?? "") ?? 999;
    const rb = priorityIndex.get(b.pathSegments[0] ?? "") ?? 999;
    if (ra !== rb) return ra - rb;
    // 같은 폴더 안에선 modifiedTime 최신 먼저 (변경분 우선 흡수)
    return (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? "");
  });

  // 너무 작은 파일 스킵 — 의미 있는 본문이 거의 없을 확률 높음
  const files = allowedFiles.filter((f) => {
    if (typeof f.size === "number" && f.size < ANALYSIS_FILE_MIN_BYTES) {
      return false;
    }
    return true;
  });

  summary.totalFiles = files.length;
  // 서브폴더별 파일 수 집계 (필터 후 기준)
  for (const f of files) {
    const key = f.pathSegments.length === 0 ? "(루트)" : f.pathSegments.join(" / ");
    summary.bySubfolder[key] = (summary.bySubfolder[key] ?? 0) + 1;
  }

  /** 단일 파일 처리 — 캐시 → 다운로드 → OCR → Supabase 저장. */
  type DriveFileMeta = (typeof files)[number];
  async function processOneFile(f: DriveFileMeta): Promise<ReferenceRecord[]> {
    // 1) in-memory 캐시 적중
    const cached = fileCache.get(f.id);
    if (cached && cached.modifiedTime === f.modifiedTime) {
      return cached.records;
    }
    // 2) Supabase 영구 캐시 적중 — 재배포·재시작 후에도 OCR 안 함
    const persisted = await fetchCachedRecords(f.id, f.modifiedTime);
    if (persisted && persisted.length > 0) {
      fileCache.set(f.id, { modifiedTime: f.modifiedTime, records: persisted });
      return persisted;
    }
    // 3) OOM 방지: 너무 큰 파일은 download 자체를 skip
    if (typeof f.size === "number" && f.size > ANALYSIS_FILE_MAX_BYTES) {
      const mb = (f.size / (1024 * 1024)).toFixed(1);
      summary.errors.push(
        `${f.name}: ${mb}MB — ANALYSIS_FILE_MAX_MB(${(ANALYSIS_FILE_MAX_BYTES / 1024 / 1024) | 0}MB) 초과로 OCR skip.`,
      );
      return [];
    }
    // 4) 캐시 둘 다 miss → Mathpix 우선 → Gemini 폴백 OCR
    try {
      let buffer: Buffer | null = null;
      let base64: string | null = null;
      let effectiveMime: string;
      {
        const dl = await downloadDriveFileById(f.id);
        buffer = dl.buffer;
        const ext = path.extname(f.name).toLowerCase();
        effectiveMime =
          dl.mimeType ||
          (ext === ".pdf"
            ? "application/pdf"
            : ext === ".png"
              ? "image/png"
              : "image/jpeg");
        base64 = buffer.toString("base64");
        buffer = null; // GC 후보
      }
      const ext = path.extname(f.name).toLowerCase();
      const v = await extractTextFromUploadedFile({
        fileData: base64,
        fileName: f.name,
        fileType: effectiveMime || (ext === ".pdf" ? "application/pdf" : "image/jpeg"),
      });
      base64 = null;
      if (!v.ok) {
        summary.errors.push(`${f.name}: ${v.error}`);
        return [];
      }
      const records = splitTextIntoRecords(f.id, f.name, f.pathSegments, v.text);
      fileCache.set(f.id, { modifiedTime: f.modifiedTime, records });
      try {
        await persistRecordsForFile(f.id, f.modifiedTime, records);
      } catch {
        // silent
      }
      summary.newOrChanged += 1;
      return records;
    } catch (e) {
      summary.errors.push(`${f.name}: ${(e as Error).message}`);
      return [];
    }
  }

  // ── 동시 처리 pool ────────────────────────────────────────────────
  // - 정렬된 순서(시중교재 우선)대로 worker 가 dequeue
  // - 작업자 N 개가 병렬로 다음 파일을 가져와 처리
  // - 결과는 입력 순서대로 누적 (시중교재 records 가 앞쪽)
  const all: ReferenceRecord[] = [];
  let nextIdx = 0;
  await Promise.all(
    Array.from({ length: Math.min(ANALYSIS_CONCURRENCY, files.length) }, async () => {
      while (true) {
        const idx = nextIdx;
        nextIdx += 1;
        if (idx >= files.length) return;
        const records = await processOneFile(files[idx]);
        for (const r of records) all.push(r);
      }
    }),
  );

  // 별도 PDF 페어 매칭 (예: "쎈_대수_문제.pdf" + "쎈_대수_해설.pdf")
  // 같은 series 의 문제 record · 풀이 record 를 problem_no 로 join 해서
  // 문제 record 에 solution_text 를 채워 넣는다.
  const merged = mergePairedSeparatePdfs(all);

  // Drive 에서 삭제된 파일의 Supabase row 정리 (best-effort).
  // 화이트리스트 외 폴더 파일도 「존재」 한다고 보고 prune 대상에서 제외 (= allFiles 전체 ID).
  // → 사용자가 화이트리스트 바꿔도 옛 OCR 결과 보존, Drive 에서 진짜 삭제된 것만 정리.
  try {
    await pruneOrphanRecords(allFiles.map((f) => f.id));
  } catch {
    // silent
  }

  summary.records = merged.length;
  return { records: merged, summary };
}

/**
 * "쎈_문제.pdf" + "쎈_해설.pdf" 처럼 별도 PDF 로 올라온 페어를 파일명 휴리스틱으로
 * 묶고, 문제 record 의 solution_text 를 풀이 record 에서 가져와 채운다.
 * 이미 1:1 매핑된 record (problem_no 와 solution_text 가 같이 있는) 는 그대로 둔다.
 */
function mergePairedSeparatePdfs(records: ReferenceRecord[]): ReferenceRecord[] {
  type Bucket = { series: string; kind: "problem" | "solution"; records: ReferenceRecord[] };
  const buckets = new Map<string, Bucket>();

  for (const r of records) {
    if (r.solution_text) continue; // 이미 합본 페어링
    if (typeof r.problem_no !== "number") continue; // 페어링 가능한 row 만 후보
    const meta = inferSeriesAndKindFromSource(r.source);
    if (!meta) continue;
    const key = `${meta.series}::${meta.kind}`;
    const bucket = buckets.get(key) ?? { series: meta.series, kind: meta.kind, records: [] };
    bucket.records.push(r);
    buckets.set(key, bucket);
  }

  // 같은 series 의 problem ↔ solution 매핑
  const result = records.slice();
  const indexById = new Map(result.map((r, i) => [r.id, i] as const));
  const seriesNames = new Set<string>();
  for (const b of buckets.values()) seriesNames.add(b.series);

  for (const series of seriesNames) {
    const problemBucket = buckets.get(`${series}::problem`);
    const solutionBucket = buckets.get(`${series}::solution`);
    if (!problemBucket || !solutionBucket) continue;
    const solByNo = new Map<number, ReferenceRecord>();
    for (const s of solutionBucket.records) {
      if (typeof s.problem_no !== "number") continue;
      const exist = solByNo.get(s.problem_no);
      if (!exist || (s.content?.length ?? 0) > (exist.content?.length ?? 0)) {
        solByNo.set(s.problem_no, s);
      }
    }
    for (const p of problemBucket.records) {
      if (typeof p.problem_no !== "number") continue;
      const sol = solByNo.get(p.problem_no);
      if (!sol) continue;
      const idx = indexById.get(p.id);
      if (idx === undefined) continue;
      result[idx] = {
        ...p,
        solution_text: sol.content,
        solution_equations: sol.equations,
        pair_series: series,
        problem_hint: `${p.problem_hint} (풀이 페어 ✓)`,
      };
    }
  }
  return result;
}

/** "drive/분석용자료/시중교재/쎈_대수_문제.pdf" → { series: "쎈 대수", kind: "problem" } */
function inferSeriesAndKindFromSource(
  source: string,
): { series: string; kind: "problem" | "solution" } | null {
  // 파일명만 추출
  const filename = source.split("/").pop() ?? source;
  const lower = filename.toLowerCase();
  const isSolution = /해설|정답|answer|solution/.test(lower) || /해설|정답/.test(filename);
  const isProblem = /문제|기출|워크북|problem|question/.test(lower) || /문제|기출|워크북/.test(filename);
  if (!isSolution && !isProblem) return null;
  // 시리즈 이름 = 파일명에서 키워드/확장자/구분자 떼어낸 것
  let series = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_\s\-]?(문제|기출|워크북|problem|question|해설|정답|answer|solution)[_\s\-]?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!series) return null;
  return { series, kind: isSolution ? "solution" : "problem" };
}

/** 캐시 강제 무효화 — sync 엔드포인트가 사용 */
export function invalidateAnalysisCache(): void {
  fileCache.clear();
}

/**
 * 추출된 텍스트를 적당한 단위로 잘라 ReferenceRecord 로 만든다.
 *
 * 우선순위:
 *  1) [문항 N] + [해설 N] 또는 [해설] 섹션이 동시에 있으면 → 1:1 매핑된 페어 record
 *  2) 문항 번호 헤더만 있으면 → 문항 단위 chunk (풀이 없음)
 *  3) 둘 다 없으면 → 1500자 단위 chunk
 */
function splitTextIntoRecords(
  fileId: string,
  fileName: string,
  pathSegments: string[],
  text: string,
): ReferenceRecord[] {
  const cleaned = text.trim();
  if (!cleaned) return [];
  const subPath = pathSegments.length > 0 ? `${pathSegments.join("/")}/` : "";
  const sourcePath = `drive/분석용자료/${subPath}${fileName}`;

  // 1) 1:1 매핑 시도
  const paired = parseProblemSolutionPairs(cleaned);
  if (paired.length >= 2) {
    return paired.map((p) => ({
      id: `drive:${fileId}#${p.problem_no}`,
      source: sourcePath,
      answer: p.answer,
      problem_hint: `${subPath}${fileName} ${p.problem_no}번${p.solution ? " (풀이 포함)" : ""}`,
      content: p.question,
      equations: extractEquationsHeuristic(p.question),
      problem_no: p.problem_no,
      solution_text: p.solution || undefined,
      solution_equations: p.solution ? extractEquationsHeuristic(p.solution) : undefined,
    }));
  }

  // 2) 문항 헤더만 있는 경우 — 문항 단위 chunk
  const labeled = cleaned.match(/\[문항\s*\d+\][\s\S]*?(?=\[문항\s*\d+\]|$)/g);
  if (labeled && labeled.length >= 2) {
    return labeled.map((chunk, idx) =>
      buildRecord(fileId, fileName, pathSegments, idx, chunk.trim()),
    );
  }

  // 3) 헤더 없음 — 1500자 단위 chunk (옛 흐름)
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

/**
 * 텍스트에서 문항 N 과 해설 N 을 짝지어 추출.
 * 인식 헤더:
 *  - `[문항 N]`, `[해설 N]`
 *  - "1.", "1)", "1번" (앞 줄 시작에 위치)
 *  - "[해설]", "[정답 및 해설]", "정답 및 해설", "해설" 단독 줄 → 풀이 섹션 시작
 *
 * 빈 페이지·중복 페이지 안전:
 *  - 같은 N 의 풀이 여러 개면 가장 긴 것을 선택 (빈 페이지 무시)
 *  - 빈 풀이는 undefined 처리
 */
type Pair = {
  problem_no: number;
  question: string;
  solution: string;
  answer: string;
};

function parseProblemSolutionPairs(fullText: string): Pair[] {
  // 풀이 섹션 시작 마커 — 첫 번째 매치 위치를 분리점으로 사용
  const solutionSectionRe =
    /(?:^|\n)\s*(?:\[정답\s*및\s*해설\]|\[해설\]|정답\s*및\s*해설|해설)\s*\n/m;
  const solStartMatch = fullText.match(solutionSectionRe);
  let problemSection = fullText;
  let solutionSection = "";
  if (solStartMatch && solStartMatch.index !== undefined) {
    problemSection = fullText.slice(0, solStartMatch.index);
    solutionSection = fullText.slice(solStartMatch.index + solStartMatch[0].length);
  }

  const problems = parseNumberedItems(problemSection);
  if (problems.length < 2) return []; // 매핑 의미 없음 → 옛 흐름으로

  // 풀이 섹션이 없으면 — `[해설 N]` 인라인 마커가 본문에 흩어진 케이스 시도
  let solutions: { no: number; text: string }[] = [];
  if (solutionSection) {
    solutions = parseNumberedItems(solutionSection);
  } else {
    solutions = parseInlineSolutionMarkers(fullText);
  }

  // 같은 N 여러 개면 가장 긴 것 선택 (빈 페이지·중복 페이지 안전)
  const solMap = new Map<number, string>();
  for (const s of solutions) {
    const t = s.text.trim();
    if (!t) continue;
    const existing = solMap.get(s.no);
    if (!existing || t.length > existing.length) {
      solMap.set(s.no, t);
    }
  }

  return problems.map((p) => {
    const sol = solMap.get(p.no) || "";
    // 풀이에서 [정답] 라인 추출
    const answerMatch = sol.match(/\[정답\]\s*([^\n]+)/);
    return {
      problem_no: p.no,
      question: p.text,
      solution: sol,
      answer: answerMatch ? answerMatch[1].trim() : "",
    };
  });
}

/** "1.", "1)", "[문항 1]", "1번" 같은 번호 헤더로 문항을 분리. */
function parseNumberedItems(text: string): { no: number; text: string }[] {
  const re = /(?:^|\n)\s*(?:\[문항\s*(\d{1,3})\]|\[해설\s*(\d{1,3})\]|(\d{1,3})\s*[\.\)]|(\d{1,3})\s*번\s)/g;
  const matches: { no: number; start: number; headerEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const noStr = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!noStr) continue;
    const no = Number(noStr);
    if (!Number.isFinite(no) || no <= 0 || no > 100) continue;
    matches.push({ no, start: m.index, headerEnd: m.index + m[0].length });
  }
  if (matches.length === 0) return [];

  // 단조 증가 시퀀스 우선 (1, 2, 3, ...) 선택해 노이즈 제거
  const filtered = filterMonotonic(matches);

  const items: { no: number; text: string }[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const start = filtered[i].headerEnd;
    const end = i + 1 < filtered.length ? filtered[i + 1].start : text.length;
    items.push({ no: filtered[i].no, text: text.slice(start, end).trim() });
  }
  return items;
}

/** [해설 N] 마커가 본문 안에 흩어져 있는 케이스. 별도 풀이 섹션 없을 때 fallback. */
function parseInlineSolutionMarkers(text: string): { no: number; text: string }[] {
  const re = /\[해설\s*(\d{1,3})\]/g;
  const matches: { no: number; start: number; headerEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const no = Number(m[1]);
    if (!Number.isFinite(no) || no <= 0 || no > 100) continue;
    matches.push({ no, start: m.index, headerEnd: m.index + m[0].length });
  }
  return matches.map((mt, i) => {
    const start = mt.headerEnd;
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    return { no: mt.no, text: text.slice(start, end).trim() };
  });
}

/** 가장 긴 단조 증가 부분수열 선택 (1,2,3,... 흐름 우선). */
function filterMonotonic(
  list: { no: number; start: number; headerEnd: number }[],
): { no: number; start: number; headerEnd: number }[] {
  if (list.length === 0) return [];
  // DP: longest non-decreasing subsequence by no, position-ordered
  const n = list.length;
  const lengths = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  let bestEnd = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (list[j].no <= list[i].no && lengths[j] + 1 > lengths[i]) {
        lengths[i] = lengths[j] + 1;
        prev[i] = j;
      }
    }
    if (lengths[i] > lengths[bestEnd]) bestEnd = i;
  }
  const out: typeof list = [];
  for (let i = bestEnd; i !== -1; i = prev[i]) out.push(list[i]);
  out.reverse();
  return out;
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
