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
import {
  recognizeMathpixFromImageBase64,
  resolveMathpixCredentials,
  isMathpixUsableForOcr,
  isMathpixQuotaError,
  markMathpixExhausted,
} from "./mathpixV3Text";
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

  // ── primary=mathpix 경로: 매쓰픽스 우선 → 소진 자동 감지 → Gemini 자동 전환 ──
  if (primary === "mathpix") {
    if (await isMathpixUsableForOcr()) {
      const mp = await recognizeMathpixFromImageBase64(base64, mimeType);
      if (mp.ok && mp.data.text?.trim()) {
        return { ok: true, text: mp.data.text.trim(), source: "image-ocr" };
      }
      if (!mp.ok) {
        if (isMathpixQuotaError(mp)) {
          markMathpixExhausted(`HTTP ${mp.status}: ${mp.message.slice(0, 100)}`);
          errors.push(`mathpix 소진 — Gemini 자동 전환`);
        } else {
          errors.push(`mathpix: ${mp.message}`);
        }
      } else {
        errors.push(`mathpix: 빈 텍스트`);
      }
    } else {
      errors.push("mathpix: 잔여 부족·1시간 백오프 중 — Gemini 사용");
    }
    // 매쓰픽스 실패/skip → Gemini 폴백
    if (isGeminiVisionAvailable()) {
      const r = await extractTextWithGeminiVision(base64, mimeType);
      if (r.ok) return { ok: true, text: r.text, source: "image-gemini", model: r.model };
      errors.push(`gemini-vision: ${r.error}`);
    }
    return { ok: false, error: errors.join(" | ") || "이미지 추출 실패" };
  }

  // ── primary=gemini 경로: Gemini 우선, 실패 시 Mathpix 폴백 ──
  if (isGeminiVisionAvailable()) {
    const r = await extractTextWithGeminiVision(base64, mimeType);
    if (r.ok) {
      return { ok: true, text: r.text, source: "image-gemini", model: r.model };
    }
    errors.push(`gemini-vision: ${r.error}`);
    // Gemini 한도 초과 + Mathpix 사용 가능하면 폴백
    if (!r.quotaExceeded && (await isMathpixUsableForOcr())) {
      const mp = await recognizeMathpixFromImageBase64(base64, mimeType);
      if (mp.ok && mp.data.text?.trim()) {
        return { ok: true, text: mp.data.text.trim(), source: "image-ocr" };
      }
      if (!mp.ok && isMathpixQuotaError(mp)) {
        markMathpixExhausted(`fallback HTTP ${mp.status}: ${mp.message.slice(0, 100)}`);
      }
      if (!mp.ok) errors.push(`mathpix: ${mp.message}`);
    }
    return { ok: false, error: errors.join(" | ") };
  }

  // Gemini 미설정 → Mathpix 직행
  if (await isMathpixUsableForOcr()) {
    const mp = await recognizeMathpixFromImageBase64(base64, mimeType);
    if (mp.ok && mp.data.text?.trim()) {
      return { ok: true, text: mp.data.text.trim(), source: "image-ocr" };
    }
    if (!mp.ok && isMathpixQuotaError(mp)) markMathpixExhausted(`HTTP ${mp.status}`);
    errors.push(`mathpix: ${mp.ok ? "빈 텍스트" : mp.message}`);
  } else {
    errors.push(
      "이미지 OCR 키가 없습니다 — GEMINI_API_KEY (권장) 또는 MATHPIX_APP_ID/KEY 가 필요합니다.",
    );
  }
  return { ok: false, error: errors.join(" | ") || "이미지 추출 실패" };
}

/**
 * 한국 학원 시험지 PDF 가 자주 보이는 텍스트 손상 패턴 감지.
 *  - 숫자·수식 글리프가 특수 폰트로 임베드되어 pdfjs 추출 시 빈 공백만 남는 케이스.
 *  - 예) "자녀  명이" (숫자 누락), "①   ②   ③" (선지 값 누락), "P    " (수식 누락).
 *  hits / chunk 비율이 임계 이상이면 broken 으로 판정.
 */
function looksLikeBrokenKoreanExamText(text: string): {
  broken: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  let hits = 0;

  // 1) "선지 ① 다음에 값 없이 공백·줄바꿈" — 객관식 선지 값 누락
  const emptyChoices = text.match(/[①②③④⑤⑥⑦⑧⑨⑩]\s{2,}(?=[①②③④⑤⑥⑦⑧⑨⑩]|\n|$)/g);
  if (emptyChoices && emptyChoices.length >= 3) {
    hits += emptyChoices.length;
    reasons.push(`빈 선지 ${emptyChoices.length}개`);
  }

  // 2) 한국어 단위 명사 앞에 숫자 누락: "  명", "  원", "  개", "  점"
  const emptyUnits = text.match(/\s{2,}(?:명|원|개|점|장|번|회|배|쪽)/g);
  if (emptyUnits && emptyUnits.length >= 3) {
    hits += emptyUnits.length;
    reasons.push(`단위 앞 숫자 누락 ${emptyUnits.length}개`);
  }

  // 3) 빈 수식 마커 ("$  $", "P  =  ", "수가  이")
  const emptyMath = text.match(/(?:\$\s*\$|=\s{2,}[가-힣]|[가-힣]\s{2,}이[다라]?\b)/g);
  if (emptyMath && emptyMath.length >= 5) {
    hits += emptyMath.length;
    reasons.push(`빈 수식·조사 ${emptyMath.length}개`);
  }

  // 4) 유난히 짧은 줄들이 연속 (수식이 그래픽으로 빠지면 행이 토막 남)
  const lines = text.split("\n");
  const tinyLines = lines.filter((l) => l.trim().length > 0 && l.trim().length <= 3).length;
  if (tinyLines >= 10 && tinyLines / Math.max(lines.length, 1) > 0.25) {
    hits += tinyLines;
    reasons.push(`극단적 단편 줄 ${tinyLines}/${lines.length}`);
  }

  // 본문 길이 대비 손상 hits 비율로 판정 (1000자당 6건 이상이면 broken)
  const ratio = hits / Math.max(text.length / 1000, 1);
  return { broken: ratio >= 6, reasons };
}

function pdfForceVision(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.PDF_FORCE_VISION || "").trim());
}

async function extractFromPdf(base64: string): Promise<ExtractionResult> {
  // 0) 환경변수 PDF_FORCE_VISION=true 면 pdfjs 건너뛰고 바로 Gemini multimodal
  if (pdfForceVision() && isGeminiVisionAvailable()) {
    const v = await extractTextWithGeminiVision(base64, "application/pdf");
    if (v.ok) return { ok: true, text: v.text, source: "pdf-gemini", model: v.model };
    // 강제 비전 실패 시 pdfjs 폴백으로 진행
  }

  // 1) pdfjs 로 텍스트 PDF 빠르게 처리
  const fast = await tryFastPdfText(base64);

  // 1-a) 충분한 텍스트면 손상 패턴 검사. 손상 의심이면 Gemini multimodal 로 재추출.
  if (fast.ok && fast.text.length >= PDF_TEXT_MIN_CHARS) {
    const diag = looksLikeBrokenKoreanExamText(fast.text);
    if (!diag.broken) {
      return { ok: true, text: fast.text, source: "pdf-text", pages: fast.pages };
    }
    // 손상 감지 → Gemini multimodal 재추출 (한국 시험지 시각 인식)
    if (isGeminiVisionAvailable()) {
      const v = await extractTextWithGeminiVision(base64, "application/pdf");
      if (v.ok) {
        return { ok: true, text: v.text, source: "pdf-gemini", model: v.model };
      }
      // Gemini 실패해도 손상된 pdfjs 결과보단 명시 에러가 안전
      return {
        ok: false,
        error: `PDF 텍스트 손상 감지(${diag.reasons.join(", ")}) — Gemini 재추출 실패: ${v.error}`,
      };
    }
    // Vision 키 없으면 어쩔 수 없이 손상된 pdfjs 결과 반환 + 경고
    return {
      ok: true,
      text: fast.text,
      source: "pdf-text",
      pages: fast.pages,
    };
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
