/**
 * src/app/api/auto-pipeline/vision/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST /api/auto-pipeline/vision
 *
 *  이미지 → Gemini Vision 직접 호출 → JSON 풀이 반환.
 *
 *  기존 /api/auto-pipeline 흐름:
 *      이미지 → Mathpix/Gemini OCR → 텍스트 → RAG → LLM → JSON
 *  이 엔드포인트의 흐름:
 *      이미지 → Gemini Vision (한 번에 보고 풀이) → JSON
 *
 *  왜 별도 엔드포인트?
 *   - OCR 단계에서 텍스트가 깨지면 LLM 이 RAG 예시를 모방해 「입력과 무관한 풀이」
 *     를 만들어내는 사고 다수 관찰됨. 비전은 이미지 자체를 보고 풀이하므로 OCR
 *     실패 자체가 사라짐.
 *   - 단계가 줄어 비용·지연 모두 감소 (Mathpix 호출 1회 절약).
 *   - 검증/재시도 로직은 보수적으로 한 번만 — 비전 1회 호출로 끝나는 단순 구조.
 *
 *  body:
 *    {
 *      examName?: string,
 *      questionNo?: string,
 *      fileData: string,        // base64 (data: prefix 없는 순수 base64)
 *      fileType: string,        // mime ('image/png' | 'image/jpeg' 등)
 *      model?: 'gemini',        // 비전은 Gemini 만 지원 (현재)
 *      profile?: 'easy' | 'balanced' | 'killer',
 *      persist?: boolean,       // auto_pipeline_runs 영속화 (기본 true)
 *    }
 *
 *  응답: /api/auto-pipeline 의 단일 문항 모드와 동일 형식
 *    {
 *      ok, parsed, attempts, errors, runId, manualReviewChecklist,
 *      runs: [{ ... }],
 *      questionText,            // 비전 모드는 placeholder ('이미지 직접 풀이')
 *      usedModel, usedVendor: 'gemini',
 *    }
 */
import { NextResponse } from 'next/server';
import { recordAutoPipelineRun } from '@/lib/autoPipelineLog';
import { logApiCall } from '@/lib/apiCallLogger';
import { geminiModelFor, type Profile } from '@/lib/profileRouting';
import { explanationLatexToPlain } from '@/lib/latexToPlainText';

type ParsedStep = { text: string; equation: string };
type Parsed = {
  answer: string;
  explanation_steps: ParsedStep[];
  summary?: string;
};

const VISION_PROMPT = `
당신은 수학 문제 해설 전문가입니다. 첨부된 이미지에 있는 수학 문제 1개를 읽고 풀이하세요.

다음 JSON 형식만으로 응답하세요(마크다운 백틱 금지, 다른 텍스트 금지):
{
  "answer": "<최종 정답. 객관식이면 ①②③④⑤ 중 하나, 주관식이면 숫자/식.>",
  "explanation_steps": [
    { "text": "1단계 한국어 설명", "equation": "이 단계의 핵심 수식 (LaTeX, 평문 텍스트 금지)" },
    ...
  ],
  "summary": "<선택, 한 줄 요약>"
}

규칙:
- 수식은 반드시 equation 필드에 LaTeX 로 분리. text 에는 평문 설명만.
- 단계는 3~7개 권장. 비약 금지.
- 이미지에 문제가 명확하지 않으면 answer 에 "확인 필요" 라고 적고 explanation_steps 에 무엇이 안 보이는지 설명.
- 객관식 보기 번호와 정답 번호를 반드시 일치시킬 것.
- 추측하지 말 것 — 이미지에서 읽을 수 있는 정보로만 풀이.
`.trim();

/**
 * Gemini Vision 호출 + 429 자동 재시도.
 *
 * 무료/저티어 한도(RPM 60 등)에 빠르게 부딪히는 케이스가 빈번해
 * exponential backoff 로 자동 재시도. quota error(RESOURCE_EXHAUSTED 등)도
 * 같은 흐름으로 처리. 마지막 시도까지 실패하면 throw.
 *
 *  schedule: 즉시 → 2s → 5s → 10s (총 4번 시도)
 */
async function callGeminiVision(
  imageBase64: string,
  mimeType: string,
  modelOverride?: string,
): Promise<{ text: string; usedModel: string; retried: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 미설정');
  const model =
    modelOverride || process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const sleeps = [0, 2000, 5000, 10000];
  let lastErr = '';
  for (let attempt = 0; attempt < sleeps.length; attempt++) {
    if (sleeps[attempt] > 0) {
      await new Promise((r) => setTimeout(r, sleeps[attempt]));
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: VISION_PROMPT },
              { inlineData: { mimeType, data: imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const text =
        data?.candidates?.[0]?.content?.parts
          ?.map((p: { text?: string }) => p.text)
          .filter(Boolean)
          .join('') || '';
      return { text, usedModel: model, retried: attempt };
    }

    const body = await res.text();
    lastErr = `Gemini Vision ${res.status}: ${body.slice(0, 400)}`;

    // 429 또는 quota 류 에러만 재시도. 그 외(400 등) 는 즉시 throw.
    const retryable =
      res.status === 429 ||
      res.status === 503 ||
      /RESOURCE_EXHAUSTED|quota|rate.*limit|exceeded/i.test(body);
    if (!retryable) {
      throw new Error(lastErr);
    }
    // 다음 attempt 로 (마지막 attempt 였으면 루프 탈출 후 throw)
  }
  throw new Error(`${lastErr} (${sleeps.length}회 재시도 모두 실패 — 잠시 후 다시 시도하세요)`);
}

function safeParseJson(raw: string): Parsed | null {
  if (!raw) return null;
  // Gemini 가 가끔 ```json ... ``` 으로 감싸는 케이스 대응
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    if (typeof obj !== 'object' || obj === null) return null;
    if (typeof obj.answer !== 'string') return null;
    if (!Array.isArray(obj.explanation_steps)) return null;
    return {
      answer: obj.answer,
      explanation_steps: obj.explanation_steps.map((s: unknown) => {
        const o = (s ?? {}) as { text?: unknown; equation?: unknown };
        return {
          text: typeof o.text === 'string' ? explanationLatexToPlain(o.text) : '',
          equation: typeof o.equation === 'string' ? o.equation : '',
        };
      }),
      summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    };
  } catch {
    return null;
  }
}

function buildChecklist(parsed: Parsed | null): string[] {
  const out: string[] = [];
  if (!parsed) {
    out.push('비전 응답 JSON 파싱 실패 — 응답 형식 점검 필요');
    return out;
  }
  if (parsed.explanation_steps.length < 2) {
    out.push('[풀이 단계 부족] 2단계 미만 — 비약 가능성 검토');
  }
  if (/확인\s*필요|주어지지\s*않|문제가\s*명확/.test(parsed.answer)) {
    out.push('[입력 인식 실패] 비전이 문제를 명확히 읽지 못함 — 더 선명한 이미지로 재시도');
  }
  // 단계 안 equation 이 비어 있으면 raw LaTeX 가 text 에 박혀 있을 가능성
  const emptyEqStepsRatio =
    parsed.explanation_steps.filter((s) => !s.equation.trim()).length /
    Math.max(parsed.explanation_steps.length, 1);
  if (emptyEqStepsRatio > 0.7) {
    out.push('[수식 누락] 대부분 단계의 equation 필드가 비어있음 — 수식이 본문에 평문으로 들어갔을 수 있음');
  }
  return out;
}

export async function POST(req: Request) {
  let body: {
    examName?: string;
    questionNo?: string;
    fileData?: string;
    fileType?: string;
    model?: string;
    profile?: Profile | 'auto';
    persist?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.fileData || !body.fileType) {
    return NextResponse.json(
      { ok: false, error: 'fileData (base64) 와 fileType (mime) 이 필요합니다' },
      { status: 400 },
    );
  }

  const profile: Profile =
    body.profile === 'easy' || body.profile === 'balanced' || body.profile === 'killer'
      ? body.profile
      : 'balanced';

  // profile 에 따라 Gemini 모델 선택 (기존 라우팅과 동일 정책)
  const visionModel = body.model && body.model !== 'gemini' ? undefined : geminiModelFor(profile);

  const t0 = Date.now();
  let llmRaw = '';
  let usedModel = '';
  let retriedCount = 0;
  const errors: string[] = [];
  try {
    const r = await callGeminiVision(body.fileData, body.fileType, visionModel);
    llmRaw = r.text;
    usedModel = r.usedModel;
    retriedCount = r.retried;
  } catch (e) {
    const msg = (e as Error).message;
    errors.push(msg);
    void logApiCall({
      route: '/api/auto-pipeline/vision',
      purpose: '크롭 비전 직접 풀이 (실패)',
      vendor: 'gemini',
      model: visionModel || 'unknown',
      ok: false,
      meta: { error: msg.slice(0, 200) },
    });
    return NextResponse.json(
      { ok: false, error: msg, runs: [] },
      { status: 200 }, // 클라이언트 에러 처리는 ok=false 로 통일
    );
  }

  void logApiCall({
    route: '/api/auto-pipeline/vision',
    purpose: '크롭 비전 직접 풀이 (Gemini Vision 1회)',
    vendor: 'gemini',
    model: usedModel,
    ok: true,
    units: 1 + retriedCount, // 재시도까지 포함한 실제 호출 수 (429 backoff)
    meta: {
      latencyMs: Date.now() - t0,
      exam: body.examName,
      qNo: body.questionNo,
      retried: retriedCount,
    },
  });

  const parsed = safeParseJson(llmRaw);
  const checklist = buildChecklist(parsed);
  if (!parsed) {
    errors.push('JSON 파싱 실패 — 비전 응답 형식 비정상');
  }

  // 영속화 — 기존 auto_pipeline_runs 와 동일 형식으로 저장 (이력·미리보기·DOCX 재사용)
  // model 에 'vision:' prefix 를 붙여 cost-tracker / inbox 에서 비전 runs 로 식별 가능하게.
  // - cost-tracker: 'vision:' prefix 있는 row 는 auto_pipeline_runs 집계에서 skip
  //   (api_call_logs 의 /api/auto-pipeline/vision 으로만 1회 카운트 → 이중 카운트 방지)
  // - inbox: model 시작이 'vision:' 이면 🔭 배지 표시
  let runId: string | null = null;
  let persistError: string | undefined;
  if (body.persist !== false) {
    const log = await recordAutoPipelineRun(
      {
        questionText: '[비전 직접 풀이] 이미지 입력',
        examName: body.examName,
        questionNo: body.questionNo,
        model: `vision:${usedModel}`,
        topK: 0,
        maxRetries: 0,
      },
      {
        ok: parsed !== null && errors.length === 0,
        attempts: 1,
        parsed,
        trace: [
          { stage: 'llm_call', attempt: 1, promptChars: llmRaw.length },
          parsed
            ? { stage: 'success', attempts: 1 }
            : { stage: 'give_up', attempts: 1, lastErrors: errors },
        ],
        errors,
        similarReferences: [],
      },
      checklist,
    );
    runId = log.id;
    persistError = log.error;
  }

  const row = {
    questionNo: body.questionNo || '?',
    questionText: '[비전 직접 풀이] 이미지 입력',
    parsed,
    attempts: 1,
    errors,
    trace: [
      { stage: 'llm_call' as const, attempt: 1, promptChars: llmRaw.length },
      parsed
        ? { stage: 'success' as const, attempts: 1 }
        : { stage: 'give_up' as const, attempts: 1, lastErrors: errors },
    ],
    manualReviewChecklist: checklist,
    runId,
    persistError,
    usedModel,
    usedVendor: 'gemini' as const,
    profile,
  };

  return NextResponse.json({
    ok: parsed !== null && errors.length === 0,
    parsed,
    attempts: 1,
    errors,
    trace: row.trace,
    manualReviewChecklist: checklist,
    runId,
    persistError,
    questionText: row.questionText,
    usedModel,
    usedVendor: 'gemini',
    runs: [row],
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    description: 'POST 이미지 base64 + mime → Gemini Vision 직접 풀이 → JSON',
    expects: ['fileData', 'fileType'],
  });
}
