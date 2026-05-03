/**
 * Manifest-Driven Markdown Assembly
 *
 * 크롭 번들의 manifest.json(SSOT)을 읽고, 문항##_API초안.md 초안에
 * 본문/도형 이미지 경로를 주입한 뒤 합본_편집용.md로 병합합니다.
 *
 * 사용:
 *   npm run build:md -- --workdir "./해설 작업중/[TEST] TEST1.pdf"
 *   npm run build:md -- --workdir ./폴더 --manifest ./폴더/manifest.json --images-dir ./폴더
 *
 * 전제:
 * - manifest는 웹앱 ZIP과 동일 형식: { items: [{ questionNo, file, diagramFiles? }] }
 * - 이미지 파일명은 manifest의 file / diagramFiles와 일치(보통 workdir 또는 images-dir 루트)
 * - 초안 파일명: 문항01_API초안.md (숫자 zero-padding, 정렬 기준)
 */
import { promises as fs } from "node:fs";
import path from "node:path";

type ManifestItem = {
  questionNo: string;
  pageLabel?: string;
  file: string;
  diagramFiles?: string[];
};

type Manifest = {
  exportedAt?: string;
  examName?: string;
  itemCount?: number;
  items: ManifestItem[];
};

type Cli = {
  workdir: string;
  manifestPath: string;
  imagesDir: string;
  outputPath: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Cli {
  let workdir = "";
  let manifestPath = "";
  let imagesDir = "";
  let outputPath = "";
  let dryRun = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--workdir" && argv[i + 1]) {
      workdir = argv[i + 1];
      i += 1;
    } else if (a === "--manifest" && argv[i + 1]) {
      manifestPath = argv[i + 1];
      i += 1;
    } else if (a === "--images-dir" && argv[i + 1]) {
      imagesDir = argv[i + 1];
      i += 1;
    } else if (a === "--output" && argv[i + 1]) {
      outputPath = argv[i + 1];
      i += 1;
    } else if (a === "--dry-run") {
      dryRun = true;
    }
  }
  const wd = workdir.trim() ? path.resolve(process.cwd(), workdir) : "";
  const manifest = manifestPath.trim()
    ? path.resolve(process.cwd(), manifestPath)
    : wd
      ? path.join(wd, "manifest.json")
      : "";
  const imgDir = imagesDir.trim() ? path.resolve(process.cwd(), imagesDir) : wd;
  const out = outputPath.trim()
    ? path.resolve(process.cwd(), outputPath)
    : wd
      ? path.join(wd, "합본_편집용.md")
      : "";
  return { workdir: wd, manifestPath: manifest, imagesDir: imgDir, outputPath: out, dryRun };
}

function toPosixRel(fromFile: string, toAbsolute: string): string {
  const rel = path.relative(path.dirname(fromFile), toAbsolute);
  if (!rel || rel === ".") return ".";
  return rel.split(path.sep).join("/");
}

function parseManifestJson(raw: string): Manifest {
  const data = JSON.parse(raw) as unknown;
  if (!data || typeof data !== "object" || !("items" in data)) {
    throw new Error("manifest.json: 최상위에 items 배열이 필요합니다.");
  }
  const items = (data as { items: unknown }).items;
  if (!Array.isArray(items)) {
    throw new Error("manifest.json: items가 배열이 아닙니다.");
  }
  const normalized: ManifestItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const questionNo = String(o.questionNo ?? "").trim();
    const file = String(o.file ?? "").trim();
    if (!questionNo || !file) continue;
    const diagramFiles = Array.isArray(o.diagramFiles)
      ? o.diagramFiles.map((x) => String(x).trim()).filter(Boolean)
      : undefined;
    normalized.push({
      questionNo,
      pageLabel: o.pageLabel != null ? String(o.pageLabel) : undefined,
      file,
      diagramFiles: diagramFiles?.length ? diagramFiles : undefined,
    });
  }
  return { ...(data as object), items: normalized } as Manifest;
}

/** manifest questionNo "1" → 정수 1 */
function manifestKeyToNum(q: string): number {
  const n = Number.parseInt(String(q).replace(/^\D+/, "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`manifest 항목 questionNo를 파싱할 수 없습니다: ${JSON.stringify(q)}`);
  }
  return n;
}

type AssetEntry = { main: string; figs: string[] };

function buildQuestionAssetMap(manifest: Manifest): Map<number, AssetEntry> {
  const map = new Map<number, AssetEntry>();
  for (const it of manifest.items) {
    const n = manifestKeyToNum(it.questionNo);
    map.set(n, {
      main: it.file,
      figs: it.diagramFiles?.length ? [...it.diagramFiles] : [],
    });
  }
  return map;
}

const DRAFT_RE = /^문항(\d+)_API초안\.md$/i;

function extractDraftOrder(filename: string): number | null {
  const m = filename.match(DRAFT_RE);
  if (!m?.[1]) return null;
  return Number.parseInt(m[1], 10);
}

async function collectDraftFiles(workdir: string): Promise<string[]> {
  const entries = await fs.readdir(workdir, { withFileTypes: true });
  const files: { full: string; n: number }[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const n = extractDraftOrder(e.name);
    if (n == null) continue;
    files.push({ full: path.join(workdir, e.name), n });
  }
  files.sort((a, b) => a.n - b.n);
  return files.map((x) => x.full);
}

/** 해당 문항 번호의 [문항 …] 헤더 직후에 본문 이미지 한 줄 삽입 */
function injectMainImage(
  lines: string[],
  questionNum: number,
  mdRelPath: string,
): string[] {
  const out = [...lines];
  const header = new RegExp(`^\\[문항\\s*0*${questionNum}\\s*\\]\\s*$`, "i");
  for (let i = 0; i < out.length; i += 1) {
    if (!header.test(out[i].trim())) continue;
    const next = out[i + 1]?.trim() ?? "";
    if (next.includes("![문제 원본]")) return out;
    out.splice(i + 1, 0, `![문제 원본](${mdRelPath})`);
    return out;
  }
  console.warn(`  [문항 ${questionNum}] 헤더를 찾지 못해 본문 이미지를 넣지 않았습니다.`);
  return out;
}

/** [해설] 단독 줄 바로 아래(빈 줄은 건너뜀)에 도형 이미지들 삽입 */
function injectFigureImages(lines: string[], mdRelPaths: string[]): string[] {
  if (mdRelPaths.length === 0) return lines;
  const out = [...lines];
  const explLine = /^\[해설\]\s*$/i;
  for (let i = 0; i < out.length; i += 1) {
    if (!explLine.test(out[i].trim())) continue;
    let j = i + 1;
    while (j < out.length && out[j].trim() === "") j += 1;
    if (out[j]?.trimStart().startsWith("![참고 도형")) {
      return out;
    }
    const block = mdRelPaths.map((p, k) => `![참고 도형 ${k + 1}](${p})`);
    out.splice(i + 1, 0, ...block);
    return out;
  }
  console.warn(`  [해설] 블록을 찾지 못해 도형 이미지를 넣지 않았습니다.`);
  return out;
}

function injectDraft(
  body: string,
  questionNum: number,
  assets: AssetEntry | undefined,
  outputFile: string,
  imagesAbsDir: string,
): string {
  let lines = body.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (assets) {
    const mainAbs = path.join(imagesAbsDir, assets.main);
    const mainRel = toPosixRel(outputFile, mainAbs);
    lines = injectMainImage(lines, questionNum, mainRel);
    const figRels = assets.figs.map((f) => toPosixRel(outputFile, path.join(imagesAbsDir, f)));
    lines = injectFigureImages(lines, figRels);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

async function main() {
  const cli = parseArgs(process.argv);
  if (!cli.workdir) {
    console.error(`필수: --workdir <초안·이미지가 있는 폴더>

예:
  npm run build:md -- --workdir "./해설 작업중/[TEST] TEST1.pdf"

선택:
  --manifest <경로>   (기본: <workdir>/manifest.json)
  --images-dir <경로> (기본: workdir — manifest의 file명이 이 폴더에 있다고 가정)
  --output <경로>     (기본: <workdir>/합본_편집용.md)
  --dry-run`);
    process.exit(1);
  }

  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(cli.manifestPath, "utf8");
  } catch {
    console.error(`manifest를 읽을 수 없습니다: ${cli.manifestPath}`);
    process.exit(1);
  }

  let manifest: Manifest;
  try {
    manifest = parseManifestJson(manifestRaw);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  const assetMap = buildQuestionAssetMap(manifest);
  const drafts = await collectDraftFiles(cli.workdir);
  if (drafts.length === 0) {
    console.error(`문항##_API초안.md 파일이 없습니다: ${cli.workdir}`);
    process.exit(1);
  }

  console.log(`manifest: ${cli.manifestPath} (문항 ${assetMap.size}개)`);
  console.log(`이미지 디렉터리: ${cli.imagesDir}`);
  console.log(`초안 ${drafts.length}개 병합 → ${cli.outputPath}`);

  const chunks: string[] = [];
  for (const draftPath of drafts) {
    const base = path.basename(draftPath);
    const n = extractDraftOrder(base);
    if (n == null) continue;
    const assets = assetMap.get(n);
    if (!assets) {
      console.warn(`  manifest에 문항 ${n} 없음 — 이미지 주입 생략 (${base})`);
    } else {
      for (const fname of [assets.main, ...assets.figs]) {
        const abs = path.join(cli.imagesDir, fname);
        try {
          await fs.access(abs);
        } catch {
          console.warn(`  파일 없음(경로 확인): ${abs}`);
        }
      }
    }

    const body = await fs.readFile(draftPath, "utf8");
    const merged = injectDraft(body, n, assets, cli.outputPath, cli.imagesDir);
    chunks.push(merged.trimEnd());
  }

  const finalOut = `${chunks.join("\n\n")}\n`;

  if (cli.dryRun) {
    console.log("--- dry-run: 미리보기(앞 800자) ---\n");
    console.log(finalOut.slice(0, 800));
    return;
  }

  await fs.writeFile(cli.outputPath, finalOut, "utf8");
  console.log(`작성 완료: ${cli.outputPath}`);
}

void main();
