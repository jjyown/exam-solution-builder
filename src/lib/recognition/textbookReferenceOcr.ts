import { promises as fs } from "node:fs";
import path from "node:path";
import { buildMathpixSrcDataUrl, postMathpixV3Text } from "@/lib/mathpixV3Text";

export type TextbookReferenceMeta = {
  unit: string;
  type: string;
  difficulty: string;
  sourceImage: string;
};

function guessMimeFromFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".pdf") return "application/pdf";
  return "image/png";
}

export async function ocrTextbookReferenceImage(filePath: string): Promise<{
  ok: true;
  text: string;
  latexStyled?: string;
  confidence?: number;
} | {
  ok: false;
  message: string;
}> {
  try {
    const buf = await fs.readFile(filePath);
    const src = buildMathpixSrcDataUrl(buf.toString("base64"), guessMimeFromFile(filePath));
    const res = await postMathpixV3Text({ src });
    if (!res.ok) {
      return { ok: false, message: res.message };
    }
    const text = res.data.latex_styled?.trim() || res.data.text?.trim() || "";
    if (!text) return { ok: false, message: "Mathpix 결과 텍스트가 비어 있습니다." };
    return {
      ok: true,
      text,
      latexStyled: res.data.latex_styled,
      confidence: res.data.confidence,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export function buildTextbookReferenceMarkdown(meta: TextbookReferenceMeta, ocrText: string): string {
  return [
    "---",
    `unit: ${meta.unit}`,
    `type: ${meta.type}`,
    `difficulty: ${meta.difficulty}`,
    `sourceImage: ${meta.sourceImage}`,
    "---",
    "",
    "## OCR_본문",
    "",
    ocrText.trim(),
    "",
  ].join("\n");
}
