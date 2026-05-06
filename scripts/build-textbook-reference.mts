import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  const parts = normalized.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { unit: "미분류단원", type: "미분류유형", difficulty: "미분류난이도" };
  }
  const last = parts[parts.length - 1]!;
  const isFile = SOURCE_EXT.test(last);
  const fileStem = isFile ? path.parse(last).name : "";
  const dirParts = isFile ? parts.slice(0, -1) : parts;

  let unit = "미분류단원";
  let type = "미분류유형";
  let difficulty = "미분류난이도";

  if (dirParts.length >= 3) {
    unit = dirParts[0]!;
    type = dirParts[1]!;
    difficulty = dirParts[2]!;
  } else if (dirParts.length === 2) {
    unit = dirParts[0]!;
    type = dirParts[1]!;
    difficulty = "미분류난이도";
  } else if (dirParts.length === 1) {
    unit = dirParts[0]!;
    if (isFile && fileStem) {
      type = fileStem;
      difficulty = "미분류난이도";
    }
  } else if (isFile && fileStem) {
    unit = "미분류단원";
    type = fileStem;
    difficulty = "미분류난이도";
  }

  return { unit, type, difficulty };
}

function isPdf(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".pdf";
}

function computePdfStem(pdfAbs: string): string {
  const h = createHash("sha1").update(pdfAbs).digest("hex").slice(0, 10);
  return `${path.parse(pdfAbs).name}.${h}`;
}

async function renderPdfPagesToPng(
  pdfAbs: string,
  cacheDir: string,
  stem: string,
): Promise<Array<{ pageNo: number; pngPath: string }>> {
  await fs.mkdir(cacheDir, { recursive: true });
  const py = `
import pypdfium2 as pdfium
import json
pdf_path = r'''${pdfAbs.replace(/\\/g, "\\\\")}'''
out_dir = r'''${cacheDir.replace(/\\/g, "\\\\")}'''
stem = r'''${stem.replace(/\\/g, "\\\\")}'''
pdf = pdfium.PdfDocument(pdf_path)
count = len(pdf)
for i in range(count):
    page = pdf[i]
    bitmap = page.render(scale=2.0)
    out_path = out_dir + "\\\\" + f"{stem}.page{i+1}.png"
    bitmap.to_pil().save(out_path)
print(json.dumps({"count": count}))
`;
  const r = spawnSync("python", ["-c", py], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || "PDF 렌더 실패").trim());
  }
  const raw = (r.stdout || "").trim();
  let count = 0;
  try {
    count = Number(JSON.parse(raw).count || 0);
  } catch {
    count = 0;
  }
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error("PDF 페이지 수를 읽지 못했습니다.");
  }
  const out: Array<{ pageNo: number; pngPath: string }> = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({
      pageNo: i,
      pngPath: path.join(cacheDir, `${stem}.page${i}.png`),
    });
  }
  return out;
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
  let pageCount = 0;
  const pdfRenderCacheDir = path.join(outAbs, "_tmp_pdf_pages");
  for (const abs of images) {
    const rel = path.relative(inputAbs, abs).replace(/\\/g, "/");
    const meta = parseMetaFromRelativePath(rel);
    const outDir = path.join(outAbs, meta.unit, meta.type, meta.difficulty);
    const baseName = path.parse(abs).name;

    if (!isPdf(abs)) {
      const outPath = path.join(outDir, `${baseName}.md`);
      if (!cli.force) {
        try {
          await fs.access(outPath);
          skipCount += 1;
          pageCount += 1;
          console.log(`[textbook-ref] 스킵(기존 md): ${path.relative(cwd, outPath)}`);
          continue;
        } catch {
          // 새 파일 생성 계속 진행
        }
      }
      const result = await ocrTextbookReferenceImage(abs);
      if (!result.ok) {
        failCount += 1;
        pageCount += 1;
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
      pageCount += 1;
      console.log(`[textbook-ref] 생성: ${path.relative(cwd, outPath)} (conf=${result.confidence ?? "n/a"})`);
      continue;
    }

    const pdfStem = computePdfStem(abs);
    const pdfCacheDir = path.join(pdfRenderCacheDir, pdfStem);

    let skipPdf = false;
    if (!cli.force) {
      try {
        const entries = await fs.readdir(outDir, { withFileTypes: false });
        skipPdf = entries.some((n) => n.startsWith(`${pdfStem}.page`) && n.includes("_problem") && n.endsWith(".md"));
      } catch {
        skipPdf = false;
      }
    }

    if (skipPdf) {
      skipCount += 1;
      pageCount += 1;
      console.log(`[textbook-ref] 스킵(기존 문제 md 존재): ${rel} (stem=${pdfStem})`);
      continue;
    }

    let renderedPages: Array<{ pageNo: number; pngPath: string }> = [];
    try {
      renderedPages = await renderPdfPagesToPng(abs, pdfCacheDir, pdfStem);
    } catch (e) {
      failCount += 1;
      console.warn(`[textbook-ref] 실패: ${rel} - PDF 페이지 렌더 실패: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const splitScriptPath = path.join(cwd, "scripts", "textbook_page_split_mathpix.py");
    const splitArgs: string[] = [
      splitScriptPath,
      "--input",
      pdfCacheDir,
      "--output",
      outDir,
      "--unit",
      meta.unit,
      "--type",
      meta.type,
      "--difficulty",
      meta.difficulty,
      "--padding",
      "0.02",
    ];
    // 정답/해설 혼재 PDF에서 빠른정답 단독 세그먼트는 제외하고 해설 우선 매핑
    // (필요 시 split script에 --no-explanation-priority 로 비활성화 가능)
    if (cli.force) splitArgs.push("--force");

    const splitRun = spawnSync("python", splitArgs, { stdio: "inherit", shell: false });
    if (splitRun.status !== 0) {
      failCount += 1;
      pageCount += renderedPages.length;
      console.warn(`[textbook-ref] 실패: ${rel} - split script 실행 실패 (exit=${splitRun.status ?? "?"})`);
      continue;
    }

    okCount += 1;
    pageCount += renderedPages.length;
    console.log(`[textbook-ref] 생성: ${rel} (pdf pages=${renderedPages.length}, stem=${pdfStem})`);
  }

  // PDF 중간 렌더 캐시는 실행 종료 시 정리한다.
  await fs.rm(pdfRenderCacheDir, { recursive: true, force: true }).catch(() => {});
  console.log(
    `[textbook-ref] 완료: 성공 ${okCount}, 스킵 ${skipCount}, 실패 ${failCount}, 파일 ${images.length}, 페이지 ${pageCount}`,
  );
}

void main();
