import { promises as fs } from "node:fs";
import path from "node:path";
import { ImageRun } from "docx";

/** `examExplanationDocx` 의 이미지 줄 판별과 동일한 형태 */
const MD_IMAGE_LINE = /^\s*!\[([^\]]*)]\(([^)]+)\)\s*$/;

export function parseMarkdownImageLine(line: string): { alt: string; src: string } | null {
  const m = line.match(MD_IMAGE_LINE);
  if (!m) return null;
  const src = (m[2] ?? "").trim();
  if (!src) return null;
  return { alt: (m[1] ?? "").trim(), src };
}

/**
 * 타이핑·검수용으로 남긴 **문제 텍스트만 담긴 크롭** — 최종 해설지 DOCX `[문제]` 파트에는 넣지 않는다.
 * (그래프·좌표평면·도형 등은 `![참고 도형 …]` 등 다른 대체 텍스트로 둔다.)
 */
export function isDocxOmittedTypingReferenceCropAlt(alt: string): boolean {
  const a = (alt || "").trim();
  if (!a) return false;
  /**
   * 주의:
   * - "문제 원본"은 실제 최종 해설지에 반드시 노출되어야 하므로 제외 대상에서 뺀다.
   * - 정말 작업용 참조 이미지만 명시적으로 걸러낸다.
   */
  return /타이핑\s*참고|작업용(?:\s*크롭)?|검수용(?:\s*크롭)?|원문\s*타이핑\s*참고/i.test(a);
}

export function isDocxOmittedTypingReferenceCropMarkdownLine(line: string): boolean {
  const img = parseMarkdownImageLine(line.trim());
  if (!img) return false;
  return isDocxOmittedTypingReferenceCropAlt(img.alt);
}

type RasterType = "png" | "jpg" | "gif" | "bmp";

function detectRasterType(buf: Buffer): RasterType | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    (buf[3] === 0x38 || buf[3] === 0x39)
  ) {
    return "gif";
  }
  if (buf.length >= 6 && buf.toString("ascii", 0, 2) === "BM") return "bmp";
  return null;
}

function pngDimensions(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function jpegDimensions(buf: Buffer): { w: number; h: number } | null {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    const segLen = buf.readUInt16BE(i + 2);
    i += 2 + segLen;
  }
  return null;
}

function gifDimensions(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 10) return null;
  return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
}

function bmpDimensions(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 26) return null;
  return { w: buf.readUInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
}

function rasterDimensions(buf: Buffer, t: RasterType): { w: number; h: number } | null {
  if (t === "png") return pngDimensions(buf);
  if (t === "jpg") return jpegDimensions(buf);
  if (t === "gif") return gifDimensions(buf);
  return bmpDimensions(buf);
}

/**
 * 2단 칼럼 기준 단일 칼럼 너비에 맞게 픽셀 단위로 축소(docx ImageRun 은 px → 내부 EMU 변환).
 * B4·HML 여백(`examDocxTheme` EXAM_DOCX_HML_PAGE)에 맞춘 본문 단 너비보다 크지 않게 상한을 둔다.
 */
const MAX_DISPLAY_WIDTH_PX = 280;

function scaleToMaxWidth(w: number, h: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: MAX_DISPLAY_WIDTH_PX, height: 200 };
  if (w <= MAX_DISPLAY_WIDTH_PX) return { width: w, height: h };
  const s = MAX_DISPLAY_WIDTH_PX / w;
  return { width: MAX_DISPLAY_WIDTH_PX, height: Math.max(1, Math.round(h * s)) };
}

/**
 * `assetBaseDir` 기준 상대 경로만 허용. 파일을 읽을 수 있으면 버퍼 반환.
 */
export async function readImageRelativeToBase(
  assetBaseDir: string,
  srcRaw: string,
): Promise<Buffer | null> {
  const trimmed = srcRaw.trim();
  const noQuery = trimmed.split("?")[0]?.split("#")[0] ?? "";
  if (!noQuery || path.isAbsolute(noQuery)) return null;
  const normalized = noQuery.replace(/^\.\//, "").replace(/\\/g, path.sep);
  if (normalized.includes("..")) return null;

  const baseResolved = path.resolve(assetBaseDir);
  const abs = path.resolve(baseResolved, normalized);
  const relToBase = path.relative(baseResolved, abs);
  if (!relToBase || relToBase.startsWith("..") || path.isAbsolute(relToBase)) return null;

  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

export function imageRunFromBuffer(data: Buffer, alt: string): ImageRun | null {
  const t = detectRasterType(data);
  if (!t) return null;
  const dim = rasterDimensions(data, t);
  const { width, height } = scaleToMaxWidth(dim?.w ?? 400, dim?.h ?? 280);
  return new ImageRun({
    type: t,
    data,
    transformation: { width, height },
    altText: alt
      ? { name: alt.slice(0, 120), description: alt.slice(0, 240), title: alt.slice(0, 120) }
      : { name: "Figure", description: "Exam figure" },
  });
}
