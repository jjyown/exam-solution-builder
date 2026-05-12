/**
 * textbook-drive-build.mts
 * ────────────────────────────────────────────────────────────────────────────
 *  Drive 「분석용 자료」 아래 시중교재 / 시험지 원안 폴더의 PDF 들을 페이지
 *  단위로 풀어 Gemini Vision 으로 OCR 한 결과를 책(또는 시험지)별 작업 폴더에
 *  영구 저장하는 로컬 빌더.
 *
 *  폴더 우선순위 (자동):
 *    1) 시중교재 먼저 처리 (skip 이미 끝난 책)
 *    2) 시중교재에 새 작업이 0건이면 → 시험지 원안도 같은 방식으로 자동 처리
 *    3) 시중교재에 새 작업이 있었으면 → 시험지 원안은 다음 실행으로 미룸
 *
 *  추가 교재 업로드 → 다음 실행에서 새 교재만 처리 → 새 교재 없을 때 자연스럽게
 *  시험지 원안 처리로 넘어가는 흐름.
 *
 *  목표 폴더 구조 (사용자 요청):
 *    분석용 자료/시중교재/
 *      ├─ 고1) 쎈 공통수학1 (22개정).pdf                ← 원본 (이미 있음)
 *      └─ 고1) 쎈 공통수학1 (22개정)/                   ← 새로 생성될 책별 작업 폴더
 *          ├─ pages/                                    ← 페이지 PNG (각 1장씩)
 *          ├─ ocr/                                      ← 페이지별 OCR md (frontmatter + 본문)
 *          └─ manifest.json                             ← 처리 메타
 *
 *  같은 ocr/*.md 를 로컬 「교재 참고자료/시중교재/<책>/」 에도 미러링한다.
 *  Phase 1 의 textbookReferenceLocalLoader 가 이 로컬 폴더를 walk 해서 RAG 에
 *  자동 합산하므로 별도 import 작업 불필요.
 *
 *  Mathpix 안 씀 — Gemini Vision (gemini-2.5-flash) 페이지당.
 *
 *  실행 예:
 *    npm run textbook:drive-build
 *    npm run textbook:drive-build -- --book "고1) 쎈 공통수학1 (22개정)"
 *    npm run textbook:drive-build -- --max-pages 3        # 테스트: 책당 3페이지만
 *    npm run textbook:drive-build -- --force              # 이미 처리된 책도 재처리
 *
 *  의존성 (로컬):
 *    pip install pypdfium2 pillow
 *
 *  비용 추정:
 *    gemini-2.5-flash ≈ $0.0005/페이지 → 300페이지 책 ≈ $0.15
 * ────────────────────────────────────────────────────────────────────────────
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import dotenv from "dotenv";

type Cli = {
  bookFilter: string | null;
  maxPages: number;
  force: boolean;
};

function parseArgs(argv: string[]): Cli {
  let bookFilter: string | null = null;
  let maxPages = 0;
  let force = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--book" && argv[i + 1]) {
      bookFilter = argv[i + 1]!;
      i += 1;
    } else if (a === "--max-pages" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) maxPages = Math.floor(n);
      i += 1;
    } else if (a === "--force") {
      force = true;
    }
  }
  return { bookFilter, maxPages, force };
}

function safeStem(pdfName: string): string {
  return pdfName.replace(/\.pdf$/i, "");
}

function pagePadded(pageNo: number): string {
  return String(pageNo).padStart(3, "0");
}

function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

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

/** PDF 파일을 페이지별 PNG 로 렌더링. pypdfium2 (pip install pypdfium2 pillow) 필요. */
function renderPdfPages(
  pdfAbs: string,
  outDir: string,
  scale: number = 2.0,
): Array<{ pageNo: number; pngPath: string }> {
  const py = `
import pypdfium2 as pdfium
import json, os
pdf_path = r'''${pdfAbs.replace(/\\/g, "\\\\")}'''
out_dir = r'''${outDir.replace(/\\/g, "\\\\")}'''
os.makedirs(out_dir, exist_ok=True)
pdf = pdfium.PdfDocument(pdf_path)
count = len(pdf)
for i in range(count):
    page = pdf[i]
    bitmap = page.render(scale=${scale})
    out_path = os.path.join(out_dir, f"page{i+1:03d}.png")
    bitmap.to_pil().save(out_path)
print(json.dumps({"count": count}))
`;
  const r = spawnSync("python", ["-c", py], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || "PDF 렌더 실패").trim());
  }
  let count = 0;
  try {
    count = Number(JSON.parse((r.stdout || "").trim()).count || 0);
  } catch {
    count = 0;
  }
  if (count <= 0) throw new Error("PDF 페이지 수를 읽지 못했습니다.");
  const out: Array<{ pageNo: number; pngPath: string }> = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({ pageNo: i, pngPath: path.join(outDir, `page${pagePadded(i)}.png`) });
  }
  return out;
}

function buildPageMd(meta: {
  bookName: string;
  pageNo: number;
  ocrModel: string;
  ocrText: string;
}): string {
  return [
    "---",
    `book: ${meta.bookName}`,
    `page: ${meta.pageNo}`,
    `ocrModel: ${meta.ocrModel}`,
    `unit: 시중교재`,
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
 * 폴더 우선순위 — 시중교재 우선, 시중교재에 새 작업이 없으면 시험지 원안도 자동 처리.
 *  - driveName  : Drive 「분석용 자료」 아래 폴더명
 *  - mirrorSub  : 로컬 「교재 참고자료/」 아래 미러 하위 디렉토리명 (RAG 자동 픽업)
 *  - label      : 로그 표시용 라벨
 */
const FOLDER_PRIORITY: Array<{ driveName: string; mirrorSub: string; label: string }> = [
  { driveName: "시중교재", mirrorSub: "시중교재", label: "시중교재" },
  { driveName: "시험지 원안", mirrorSub: "시험지 원안", label: "시험지 원안" },
];

type DriveDeps = {
  listDriveFolderFiles: (
    folderId: string,
    allowedExt?: Set<string>,
  ) => Promise<Array<{ id: string; name: string; modifiedTime: string | null; size: number | null }>>;
  findOrCreateChildFolder: (parentId: string, name: string) => Promise<string>;
  uploadBufferToDriveFolder: (params: {
    folderId: string;
    fileName: string;
    buffer: Buffer;
    mimeType: string;
  }) => Promise<{ id: string; name: string }>;
  downloadDriveFileById: (fileId: string) => Promise<{ buffer: Buffer }>;
  extractTextbookPageWithGeminiVision: (
    base64: string,
    mimeType: string,
  ) => Promise<{ ok: true; text: string; model: string; mimeType: string } | { ok: false; error: string }>;
};

/**
 * 한 폴더(시중교재 또는 시험지 원안) 안의 PDF 들을 페이지 분할 + OCR 처리.
 * 반환: { found 전체 PDF 수, processedBooks 새로 OCR 한 책 수, skippedBooks 이미 처리된 책 수 }
 */
async function processFolder(args: {
  analysisRootId: string;
  driveName: string;
  mirrorSub: string;
  label: string;
  cli: Cli;
  deps: DriveDeps;
}): Promise<{ found: number; processedBooks: number; skippedBooks: number }> {
  const { driveName, mirrorSub, label, cli, deps, analysisRootId } = args;
  const folderId = await deps.findOrCreateChildFolder(analysisRootId, driveName);
  const pdfFiles = (await deps.listDriveFolderFiles(folderId, new Set([".pdf"])))
    .filter((f) => f.name.toLowerCase().endsWith(".pdf"));
  if (pdfFiles.length === 0) {
    console.log(`[${label}] 폴더에 PDF 가 없습니다.`);
    return { found: 0, processedBooks: 0, skippedBooks: 0 };
  }

  const targets = cli.bookFilter
    ? pdfFiles.filter((f) => f.name.includes(cli.bookFilter!))
    : pdfFiles;
  if (targets.length === 0) {
    // --book 필터가 이 폴더와 안 맞음 — 다음 폴더로 (에러 아님)
    return { found: pdfFiles.length, processedBooks: 0, skippedBooks: 0 };
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`[${label}] 대상 ${targets.length}건 (전체 ${pdfFiles.length}건 중)`);
  if (cli.maxPages > 0) console.log(`[${label}] (테스트) 책당 최대 ${cli.maxPages} 페이지`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const localMirrorRoot = path.join(process.cwd(), "교재 참고자료", mirrorSub);
  await fs.mkdir(localMirrorRoot, { recursive: true });

  const ocrModel = "gemini-2.5-flash";
  let processedBooks = 0;
  let skippedBooks = 0;

  for (const pdf of targets) {
    const bookName = safeStem(pdf.name);
    const sizeMb = (Number(pdf.size ?? 0) / 1024 / 1024).toFixed(1);
    console.log(`\n=== 📘 ${bookName} (${sizeMb}MB) ===`);

    const workFolderId = await deps.findOrCreateChildFolder(folderId, bookName);
    const pagesFolderId = await deps.findOrCreateChildFolder(workFolderId, "pages");
    const ocrFolderId = await deps.findOrCreateChildFolder(workFolderId, "ocr");

    if (!cli.force) {
      const existingOcr = await deps.listDriveFolderFiles(ocrFolderId, new Set([".md"]));
      if (existingOcr.length > 0) {
        console.log(`  [skip] 이미 ocr md ${existingOcr.length}개 존재 — --force 로 덮어쓰기`);
        skippedBooks += 1;
        continue;
      }
    }

    const tmpRoot = path.join(os.tmpdir(), "textbook-drive-build", shortHash(bookName));
    await fs.mkdir(tmpRoot, { recursive: true });
    const localBookDir = path.join(localMirrorRoot, bookName);
    await fs.mkdir(localBookDir, { recursive: true });

    console.log(`  ↓ PDF 다운로드…`);
    const dl = await deps.downloadDriveFileById(pdf.id);
    const pdfLocalPath = path.join(tmpRoot, pdf.name);
    await fs.writeFile(pdfLocalPath, dl.buffer);

    console.log(`  ▤ 페이지 렌더 (pypdfium2)…`);
    const pagesLocalDir = path.join(tmpRoot, "pages");
    const rendered = renderPdfPages(pdfLocalPath, pagesLocalDir, 2.0);
    const totalPages = rendered.length;
    console.log(`  ✔ ${totalPages} 페이지 렌더 완료`);

    const limit = cli.maxPages > 0 ? Math.min(cli.maxPages, totalPages) : totalPages;
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

    for (let i = 0; i < limit; i += 1) {
      const { pageNo, pngPath } = rendered[i]!;
      const pngName = `page${pagePadded(pageNo)}.png`;
      const mdName = `page${pagePadded(pageNo)}.md`;

      let pngBuf: Buffer;
      try {
        pngBuf = await fs.readFile(pngPath);
      } catch (e) {
        manifest.pageStatuses.push({
          page: pageNo,
          ok: false,
          error: `PNG 읽기 실패: ${(e as Error).message}`,
        });
        continue;
      }

      try {
        await deps.uploadBufferToDriveFolder({
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

      const base64 = pngBuf.toString("base64");
      const ocr = await deps.extractTextbookPageWithGeminiVision(base64, "image/png");
      if (!ocr.ok) {
        manifest.pageStatuses.push({ page: pageNo, ok: false, error: ocr.error });
        process.stdout.write(
          `  [page ${pagePadded(pageNo)}/${pagePadded(limit)}] ✗ ${(ocr.error || "").slice(0, 60)}\n`,
        );
        continue;
      }

      const md = buildPageMd({
        bookName,
        pageNo,
        ocrModel: ocr.model || ocrModel,
        ocrText: ocr.text,
      });
      const mdBuf = Buffer.from(md, "utf8");

      try {
        await deps.uploadBufferToDriveFolder({
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

      try {
        await fs.writeFile(path.join(localBookDir, mdName), md, "utf8");
      } catch (e) {
        manifest.pageStatuses.push({
          page: pageNo,
          ok: true,
          bytes: mdBuf.byteLength,
          error: `로컬 미러 실패(무시): ${(e as Error).message}`,
        });
        process.stdout.write(
          `  [page ${pagePadded(pageNo)}/${pagePadded(limit)}] ✓ ${ocr.model} (로컬 미러 실패)\r`,
        );
        manifest.processedPages += 1;
        continue;
      }

      manifest.processedPages += 1;
      manifest.pageStatuses.push({ page: pageNo, ok: true, bytes: mdBuf.byteLength });
      process.stdout.write(
        `  [page ${pagePadded(pageNo)}/${pagePadded(limit)}] ✓ ${ocr.model} ${mdBuf.byteLength}B\r`,
      );
    }
    process.stdout.write("\n");

    const manifestJson = JSON.stringify(manifest, null, 2);
    await deps.uploadBufferToDriveFolder({
      folderId: workFolderId,
      fileName: "manifest.json",
      buffer: Buffer.from(manifestJson, "utf8"),
      mimeType: "application/json",
    });
    await fs.writeFile(path.join(localBookDir, "manifest.json"), manifestJson, "utf8").catch(() => {});

    console.log(
      `  ✓ ${bookName}: ${manifest.processedPages}/${limit} 페이지 OCR 성공 (전체 ${totalPages} 페이지 중)`,
    );
    processedBooks += 1;

    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  return { found: pdfFiles.length, processedBooks, skippedBooks };
}

async function main() {
  dotenv.config({ path: path.join(process.cwd(), ".env.local") });
  const cli = parseArgs(process.argv);

  const drive = await import("../src/lib/googleDrive.ts");
  const gemini = await import("../src/lib/geminiVisionExtract.ts");

  const driveClient = drive.getDriveClient();
  const analysisRootId = await drive.resolveDriveAnalysisFolderId(driveClient);
  if (!analysisRootId) {
    console.error("[textbook-drive-build] 「분석용 자료」 폴더를 찾지 못했습니다.");
    process.exit(1);
  }

  const deps: DriveDeps = {
    listDriveFolderFiles: drive.listDriveFolderFiles,
    findOrCreateChildFolder: drive.findOrCreateChildFolder,
    uploadBufferToDriveFolder: drive.uploadBufferToDriveFolder,
    downloadDriveFileById: drive.downloadDriveFileById,
    extractTextbookPageWithGeminiVision: gemini.extractTextbookPageWithGeminiVision,
  };

  console.log(
    `[textbook-drive-build] 폴더 우선순위: ${FOLDER_PRIORITY.map((f) => f.label).join(" → ")}`,
  );

  let totalProcessed = 0;
  let firstFolderHadWork = false;

  for (const folderSpec of FOLDER_PRIORITY) {
    // 시중교재 가 첫 폴더 — 새 작업이 있었으면 다음 폴더(시험지 원안) 는 다음 실행으로 미룸.
    if (folderSpec !== FOLDER_PRIORITY[0] && firstFolderHadWork) {
      console.log(
        `\n[${folderSpec.label}] 이번 실행에서는 건너뜀 — 「${FOLDER_PRIORITY[0]!.label}」 에서 새 작업이 있었기 때문. 다음 실행 시 자동 처리됩니다.`,
      );
      break;
    }

    const result = await processFolder({
      analysisRootId,
      driveName: folderSpec.driveName,
      mirrorSub: folderSpec.mirrorSub,
      label: folderSpec.label,
      cli,
      deps,
    });
    totalProcessed += result.processedBooks;
    console.log(
      `\n[${folderSpec.label}] 요약 — 전체 ${result.found}건, 새로 처리 ${result.processedBooks}건, 스킵 ${result.skippedBooks}건`,
    );
    if (folderSpec === FOLDER_PRIORITY[0]) {
      firstFolderHadWork = result.processedBooks > 0;
    }
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[textbook-drive-build] 완료 — 새로 처리 ${totalProcessed}건`);
  console.log("  ▷ Drive: 분석용 자료/<폴더>/<PDF>/{pages, ocr, manifest.json}");
  console.log("  ▷ 로컬:  교재 참고자료/<폴더>/<PDF>/*.md  ← retriever 자동 합산");
}

void main().catch((e) => {
  console.error(`[textbook-drive-build] 실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
