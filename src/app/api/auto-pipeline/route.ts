/**
 * src/app/api/auto-pipeline/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  단일 엔드포인트 — 문제 텍스트(또는 OCR된 텍스트)를 받아 자동으로:
 *    검색 → 프롬프트 → 생성 → 검증 → 재시도까지 한 번에 처리.
 *
 *  POST body:
 *    {
 *      "questionText": "둘레의 길이가 16인 부채꼴 중에서 ...",
 *      "topK"?: 3,
 *      "maxRetries"?: 2,
 *      "model"?: "gemini" | "openai"
 *    }
 *
 *  응답:
 *    { ok, parsed, attempts, trace, errors }
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from 'next/server';
import path from 'node:path';
import { ReferenceRetriever } from '@/lib/referenceRetriever';
import { runAutoPipeline } from '@/lib/autoPipeline';

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
  const model = process.env.OPENAI_MODEL || 'gpt-4.1';
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
    topK?: number;
    maxRetries?: number;
    model?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.questionText || body.questionText.trim().length < 5) {
    return NextResponse.json(
      { ok: false, error: 'questionText is required (>=5 chars)' },
      { status: 400 }
    );
  }

  try {
    const retriever = await getRetriever();
    const llmCall = pickLlmCall(body.model);
    const result = await runAutoPipeline(body.questionText, {
      retriever,
      llmCall,
      topK: body.topK ?? 3,
      maxRetries: body.maxRetries ?? 2,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}

// 헬스체크용
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
