import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const MAX_ZIP_NEST = 5;

export type QuestionImage = {
  sourceLabel: string;
  ext: string;
  buffer: Buffer;
};

type ManifestItem = {
  questionNo?: string;
  file?: string;
  diagramFiles?: string[];
};

type ManifestPayload = {
  items?: ManifestItem[];
};

export type QuestionVisuals = {
  byQuestion: Map<number, { main?: QuestionImage; diagrams: QuestionImage[] }>;
  fallbackMain: QuestionImage[];
};

async function extractImagesFromZipBuffer(
  zipBuf: Buffer,
  sourceLabel: string,
  depth: number,
): Promise<QuestionImage[]> {
  if (depth > MAX_ZIP_NEST) return [];
  const zip = await JSZip.loadAsync(zipBuf);
  const allNames = Object.keys(zip.files)
    .filter((n) => !zip.files[n]?.dir)
    .sort((a, b) => a.localeCompare(b, "ko"));

  let manifestMainFiles: Set<string> | null = null;
  const manifestEntry = zip.file("manifest.json");
  if (manifestEntry) {
    try {
      const raw = await manifestEntry.async("string");
      const obj = JSON.parse(raw) as { items?: Array<{ file?: string }> };
      const files = (obj.items ?? [])
        .map((x) => String(x.file ?? "").trim())
        .filter(Boolean);
      if (files.length > 0) manifestMainFiles = new Set(files);
    } catch {
      // ignore manifest parse errors
    }
  }

  const out: QuestionImage[] = [];
  for (const name of allNames) {
    const base = path.basename(name);
    if (IMAGE_EXT.test(base)) {
      if (manifestMainFiles && !manifestMainFiles.has(base)) continue;
      const f = zip.file(name);
      if (!f) continue;
      const buffer = Buffer.from(await f.async("uint8array"));
      out.push({
        sourceLabel: `${sourceLabel}::${name}`,
        ext: path.extname(base).toLowerCase() || ".png",
        buffer,
      });
      continue;
    }
    if (/\.zip$/i.test(base)) {
      const f = zip.file(name);
      if (!f) continue;
      const nestedBuf = Buffer.from(await f.async("uint8array"));
      const nested = await extractImagesFromZipBuffer(
        nestedBuf,
        `${sourceLabel}>${name}`,
        depth + 1,
      );
      out.push(...nested);
    }
  }
  return out;
}

async function collectQuestionImages(inputAbs: string): Promise<QuestionImage[]> {
  const out: QuestionImage[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (IMAGE_EXT.test(e.name)) {
        const buffer = await fs.readFile(full);
        out.push({
          sourceLabel: path.relative(process.cwd(), full),
          ext: path.extname(e.name).toLowerCase() || ".png",
          buffer,
        });
        continue;
      }
      if (/\.zip$/i.test(e.name)) {
        try {
          const buf = await fs.readFile(full);
          const nested = await extractImagesFromZipBuffer(buf, path.relative(process.cwd(), full), 0);
          out.push(...nested);
        } catch {
          // ignore broken zips
        }
      }
    }
  }
  await walk(inputAbs);
  return out;
}

export async function collectQuestionVisuals(inputAbs: string): Promise<QuestionVisuals> {
  const fallbackMain = await collectQuestionImages(inputAbs);
  const byQuestion = new Map<number, { main?: QuestionImage; diagrams: QuestionImage[] }>();

  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile() || e.name !== "manifest.json") continue;
      try {
        const raw = await fs.readFile(full, "utf8");
        const manifest = JSON.parse(raw) as ManifestPayload;
        for (const item of manifest.items ?? []) {
          const q = Number.parseInt(String(item.questionNo ?? ""), 10);
          if (!Number.isFinite(q) || q <= 0) continue;
          const slot = byQuestion.get(q) ?? { diagrams: [] };
          const mainFile = String(item.file ?? "").trim();
          if (mainFile) {
            const abs = path.join(path.dirname(full), mainFile);
            try {
              const buf = await fs.readFile(abs);
              slot.main = {
                sourceLabel: abs,
                ext: path.extname(mainFile).toLowerCase() || ".png",
                buffer: buf,
              };
            } catch {
              // ignore missing main image
            }
          }
          for (const d of item.diagramFiles ?? []) {
            const rel = String(d ?? "").trim();
            if (!rel) continue;
            const abs = path.join(path.dirname(full), rel);
            try {
              const buf = await fs.readFile(abs);
              slot.diagrams.push({
                sourceLabel: abs,
                ext: path.extname(rel).toLowerCase() || ".png",
                buffer: buf,
              });
            } catch {
              // ignore missing diagram image
            }
          }
          byQuestion.set(q, slot);
        }
      } catch {
        // ignore malformed manifest
      }
    }
  }

  await walk(inputAbs);
  return { byQuestion, fallbackMain };
}
