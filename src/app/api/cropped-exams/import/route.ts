import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import JSZip from "jszip";
import { CROPPED_EXAMS_DIR_NAME } from "@/lib/outputPaths";
import { getPngOrJpegDimensionsFromBuffer } from "@/lib/imageDimensionsFromBuffer";

const IMAGE_EXT = /\.(png|jpe?g|jpeg)$/i;

type ManifestItem = { questionNo: string; pageLabel: string; file: string };
type Manifest = {
  examName?: string;
  items?: ManifestItem[];
};

function safeBundleName(name: string) {
  const n = path.normalize(name).replace(/^(\.\.(\/|\\|$))+/, "");
  if (n.includes("..") || path.isAbsolute(n)) return null;
  if (/[/\\]/.test(n)) return null;
  return n;
}

function parseQuestionFromFileName(fileName: string): { questionNo: string; pageLabel: string } {
  const base = path.basename(fileName, path.extname(fileName));
  const m = base.match(/^q(\d+)_(.+)$/i);
  if (m) {
    return { questionNo: String(Number.parseInt(m[1]!, 10)), pageLabel: m[2] || "크롭" };
  }
  return { questionNo: "1", pageLabel: base || "크롭" };
}

async function collectImageBuffersFromDir(dirPath: string): Promise<Array<{ relativePath: string; buffer: Buffer }>> {
  const out: Array<{ relativePath: string; buffer: Buffer }> = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dirPath, e.name);
    if (e.isDirectory()) continue;
    if (!IMAGE_EXT.test(e.name)) continue;
    const buffer = await fs.readFile(full);
    out.push({ relativePath: e.name, buffer });
  }
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "ko"));
  return out;
}

type ImportBody = { name: string; kind: "zip" | "folder" };

type ImageEntryRow = {
  relativePath: string;
  buffer: Buffer;
  questionNo: string;
  pageLabel: string;
};

async function loadBundleImageRows(params: {
  kind: "zip" | "folder";
  targetPath: string;
  safe: string;
}): Promise<{ rows: ImageEntryRow[]; examName: string }> {
  const { kind, targetPath, safe } = params;
  let examName = safe.replace(/\.zip$/i, "");
  const rows: ImageEntryRow[] = [];

  if (kind === "folder") {
    let st;
    try {
      st = await fs.stat(targetPath);
    } catch {
      throw new Error("FOLDER_NOT_FOUND");
    }
    if (!st.isDirectory()) {
      throw new Error("NOT_A_DIRECTORY");
    }

    const manifestPath = path.join(targetPath, "manifest.json");
    let manifest: Manifest | null = null;
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      manifest = JSON.parse(raw) as Manifest;
    } catch {
      manifest = null;
    }
    if (manifest?.examName) examName = manifest.examName;

    const buffers = await collectImageBuffersFromDir(targetPath);
    const byFile = new Map((manifest?.items ?? []).map((it) => [it.file, it]));

    for (const { relativePath, buffer } of buffers) {
      const meta = byFile.get(relativePath);
      const parsed = parseQuestionFromFileName(relativePath);
      rows.push({
        relativePath,
        buffer,
        questionNo: meta?.questionNo ?? parsed.questionNo,
        pageLabel: meta?.pageLabel ?? parsed.pageLabel,
      });
    }
    return { rows, examName };
  }

  const zipPath = targetPath.endsWith(".zip") ? targetPath : `${targetPath}.zip`;
  let st;
  try {
    st = await fs.stat(zipPath);
  } catch {
    throw new Error("ZIP_NOT_FOUND");
  }
  if (!st.isFile()) {
    throw new Error("NOT_A_ZIP_FILE");
  }

  const zipBuffer = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(zipBuffer);
  const names = Object.keys(zip.files)
    .filter((n) => !zip.files[n]?.dir && IMAGE_EXT.test(n))
    .sort((a, b) => a.localeCompare(b, "ko"));

  let manifest: Manifest | null = null;
  const manifestFile = zip.file("manifest.json");
  if (manifestFile) {
    try {
      const txt = await manifestFile.async("string");
      manifest = JSON.parse(txt) as Manifest;
    } catch {
      manifest = null;
    }
  }
  if (manifest?.examName) examName = manifest.examName;

  const byFile = new Map((manifest?.items ?? []).map((it) => [it.file, it]));

  for (const name of names) {
    const f = zip.file(name);
    if (!f) continue;
    const buffer = Buffer.from(await f.async("uint8array"));
    const base = path.basename(name);
    const meta = byFile.get(base) ?? byFile.get(name);
    const parsed = parseQuestionFromFileName(base);
    rows.push({
      relativePath: base,
      buffer,
      questionNo: meta?.questionNo ?? parsed.questionNo,
      pageLabel: meta?.pageLabel ?? parsed.pageLabel,
    });
  }
  return { rows, examName };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ImportBody;
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    const kind = body.kind === "zip" || body.kind === "folder" ? body.kind : null;
    if (!rawName || !kind) {
      return NextResponse.json({ error: "name 과 kind(zip|folder)가 필요합니다." }, { status: 400 });
    }
    if (kind === "zip" && !/\.zip$/i.test(rawName)) {
      return NextResponse.json({ error: "ZIP 묶음은 파일 이름이 .zip 으로 끝나야 합니다." }, { status: 400 });
    }

    const safe = safeBundleName(rawName);
    if (!safe) {
      return NextResponse.json({ error: "잘못된 묶음 이름입니다." }, { status: 400 });
    }

    const root = path.join(process.cwd(), CROPPED_EXAMS_DIR_NAME);
    const targetPath = path.join(root, safe);

    let loaded: { rows: ImageEntryRow[]; examName: string };
    try {
      loaded = await loadBundleImageRows({ kind, targetPath, safe });
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      if (code === "FOLDER_NOT_FOUND") {
        return NextResponse.json({ error: "폴더를 찾을 수 없습니다." }, { status: 404 });
      }
      if (code === "NOT_A_DIRECTORY") {
        return NextResponse.json({ error: "폴더가 아닙니다." }, { status: 400 });
      }
      if (code === "ZIP_NOT_FOUND") {
        return NextResponse.json({ error: "ZIP 파일을 찾을 수 없습니다." }, { status: 404 });
      }
      if (code === "NOT_A_ZIP_FILE") {
        return NextResponse.json({ error: "ZIP이 아닙니다." }, { status: 400 });
      }
      throw e;
    }
    const imageEntries = loaded.rows;
    const examName = loaded.examName;

    if (imageEntries.length === 0) {
      return NextResponse.json(
        { error: "PNG/JPEG 이미지가 묶음 안에 없습니다. (webp 등은 앱에서 PNG/JPEG로 두면 됩니다)" },
        { status: 400 },
      );
    }

    const items = [];
    for (let idx = 0; idx < imageEntries.length; idx += 1) {
      const entry = imageEntries[idx];
      const dim = getPngOrJpegDimensionsFromBuffer(entry.buffer);
      if (!dim) {
        return NextResponse.json(
          { error: `이미지 크기를 읽지 못했습니다( PNG/JPEG 만 지원 ): ${entry.relativePath}` },
          { status: 400 },
        );
      }
      const { width, height } = dim;
      items.push({
        id: `import-${Date.now()}-${idx}`,
        questionNo: entry.questionNo,
        pageLabel: entry.pageLabel,
        pdfPage: 1,
        imageBase64: entry.buffer.toString("base64"),
        imageMimeType:
          path.extname(entry.relativePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg",
        diagramImages: [] as Array<{ imageBase64: string; mimeType: string }>,
        crop: { unit: "px" as const, x: 0, y: 0, width, height },
        diagramCrops: [],
        standaloneImageNatural: { width, height },
      });
    }

    items.sort(
      (a, b) => Number.parseInt(String(a.questionNo), 10) - Number.parseInt(String(b.questionNo), 10),
    );
    const renumbered = items.map((it, i) => ({
      ...it,
      questionNo: String(i + 1),
    }));

    return NextResponse.json({
      examName,
      itemCount: renumbered.length,
      items: renumbered,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    console.error("cropped-exams import:", message, error);
    return NextResponse.json({ error: `묶음 불러오기 실패: ${message}` }, { status: 500 });
  }
}
