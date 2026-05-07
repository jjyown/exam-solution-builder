/**
 * fileExtraction.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  업로드된 PDF/이미지에서 문제 본문을 추출한다.
 *
 *  ▷ 기본(1순위): Gemini multimodal Vision (한국어 시험지 친화 프롬프트)
 *      - 이미지: 이미지 inlineData 직접
 *      - PDF: pdfjs 텍스트가 충분하면 그대로, 부족하면 PDF 통째로 Gemini 에 던짐
 *      - 한국어 발문, 도형 묘사, 문항 구조(보기/선지) 보존
 *      - 비용: gemini-2.0-flash 기준 1page ~$0.0001 (Mathpix 1page ~$0.004)
 *
 *  ▷ 폴백(2순위): Mathpix v3 (구 방식)
 *      - GEMINI_API_KEY 미설정 또는 Gemini 실패 시
 *
 *  ▷ 환경변수:
 *      - EXTRACTION_PRIMARY=gemini|mathpix  (기본 gemini)
 *      - GEMINI_MODELS_OCR=gemini-2.0-flash,...
 * ────────────────────────────────────────────────────────────────────────────
 */
import { recognizeMathpixFromImageBase64, resolveMathpixCredentials } from "./mathpixV3Text";
import { extractTextWithGeminiVision, isGeminiVisionAvailable } from "./geminiVisionExtract";

export type ExtractionResult =
  | {
      ok: true;
      text: string;
      source: "image-ocr" | "pdf-text" | "pdf-ocr" | "image-gemini" | "pdf-gemini";
      pages?: number;
      model?: string;
    }
  | { ok: false; error: string };

export type ExtractionInput = {
  fileData: string; // base64 (data: URL prefix 허용)
  fileName: string;
  fileType: string; // e.g. "image/png", "application/pdf"
};

const PDF_TEXT_MIN_CHARS = 40;

function extractionPrimary(): "gemini" | "mathpix" {
  const v = (process.env.EXTRACTION_PRIMARY || "").trim().toLowerCase();
  if (v === "mathpix") return "mathpix";
  return "gemini";
}

export async function extractTextFromUploadedFile(
  input: ExtractionInput,
): Promise<ExtractionResult> {
  const fileType = (input.fileType || "").toLowerCase();
  const cleanBase64 = input.fileData.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");

  if (fileType.startsWith("image/")) {
    return extractFromImage(cleanBase64, fileType);
  }
  if (fileType === "application/pdf" || /\.pdf$/i.test(input.fileName)) {
    return extractFromPdf(cleanBase64);
  }
  return {
    ok: false,
    error: `지원하지 않는 파일 형식: ${input.fileType} (${input.fileName})`,
  };
}

async function extractFromImage(base64: string, mimeType: string): Promise<ExtractionResult> {
  const primary = extractionPrimary();
  const errors: string[] = [];

  if (primary === "gemini" && isGeminiVisionAvailable()) {
    const r = await extractTextWithGeminiVision(base64, mimeType);
    if (r.ok) {
      return { ok: true, text: r.text, source: "image-gemini", model: r.model };
    }
    errors.push(`gemini-vision: ${r.error}`);
    // Gemini 한도 초과만 아니면 Mathpix 폴백 시도
    if (!r.quotaExceeded && resolveMathpixCredentials()) {
      const mp = await recognizeMathpixFromImageBase64(base64, mimeType);
      if (mp.ok && mp.data.text?.trim()) {
        return { ok: true, text: mp.data.text.trim(), source: "image-ocr" };
      }
      if (!mp.ok) errors.push(`mathpix: ${mp.message}`);
    }
    return { ok: false, error: errors.join(" | ") };
  }

  // primary=mathpix 또는 Gemini 키 없을 때
  if (resolveMathpixCredentials()) {
    const mp = await recognizeMathpixFromImageBase64(base64, mimeType);
    if (mp.ok && mp.data.text?.trim()) {
      return { ok: true, text: mp.data.text.trim(), source: "image-ocr" };
    }
    errors.push(`mathpix: ${mp.ok ? "빈 텍스트" : mp.message}`);
  } else {
    errors.push(
      "이미지 OCR 키가 없습니다 — GEMINI_API_KEY (권장) 또는 MATHPIX_APP_ID/KEY 가 필요합니다.",
    );
  }

  // Mathpix 실패 시 Gemini 한 번 더
  if (isGeminiVisionAvailable()) {
    const r = await extractTextWithGeminiVision(base64, mimeType);
    if (r.ok) return { ok: true, text: r.text, source: "image-gemini", model: r.model };
    errors.push(`gemini-vision: ${r.error}`);
  }
  return { ok: false, error: errors.join(" | ") || "이미지 추출 실패" };
}

async function extractFromPdf(base64: string): Promise<ExtractionResult> {
  // 1) pdfjs 로 텍스트 PDF 빠르게 처리
  const fast = await tryFastPdfText(base64);
  if (fast.ok && fast.text.length >= PDF_TEXT_MIN_CHARS) {
    return { ok: true, text: fast.text, source: "pdf-text", pages: fast.pages };
  }
  const fastErr = fast.ok ? `텍스트 부족 (${fast.text.length}자)` : fast.error;

  // 2) 스캔본/이미지 PDF — Gemini multimodal 로 PDF 통째로 OCR
  if (isGeminiVisionAvailable()) {
    const v = await extractTextWithGeminiVision(base64, "application/pdf");
    if (v.ok) {
      return { ok: true, text: v.text, source: "pdf-gemini", model: v.model };
    }
    return {
      ok: false,
      error: `PDF 텍스트 추출 실패 — pdfjs(${fastErr}) → gemini-vision(${v.error})`,
    };
  }

  // 3) 키도 없으면 안내
  return {
    ok: false,
    error:
      `PDF에서 텍스트를 거의 추출하지 못했습니다 (${fastErr}). ` +
      `스캔본 PDF 처리를 위해 GEMINI_API_KEY 를 설정하세요.`,
  };
}

async function tryFastPdfText(
  base64: string,
): Promise<{ ok: true; text: string; pages: number } | { ok: false; error: string }> {
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (e) {
    return { ok: false, error: `pdfjs-dist 로드 실패: ${(e as Error).message}` };
  }

  const buf = Buffer.from(base64, "base64");
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  let doc: import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy;
  try {
    doc = await pdfjs.getDocument({
      data,
      disableFontFace: true,
      useSystemFonts: false,
    }).promise;
  } catch (e) {
    return { ok: false, error: `PDF 파싱 실패: ${(e as Error).message}` };
  }

  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let prevY: number | null = null;
      const parts: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const y = Array.isArray(item.transform) ? Number(item.transform[5]) : null;
        if (prevY !== null && y !== null && Math.abs(prevY - y) > 1) {
          parts.push("\n");
        } else if (parts.length > 0) {
          parts.push(" ");
        }
        parts.push(item.str);
        if (y !== null) prevY = y;
      }
      const pageText = parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      pages.push(pageText);
    } catch {
      pages.push("");
    }
  }

  const fullText = pages.join("\n\n").trim();
  return { ok: true, text: fullText, pages: doc.numPages };
}
