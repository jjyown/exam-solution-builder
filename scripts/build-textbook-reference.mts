import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import dotenv from "dotenv";

const SOURCE_EXT = /\.(png|jpe?g|webp|gif|pdf)$/i;

type Cli = {
  inputDir: string;
  outDir: string;
  force: boolean;
};

function parseArgs(argv: string[]): Cli {
  let inputDir = "./교재 입력";
  let outDir = "./교재 참고자료";
  let force = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) {
      inputDir = argv[i + 1];
      i += 1;
    } else if (a === "--output" && argv[i + 1]) {
      outDir = argv[i + 1];
      i += 1;
    } else if (a === "--force") {
      force = true;
    }
  }
  return { inputDir, outDir, force };
}

async function walkImages(dir: string, out: string[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkImages(full, out);
      continue;
    }
    if (e.isFile() && SOURCE_EXT.test(e.name)) out.push(full);
  }
}

function parseMetaFromRelativePath(relImagePath: string) {
  const normalized = relImagePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const unit = parts[0] || "미분류단원";
  const type = parts[1] || "미분류유형";
  const difficulty = parts[2] || "미분류난이도";
  return { unit, type, difficulty };
}

function isPdf(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".pdf";
}

async function renderPdfFirstPageToPng(pdfAbs: string, cacheDir: string): Promise<string> {
  await fs.mkdir(cacheDir, { recursive: true });
  const outPng = path.join(cacheDir, `${path.parse(pdfAbs).name}.page1.png`);
  const py = `
import pypdfium2 as pdfium
pdf_path = r'''${pdfAbs.replace(/\\/g, "\\\\")}'''
out_path = r'''${outPng.replace(/\\/g, "\\\\")}'''
pdf = pdfium.PdfDocument(pdf_path)
page = pdf[0]
bitmap = page.render(scale=2.0)
bitmap.to_pil().save(out_path)
`;
  const r = spawnSync("python", ["-c", py], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || "PDF 렌더 실패").trim());
  }
  return outPng;
}

async function main() {
  dotenv.config({ path: path.join(process.cwd(), ".env.local") });
  const ocrMod = await import("../src/lib/recognition/textbookReferenceOcr.ts");
  const buildTextbookReferenceMarkdown = ocrMod.buildTextbookReferenceMarkdown;
  const ocrTextbookReferenceImage = ocrMod.ocrTextbookReferenceImage;
  const cli = parseArgs(process.argv);
  const cwd = process.cwd();
  const inputAbs = path.isAbsolute(cli.inputDir) ? cli.inputDir : path.join(cwd, cli.inputDir);
  const outAbs = path.isAbsolute(cli.outDir) ? cli.outDir : path.join(cwd, cli.outDir);

  const images: string[] = [];
  await walkImages(inputAbs, images);
  if (images.length === 0) {
    console.error(`[textbook-ref] OCR 대상 파일(이미지/PDF)이 없습니다: ${inputAbs}`);
    process.exit(1);
  }

  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  const pdfRenderCacheDir = path.join(outAbs, "_tmp_pdf_pages");
  for (const abs of images) {
    const rel = path.relative(inputAbs, abs).replace(/\\/g, "/");
    const meta = parseMetaFromRelativePath(rel);
    const outDir = path.join(outAbs, meta.unit, meta.type, meta.difficulty);
    const outPath = path.join(outDir, `${path.parse(abs).name}.md`);

    if (!cli.force) {
      try {
        await fs.access(outPath);
        skipCount += 1;
        console.log(`[textbook-ref] 스킵(기존 md): ${path.relative(cwd, outPath)}`);
        continue;
      } catch {
        // 새 파일 생성 계속 진행
      }
    }

    let sourceForOcr = abs;
    try {
      if (isPdf(abs)) {
        sourceForOcr = await renderPdfFirstPageToPng(abs, pdfRenderCacheDir);
      }
    } catch (e) {
      failCount += 1;
      console.warn(`[textbook-ref] 실패: ${rel} - PDF 페이지 렌더 실패: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const result = await ocrTextbookReferenceImage(sourceForOcr);
    if (!result.ok) {
      failCount += 1;
      console.warn(`[textbook-ref] 실패: ${rel} - ${result.message}`);
      continue;
    }
    const md = buildTextbookReferenceMarkdown(
      {
        unit: meta.unit,
        type: meta.type,
        difficulty: meta.difficulty,
        sourceImage: rel,
      },
      result.text,
    );
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(outPath, md, "utf8");
    okCount += 1;
    console.log(`[textbook-ref] 생성: ${path.relative(cwd, outPath)} (conf=${result.confidence ?? "n/a"})`);
  }

  // PDF 중간 렌더 캐시는 실행 종료 시 정리한다.
  await fs.rm(pdfRenderCacheDir, { recursive: true, force: true }).catch(() => {});
  console.log(`[textbook-ref] 완료: 성공 ${okCount}, 스킵 ${skipCount}, 실패 ${failCount}, 총 ${images.length}`);
}

void main();
