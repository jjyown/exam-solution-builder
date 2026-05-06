/**
 * fileExtraction.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  업로드된 PDF/이미지에서 문제 본문을 추출한다.
 *   - 이미지: Mathpix OCR (recognizeMathpixFromImageBase64)
 *   - PDF: pdfjs-dist 서버 사이드 텍스트 추출. 텍스트가 비면 OCR 폴백.
 *  Mathpix 키 미설정 시 명시적 에러를 반환.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { recognizeMathpixFromImageBase64, resolveMathpixCredentials } from "./mathpixV3Text";

export type ExtractionResult =
  | { ok: true; text: string; source: "image-ocr" | "pdf-text" | "pdf-ocr"; pages?: number }
  | { ok: false; error: string };

export type ExtractionInput = {
  fileData: string;       // base64 (data: URL prefix 허용)
  fileName: string;
  fileType: string;       // e.g. "image/png", "application/pdf"
};

const PDF_TEXT_MIN_CHARS = 40;

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
  if (!resolveMathpixCredentials()) {
    return {
      ok: false,
      error:
        "이미지 OCR을 위해 MATHPIX_APP_ID / MATHPIX_APP_KEY 가 필요합니다. " +
        ".env.local 또는 Railway Variables에 등록하세요.",
    };
  }
  const r = await recognizeMathpixFromImageBase64(base64, mimeType);
  if (!r.ok) {
    return { ok: false, error: r.message };
  }
  const text = (r.data.text || "").trim();
  if (!text) {
    return { ok: false, error: "이미지에서 텍스트를 추출하지 못했습니다." };
  }
  return { ok: true, text, source: "image-ocr" };
}

async function extractFromPdf(base64: string): Promise<ExtractionResult> {
  let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    // 서버에서는 worker 없이 동기적 처리
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (e) {
    return { ok: false, error: `pdfjs-dist 로드 실패: ${(e as Error).message}` };
  }

  const buf = Buffer.from(base64, "base64");
  // Buffer를 Uint8Array로 (pdfjs는 Uint8Array를 받음)
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  let doc: import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy;
  try {
    doc = await pdfjs.getDocument({
      data,
      // 서버 사이드 — fontFace/system fonts 안 씀
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
      // pdfjs textContent items에는 transform[5]가 Y 좌표.
      // Y가 바뀌면 줄바꿈을 삽입해 문항 헤더 정규식이 매칭되도록 한다.
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
  if (fullText.length >= PDF_TEXT_MIN_CHARS) {
    return { ok: true, text: fullText, source: "pdf-text", pages: doc.numPages };
  }

  // 텍스트가 거의 없는 PDF (스캔본) — 페이지를 이미지로 렌더해 OCR해야 하지만,
  // 서버 사이드 PDF→이미지 변환은 추가 의존성 필요(canvas 등). 1차 버전은 안내만.
  return {
    ok: false,
    error:
      `PDF에서 텍스트를 거의 추출하지 못했습니다 (${fullText.length}자). ` +
      `스캔본 PDF는 페이지별 이미지를 캡처해 업로드하거나, 크롭된 시험지(이미지)로 업로드하세요.`,
  };
}
