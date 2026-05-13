/**
 * textbookDriveBuildRunner.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  Drive 「분석용 자료」 아래 시중교재 / 시험지 원안 폴더의 PDF 들을 페이지 단위
 *  로 풀어 Gemini Vision 으로 OCR 한 결과를 책별 작업 폴더에 영구 저장하는
 *  **공통 로직**. CLI 스크립트(scripts/textbook-drive-build.mts) 와 자동 실행
 *  스케줄러(textbookDriveBuildAutoRun.ts) 둘 다 이 함수를 호출한다.
 *
 *  설계 결정:
 *   - PDF 페이지 렌더링은 Node 내장 `pdf-to-img` (pdfjs 기반, 네이티브 의존성 X).
 *     Python(pypdfium2) 의존성을 제거해 Railway 빌드(Nixpacks)가 단순해진다.
 *   - 폴더 우선순위: 시중교재 먼저 → 새 작업 없으면 시험지 원안. CLI 와 동일.
 *   - 로컬 미러 + Drive 업로드 양쪽 — 로컬 retriever 가 walk 해서 RAG 자동 합산.
 *   - 비용: gemini-2.0-flash 페이지당 ~$0.0001.
 *
 *  주의:
 *   - 대용량 PDF (300MB+) 도 안전: pdf-to-img 는 페이지 lazy iteration 이라 메모리
 *     상에 한 페이지씩만 올림.
 *   - 한 책 처리 시간 ≈ 페이지수 × (~3초 OCR + 업로드 0.5초). 300페이지 ≈ 17분.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  getDriveClient,
  resolveDriveAnalysisFolderId,
  listDriveFolderFiles,
  findOrCreateChildFolder,
  uploadBufferToDriveFolder,
  downloadDriveFileById,
} from "./googleDrive";
import { extractTextbookPageWithGeminiVision } from "./geminiVisionExtract";

// pdf-to-img 는 @napi-rs/canvas 네이티브 모듈에 의존 — 모듈 로드 시점에 바이너리
// 동적 로드를 시도한다. Railway Linux 환경에서 로드 실패 시 모듈 전체가 import
// 단계에서 죽으면 디버깅 어려움. lazy 로 감싸 에러 메시지를 잡고 자동 실행이 통째로
// 중단되지 않게 한다.
async function loadPdfRenderer(): Promise<typeof import("pdf-to-img").pdf> {
  const mod = await import("pdf-to-img");
  return mod.pdf;
}

export type TextbookDriveBuildOptions = {
  /** 책 이름 필터 (부분 일치). 없으면 폴더 안 모든 PDF. */
  bookFilter?: string | null;
  /** Drive PDF ID 정확 매칭 (UI 에서 체크박스로 선택). bookFilter 보다 우선. */
  bookIds?: string[];
  /** 처리할 폴더 범위 — 기본 'both' (시중교재 → 시험지 원안 자동 체인).
   *  'textbook' = 시중교재만, 'exam' = 시험지 원안만. /textbook-ocr UI 에서 'textbook' 사용. */
  folderScope?: "textbook" | "exam" | "both";
  /** 책당 최대 페이지 (0 또는 미지정 = 무제한). 테스트용. */
  maxPages?: number;
  /** 이미 처리된 책도 강제 재처리. */
  force?: boolean;
  /** 로그 출력 콜백 (없으면 console.log). */
  log?: (msg: string) => void;
};

export type FolderResult = {
  label: string;
  driveName: string;
  found: number;
  processedBooks: number;
  skippedBooks: number;
};

export type TextbookDriveBuildResult = {
  byFolder: FolderResult[];
  totalProcessedBooks: number;
  totalSkippedBooks: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

type Manifest = {
  bookName: string;
  pdfFileId: string;
  pdfModifiedTime: string | null;
  totalPages: number;
  processedPages: number;
  ocrModel: string;
  builtAt: string;
  pageStatuses: Array<{ page: number; ok: boolean; bytes?: number; error?: string }>;
};

const FOLDER_PRIORITY: Array<{ driveName: string; mirrorSub: string; label: string }> = [
  { driveName: "시중교재", mirrorSub: "시중교재", label: "시중교재" },
  { driveName: "시험지 원안", mirrorSub: "시험지 원안", label: "시험지 원안" },
];

function safeStem(pdfName: string): string {
  return pdfName.replace(/\.pdf$/i, "");
}

function pagePadded(pageNo: number): string {
  return String(pageNo).padStart(3, "0");
}

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

function buildPageMd(meta: {
  bookName: string;
  pageNo: number;
  ocrModel: string;
  ocrText: string;
  folderLabel: string;
}): string {
  return [
    "---",
    `book: ${meta.bookName}`,
    `page: ${meta.pageNo}`,
    `ocrModel: ${meta.ocrModel}`,
    `unit: ${meta.folderLabel}`,
    `type: ${meta.bookName}`,
    `difficulty: 미분류난이도`,
    `sourceImage: ${meta.bookName}/pages/page${pagePadded(meta.pageNo)}.png`,
    "---",
    "",
    "## OCR_본문",
    "",
    meta.ocrText.trim(),
    "",
  ].join("\n");
}

/**
 * 한 폴더(시중교재 또는 시험지 원안) 안의 PDF 들을 페이지 분할 + OCR 처리.
 */
async function processFolder(args: {
  analysisRootId: string;
  driveName: string;
  mirrorSub: string;
  label: string;
  opts: TextbookDriveBuildOptions;
  log: (m: string) => void;
}): Promise<FolderResult> {
  const { analysisRootId, driveName, mirrorSub, label, opts, log } = args;
  const folderId = await findOrCreateChildFolder(analysisRootId, driveName);
  const pdfFiles = (await listDriveFolderFiles(folderId, new Set([".pdf"])))
    .filter((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (pdfFiles.length === 0) {
    log(`[${label}] 폴더에 PDF 가 없습니다.`);
    return { label, driveName, found: 0, processedBooks: 0, skippedBooks: 0 };
  }

  // 매칭 우선순위: bookIds (정확 ID) > bookFilter (부분 일치) > 전체.
  // bookIds 는 /textbook-ocr UI 가 사용 — 사용자가 체크박스로 선택한 책만 처리.
  const targets = (() => {
    if (opts.bookIds && opts.bookIds.length > 0) {
      return pdfFiles.filter((f) => opts.bookIds!.includes(f.id));
    }
    if (opts.bookFilter) {
      return pdfFiles.filter((f) => f.name.includes(opts.bookFilter!));
    }
    return pdfFiles;
  })();
  if (targets.length === 0) {
    return { label, driveName, found: pdfFiles.length, processedBooks: 0, skippedBooks: 0 };
  }

  log(`\n━━━ [${label}] 대상 ${targets.length}건 (전체 ${pdfFiles.length}건 중) ━━━`);
  if (opts.maxPages && opts.maxPages > 0) {
    log(`[${label}] (테스트) 책당 최대 ${opts.maxPages} 페이지`);
  }

  const localMirrorRoot = path.join(process.cwd(), "교재 참고자료", mirrorSub);
  await fs.mkdir(localMirrorRoot, { recursive: true });

  // ⚠️ 메모리 보호: 매우 큰 PDF 는 Railway Hobby (512MB~1GB RAM) 환경에서 OOM 위험.
  //  - downloadDriveFileById 가 전체 PDF 를 메모리 buffer 로 적재
  //  - pdf-to-img(pdfjs) 가 파싱·렌더에 추가 2~3배 메모리 사용
  //  - 300MB PDF → 약 900MB~1GB 피크 → Hobby 인스턴스 OOM 가능
  //  - 한도 초과 PDF 는 skip 하고 로그 — 사용자가 로컬에서 처리하도록 안내
  // 환경변수: TEXTBOOK_DRIVE_BUILD_MAX_PDF_MB (기본 150MB, 0 이면 무제한)
  const maxPdfMb = (() => {
    const raw = Number(process.env.TEXTBOOK_DRIVE_BUILD_MAX_PDF_MB);
    if (!Number.isFinite(raw)) return 150;
    if (raw === 0) return Number.MAX_SAFE_INTEGER;
    return raw;
  })();

  const ocrModel = "gemini-2.0-flash";
  let processedBooks = 0;
  let skippedBooks = 0;

  for (const pdf of targets) {
    const bookName = safeStem(pdf.name);
    const sizeBytes = Number(pdf.size ?? 0);
    const sizeMb = (sizeBytes / 1024 / 1024).toFixed(1);
    log(`\n=== 📘 [${label}] ${bookName} (${sizeMb}MB) ===`);

    // 큰 PDF 게이트 — Railway OOM 보호
    if (sizeBytes > maxPdfMb * 1024 * 1024) {
      log(
        `  [skip] PDF 크기 ${sizeMb}MB > 한도 ${maxPdfMb}MB — Railway OOM 보호. ` +
        `로컬에서 처리하거나 환경변수 TEXTBOOK_DRIVE_BUILD_MAX_PDF_MB 로 한도 상향.`,
      );
      skippedBooks += 1;
      continue;
    }

    const workFolderId = await findOrCreateChildFolder(folderId, bookName);
    const pagesFolderId = await findOrCreateChildFolder(workFolderId, "pages");
    const ocrFolderId = await findOrCreateChildFolder(workFolderId, "ocr");

    if (!opts.force) {
      const existingOcr = await listDriveFolderFiles(ocrFolderId, new Set([".md"]));
      if (existingOcr.length > 0) {
        log(`  [skip] 이미 ocr md ${existingOcr.length}개 — --force 로 덮어쓰기`);
        skippedBooks += 1;
        continue;
      }
    }

    const tmpRoot = path.join(os.tmpdir(), "textbook-drive-build", shortHash(bookName));
    await fs.mkdir(tmpRoot, { recursive: true });
    const localBookDir = path.join(localMirrorRoot, bookName);
    await fs.mkdir(localBookDir, { recursive: true });

    log(`  ↓ PDF 다운로드…`);
    const dl = await downloadDriveFileById(pdf.id);

    log(`  ▤ 페이지 렌더 (pdf-to-img)…`);
    let pdfDoc: Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfRenderer>>>>;
    try {
      const pdfFn = await loadPdfRenderer();
      pdfDoc = await pdfFn(dl.buffer, { scale: 2 });
    } catch (e) {
      const err = e as Error;
      log(`  ✗ PDF 렌더 실패: ${err.message}`);
      if (err.stack) log(`     stack: ${err.stack.split("\n").slice(0, 5).join(" | ")}`);
      continue;
    }
    const totalPages = pdfDoc.length;
    log(`  ✔ ${totalPages} 페이지 — OCR 시작`);

    const limit = opts.maxPages && opts.maxPages > 0 ? Math.min(opts.maxPages, totalPages) : totalPages;
    const manifest: Manifest = {
      bookName,
      pdfFileId: pdf.id,
      pdfModifiedTime: pdf.modifiedTime ?? null,
      totalPages,
      processedPages: 0,
      ocrModel,
      builtAt: new Date().toISOString(),
      pageStatuses: [],
    };

    // 페이지 단위 멱등 — 이미 OCR md 가 있는 페이지는 건너뜀.
    // force 옵션은 책 단위 SKIP 만 무시 (페이지 단위 멱등은 항상 적용).
    // 진짜 "처음부터 다시" 원하면 사용자가 Drive 에서 ocr/ 폴더 비우고 시작.
    const existingMdFiles = await listDriveFolderFiles(ocrFolderId, new Set([".md"]));
    const alreadyProcessedPages = new Set<number>();
    for (const f of existingMdFiles) {
      const m = /^page(\d+)\.md$/.exec(f.name);
      if (m) alreadyProcessedPages.add(parseInt(m[1] ?? "0", 10));
    }
    if (alreadyProcessedPages.size > 0) {
      log(`  ↻ 페이지 단위 멱등: 이미 OCR 된 ${alreadyProcessedPages.size}쪽 자동 skip`);
    }

    let pageNo = 0;
    for await (const pngBuf of pdfDoc) {
      pageNo += 1;
      if (pageNo > limit) break;

      // 페이지 단위 멱등 — 이미 처리된 페이지면 OCR/업로드 모두 skip (Gemini 호출 0)
      if (alreadyProcessedPages.has(pageNo)) {
        manifest.processedPages += 1;
        manifest.pageStatuses.push({ page: pageNo, ok: true, bytes: 0 });
        log(`  [page ${pagePadded(pageNo)}/${pagePadded(limit)}] ↷ skip (이미 처리됨)`);
        continue;
      }

      const pngName = `page${pagePadded(pageNo)}.png`;
      const mdName = `page${pagePadded(pageNo)}.md`;

      // 1) PNG 업로드
      try {
        await uploadBufferToDriveFolder({
          folderId: pagesFolderId,
          fileName: pngName,
          buffer: pngBuf,
          mimeType: "image/png",
        });
      } catch (e) {
        manifest.pageStatuses.push({
          page: pageNo,
          ok: false,
          error: `PNG 업로드 실패: ${(e as Error).message}`,
        });
        continue;
      }

      // 2) Gemini Vision OCR
      const base64 = pngBuf.toString("base64");
      const ocr = await extractTextbookPageWithGeminiVision(base64, "image/png");
      if (!ocr.ok) {
        manifest.pageStatuses.push({ page: pageNo, ok: false, error: ocr.error });
        log(`  [page ${pagePadded(pageNo)}/${pagePadded(limit)}] ✗ ${(ocr.error || "").slice(0, 60)}`);
        continue;
      }

      // 3) md 생성 + 업로드 + 로컬 미러
      const md = buildPageMd({
        bookName,
        pageNo,
        ocrModel: ocr.model || ocrModel,
        ocrText: ocr.text,
        folderLabel: label,
      });
      const mdBuf = Buffer.from(md, "utf8");

      try {
        await uploadBufferToDriveFolder({
          folderId: ocrFolderId,
          fileName: mdName,
          buffer: mdBuf,
          mimeType: "text/markdown",
        });
      } catch (e) {
        manifest.pageStatuses.push({
          page: pageNo,
          ok: false,
          error: `md 업로드 실패: ${(e as Error).message}`,
        });
        continue;
      }

      await fs.writeFile(path.join(localBookDir, mdName), md, "utf8").catch(() => {
        // 로컬 미러 실패는 무시 (Railway 등 read-only fs 환경 가능성)
      });

      manifest.processedPages += 1;
      manifest.pageStatuses.push({ page: pageNo, ok: true, bytes: mdBuf.byteLength });
      log(`  [page ${pagePadded(pageNo)}/${pagePadded(limit)}] ✓ ${ocr.model} ${mdBuf.byteLength}B`);

      // pdfjs/네이티브 캔버스가 external 메모리에 누적 — V8 GC 가 자동 회수 약함.
      // 10페이지마다 명시적 GC + event loop tick 양보. NODE_OPTIONS=--expose-gc 필요.
      if (pageNo % 10 === 0) {
        await new Promise((r) => setImmediate(r));
        if (typeof global.gc === "function") global.gc();
      }
    }

    const manifestJson = JSON.stringify(manifest, null, 2);
    await uploadBufferToDriveFolder({
      folderId: workFolderId,
      fileName: "manifest.json",
      buffer: Buffer.from(manifestJson, "utf8"),
      mimeType: "application/json",
    });
    await fs.writeFile(path.join(localBookDir, "manifest.json"), manifestJson, "utf8").catch(() => {});

    log(
      `  ✓ ${bookName}: ${manifest.processedPages}/${limit} 페이지 OCR (전체 ${totalPages} 페이지 중)`,
    );
    processedBooks += 1;

    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  return { label, driveName, found: pdfFiles.length, processedBooks, skippedBooks };
}

/**
 * 메인 엔트리 — 폴더 우선순위 자동 체인.
 *  - 시중교재 먼저 처리
 *  - 시중교재에 새 작업이 0건이면 → 시험지 원안도 자동 처리
 *  - 시중교재에 새 작업이 있으면 → 시험지 원안은 다음 실행으로
 */
export async function runTextbookDriveBuild(
  opts: TextbookDriveBuildOptions = {},
): Promise<TextbookDriveBuildResult> {
  const log = opts.log || ((m: string) => console.log(m));
  const startedAt = Date.now();

  const drive = getDriveClient();
  const analysisRootId = await resolveDriveAnalysisFolderId(drive);
  if (!analysisRootId) {
    throw new Error("「분석용 자료」 폴더를 찾지 못했습니다.");
  }

  // folderScope 옵션으로 처리 범위 제한. 기본 'both' = 현재 동작(시중교재 → 시험지 원안 자동 체인).
  // /textbook-ocr UI 에서 'textbook' 만 지정해 시험지 원안 자동 체인 차단.
  const folders = FOLDER_PRIORITY.filter((f) => {
    if (opts.folderScope === "textbook") return f.driveName === "시중교재";
    if (opts.folderScope === "exam") return f.driveName === "시험지 원안";
    return true;
  });

  log(`[textbook-drive-build] 폴더 우선순위: ${folders.map((f) => f.label).join(" → ")}`);

  const byFolder: FolderResult[] = [];
  let firstFolderHadWork = false;

  for (const folderSpec of folders) {
    if (folderSpec !== folders[0] && firstFolderHadWork) {
      log(
        `\n[${folderSpec.label}] 이번 실행 건너뜀 — 「${folders[0]!.label}」에 새 작업 있음. 다음 실행 시 처리.`,
      );
      byFolder.push({
        label: folderSpec.label,
        driveName: folderSpec.driveName,
        found: 0,
        processedBooks: 0,
        skippedBooks: 0,
      });
      continue;
    }

    const result = await processFolder({
      analysisRootId,
      driveName: folderSpec.driveName,
      mirrorSub: folderSpec.mirrorSub,
      label: folderSpec.label,
      opts,
      log,
    });
    byFolder.push(result);

    if (folderSpec === folders[0]) {
      firstFolderHadWork = result.processedBooks > 0;
    }

    log(
      `\n[${result.label}] 요약 — 발견 ${result.found}, 새로 처리 ${result.processedBooks}, 스킵 ${result.skippedBooks}`,
    );
  }

  const totalProcessedBooks = byFolder.reduce((s, b) => s + b.processedBooks, 0);
  const totalSkippedBooks = byFolder.reduce((s, b) => s + b.skippedBooks, 0);
  const finishedAt = Date.now();

  log(
    `\n[textbook-drive-build] 완료 — 새로 ${totalProcessedBooks}건 처리, ${totalSkippedBooks}건 스킵, ${((finishedAt - startedAt) / 1000).toFixed(1)}s`,
  );

  return {
    byFolder,
    totalProcessedBooks,
    totalSkippedBooks,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
  };
}
