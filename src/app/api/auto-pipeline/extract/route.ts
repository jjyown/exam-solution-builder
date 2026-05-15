/**
 * src/app/api/auto-pipeline/extract/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  파일에서 문항만 미리 추출한다 (LLM 호출 안 함).
 *  /auto UI가 실행 전에 「인식된 문항 번호」를 사용자에게 보여주기 위해.
 *
 *  POST { fileData, fileName, fileType }
 *  →   { ok, source, totalQuestions, questions: [{ number, content, points? }] }
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from 'next/server';
import { extractTextFromUploadedFile } from '@/lib/fileExtraction';
import { extractQuestionsFromText } from '@/lib/questionSplit';
import { logApiCall, type ApiVendor } from '@/lib/apiCallLogger';

const PREVIEW_CHARS = 120;

export async function POST(req: Request) {
  let body: { fileData?: string; fileName?: string; fileType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.fileData || !body.fileName || !body.fileType) {
    return NextResponse.json(
      { ok: false, error: 'fileData, fileName, fileType 가 모두 필요합니다.' },
      { status: 400 },
    );
  }

  const extracted = await extractTextFromUploadedFile({
    fileData: body.fileData,
    fileName: body.fileName,
    fileType: body.fileType,
  });

  // 어떤 OCR 백엔드가 실제로 호출됐는지 source 로 판별 → 라우트별 비용 통계용 로그.
  // pdf-text 는 pdfjs(무료) — 외부 호출이 없으므로 로깅 생략.
  if (extracted.ok && extracted.source !== 'pdf-text') {
    const vendor: ApiVendor = 'gemini';
    const model = extracted.model || 'unknown';
    void logApiCall({
      route: '/api/auto-pipeline/extract',
      purpose: '해설 제작 — 업로드 파일에서 문항 미리 추출 (OCR)',
      vendor,
      model,
      ok: true,
      // PDF 는 페이지 수만큼 호출/과금 — extracted.pages 가 있으면 보정
      units: extracted.pages && extracted.pages > 0 ? extracted.pages : 1,
      meta: { fileName: body.fileName, source: extracted.source },
    });
  }

  if (!extracted.ok) {
    return NextResponse.json({ ok: false, error: extracted.error }, { status: 422 });
  }

  const questions = extractQuestionsFromText(extracted.text);
  return NextResponse.json({
    ok: true,
    source: extracted.source,
    pages: extracted.pages,
    totalQuestions: questions.length,
    questions: questions.map((q) => ({
      number: q.number,
      points: q.points,
      preview: q.content.slice(0, PREVIEW_CHARS) + (q.content.length > PREVIEW_CHARS ? '…' : ''),
    })),
    rawTextLength: extracted.text.length,
  });
}
