/**
 * src/app/api/auto-pipeline/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  단일 엔드포인트 — 문제 텍스트(또는 OCR된 텍스트)를 받아 자동으로:
 *    검색 → 프롬프트 → 생성 → 검증 → 재시도 → (선택) Supabase 영속화.
 *
 *  POST body:
 *    {
 *      "questionText": "...",
 *      "examName"?: string,
 *      "questionNo"?: string,
 *      "topK"?: 3,
 *      "maxRetries"?: 2,
 *      "model"?: "gemini" | "openai",
 *      "persist"?: boolean   // 기본 true (Supabase 키 있을 때만 동작)
 *    }
 *
 *  응답:
 *    { ok, parsed, attempts, trace, errors, manualReviewChecklist, runId? }
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from 'next/server';
import path from 'node:path';
import { ReferenceRetriever } from '@/lib/referenceRetriever';
import { runAutoPipeline } from '@/lib/autoPipeline';
import { buildAutoChecklist } from '@/lib/autoPipelineChecklist';
import { recordAutoPipelineRun } from '@/lib/autoPipelineLog';

// ── 파일 처리 유틸리티 ──────────────────────────────────────────────────────
async function processUploadedFile(fileData: string, fileName: string, fileType: string): Promise<string> {
  // TODO: 실제 PDF/이미지 처리 라이브러리 추가 (pdf-parse, tesseract.js 등)
  // 현재는 임시 구현 - base64 데이터를 텍스트로 변환 시도

  if (fileType === 'application/pdf') {
    // PDF 처리 로직 (추후 구현)
    return `[PDF 파일: ${fileName}] - PDF 처리 기능은 추후 추가 예정입니다.`;
  } else if (fileType.startsWith('image/')) {
    // 이미지 OCR 로직 (추후 구현)
    return `[이미지 파일: ${fileName}] - OCR 기능은 추후 추가 예정입니다.`;
  }

  return `[지원하지 않는 파일 형식: ${fileType}]`;
}

function extractQuestionsFromText(text: string): { index: number; content: string }[] {
  // 간단한 문제 분리 로직 (개선 필요)
  const questions: { index: number; content: string }[] = [];
  const lines = text.split('\n');

  let currentQuestion = '';
  let questionIndex = 0;

  for (const line of lines) {
    // 문제 번호 패턴 감지 (예: "1.", "1번", "(1)" 등)
    const questionMatch = line.match(/^(\d+)[\.\s번\)]\s*(.+)$/);
    if (questionMatch) {
      if (currentQuestion) {
        questions.push({ index: questionIndex, content: currentQuestion.trim() });
      }
      questionIndex = parseInt(questionMatch[1]);
      currentQuestion = questionMatch[2];
    } else {
      currentQuestion += ' ' + line;
    }
  }

  if (currentQuestion) {
    questions.push({ index: questionIndex, content: currentQuestion.trim() });
  }

  return questions;
}

// 런타임 1회 인덱싱, 이후 재사용 (Vercel/Railway 동일하게 동작)
let retrieverPromise: Promise<ReferenceRetriever> | null = null;
function getRetriever() {
  if (!retrieverPromise) {
    const kbPath =
      process.env.REFERENCE_KB_PATH ||
      path.join(process.cwd(), 'reference', 'kb.jsonl');
    retrieverPromise = ReferenceRetriever.fromJsonl(kbPath);
  }
  return retrieverPromise;
}

// ── LLM 호출 어댑터 ─────────────────────────────────────────────────────────
async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 미설정');

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text).join('') ||
    '';
  return text;
}

async function callOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 미설정');
  const model = process.env.OPENAI_MODEL || 'gpt-4-turbo';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      reasoning_effort: 'high',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

function pickLlmCall(model: string | undefined) {
  if ((model || '').toLowerCase() === 'openai') return callOpenAI;
  return callGemini;
}

// ── 핸들러 ─────────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  let body: {
    questionText?: string;
    examName?: string;
    questionNo?: string;
    topK?: number;
    maxRetries?: number;
    model?: string;
    persist?: boolean;
    // 파일 업로드 지원
    fileData?: string; // base64 encoded file
    fileName?: string;
    fileType?: string;
    explanationMode?: 'full' | 'partial';
    selectedQuestions?: number[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  // 입력 검증: 텍스트 또는 파일 중 하나는 필수
  const hasTextInput = body.questionText && body.questionText.trim().length >= 5;
  const hasFileInput = body.fileData && body.fileName && body.fileType;

  if (!hasTextInput && !hasFileInput) {
    return NextResponse.json(
      { ok: false, error: 'questionText (>=5 chars) or fileData is required' },
      { status: 400 }
    );
  }

  const model = (body.model || 'gemini').toLowerCase();
  const topK = body.topK ?? 3;
  const maxRetries = body.maxRetries ?? 2;
  const persist = body.persist !== false;

  try {
    const retriever = await getRetriever();
    const llmCall = pickLlmCall(model);

    // 입력 처리: 텍스트 또는 파일
    let processedQuestionText = body.questionText || '';

    if (hasFileInput && body.fileData && body.fileName && body.fileType) {
      // 파일에서 텍스트 추출
      processedQuestionText = await processUploadedFile(body.fileData, body.fileName, body.fileType);

      // 부분 해설 모드인 경우 선택된 문제만 필터링
      if (body.explanationMode === 'partial' && body.selectedQuestions && body.selectedQuestions.length > 0) {
        const allQuestions = extractQuestionsFromText(processedQuestionText);
        const selectedQuestionsText = allQuestions
          .filter(q => body.selectedQuestions!.includes(q.index))
          .map(q => `${q.index}. ${q.content}`)
          .join('\n\n');

        if (selectedQuestionsText) {
          processedQuestionText = `선택된 문제들:\n\n${selectedQuestionsText}`;
        }
      }
    }

    if (!processedQuestionText || processedQuestionText.trim().length < 5) {
      return NextResponse.json(
        { ok: false, error: 'processed question text is too short' },
        { status: 400 }
      );
    }

    const result = await runAutoPipeline(processedQuestionText, {
      retriever,
      llmCall,
      topK,
      maxRetries,
    });

    const manualReviewChecklist = buildAutoChecklist(result);

    let runId: string | null = null;
    if (persist) {
      const log = await recordAutoPipelineRun(
        {
          questionText: processedQuestionText,
          examName: body.examName,
          questionNo: body.questionNo,
          model,
          topK,
          maxRetries,
        },
        result,
        manualReviewChecklist,
      );
      runId = log.id;
    }

    return NextResponse.json({ ...result, manualReviewChecklist, runId });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}

// 헬스체크용 (Railway 배포 후 GET으로 KB 크기 확인)
export async function GET() {
  try {
    const r = await getRetriever();
    return NextResponse.json({ ok: true, kb_size: r.size() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}
