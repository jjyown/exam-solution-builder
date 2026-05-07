/**
 * src/app/api/auto-pipeline/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST: 텍스트 또는 파일(PDF/이미지)을 받아 자동 파이프라인을 실행한다.
 *
 *  ◇ 단일 문항 모드: questionText 또는 파일에서 문항 1개만 추출됐을 때
 *      → 응답: { ok, parsed, attempts, trace, errors, manualReviewChecklist, runId, extracted }
 *
 *  ◇ 다중 문항 모드: 파일에서 2개 이상 문항이 추출된 경우 (전체 해설 또는 다수 선택)
 *      → 각 문항을 순차 호출. 응답:
 *      {
 *        ok,                    // 모두 성공이면 true, 하나라도 실패면 false
 *        runs: [
 *          { questionNo, questionText, parsed, attempts, errors, trace, manualReviewChecklist, runId }
 *        ],
 *        extracted,
 *        partialFailures: number
 *      }
 *
 *  GET: 헬스체크 (kb_size 반환)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from 'next/server';
import type { ReferenceRetriever } from '@/lib/referenceRetriever';
import { runAutoPipeline, type PipelineResult } from '@/lib/autoPipeline';
import { buildAutoChecklist } from '@/lib/autoPipelineChecklist';
import { recordAutoPipelineRun } from '@/lib/autoPipelineLog';
import { extractTextFromUploadedFile } from '@/lib/fileExtraction';
import { extractQuestionsFromText, type ExtractedQuestion } from '@/lib/questionSplit';
import {
  approxCostCents,
  geminiModelFor,
  inferDifficulty,
  openaiModelFor,
  type Profile,
} from '@/lib/profileRouting';

// KB 캐시는 모듈 전역으로 1회 인덱싱 → 재사용 (lib/autoPipelineRetriever)
const getRetriever = () =>
  // 동적 import 로 동기 모듈 그래프 회피 — 타입 추론은 그대로 유지
  import('@/lib/autoPipelineRetriever').then((m) => m.getAutoPipelineRetriever());

// ── LLM 어댑터 ─────────────────────────────────────────────────────────────
/**
 * Gemini API 응답이 한도 초과·rate-limit 인지 판별.
 * 429 그리고 RESOURCE_EXHAUSTED / spending cap / quota 키워드 매칭.
 */
function isGeminiQuotaError(status: number, body: string): boolean {
  if (status !== 429) return false;
  return /RESOURCE_EXHAUSTED|spending\s*cap|quota|rate.*limit/i.test(body);
}

class GeminiQuotaError extends Error {
  status = 429;
  raw: string;
  constructor(raw: string) {
    super(
      'Gemini 사용 한도/요금 한도 초과 (RESOURCE_EXHAUSTED). 자동으로 OpenAI로 폴백을 시도합니다.',
    );
    this.raw = raw;
  }
}

async function callGemini(prompt: string, modelOverride?: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 미설정');
  const model = modelOverride || process.env.GEMINI_MODEL || 'gemini-2.5-pro';
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
    const body = await res.text();
    if (isGeminiQuotaError(res.status, body)) throw new GeminiQuotaError(body);
    throw new Error(`Gemini ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (
    data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text).join('') || ''
  );
}

async function callOpenAI(prompt: string, modelOverride?: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 미설정');
  const model = modelOverride || process.env.OPENAI_MODEL || 'gpt-4o-mini';
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

/**
 * Profile 기반 모델 라우터.
 * - vendor: 'gemini' | 'openai' (사용자 선택)
 * - profile: 'easy' | 'balanced' | 'killer' (난이도 자동 추정)
 * - 비용 폭증 방지: 쉬운 문제에는 flash-lite/4o-mini, 킬러는 2.5-pro/4o
 * - Gemini 한도 초과 → OpenAI 자동 폴백 (요청 단위로 sticky)
 *
 * 반환: 호출 함수 + 사용된 model을 회신할 수 있는 wrapper.
 */
type RoutedCall = (prompt: string, profile: Profile) => Promise<{ text: string; usedModel: string; usedVendor: 'gemini' | 'openai' }>;

function makeRoutedLlmCall(modelPref: string | undefined): RoutedCall {
  let fallenBack = (modelPref || '').toLowerCase() === 'openai';
  return async (prompt, profile) => {
    if (fallenBack) {
      const m = openaiModelFor(profile);
      return { text: await callOpenAI(prompt, m), usedModel: m, usedVendor: 'openai' };
    }
    const geminiModel = geminiModelFor(profile);
    try {
      return { text: await callGemini(prompt, geminiModel), usedModel: geminiModel, usedVendor: 'gemini' };
    } catch (e) {
      if (e instanceof GeminiQuotaError) {
        fallenBack = true;
        if (process.env.OPENAI_API_KEY) {
          const m = openaiModelFor(profile);
          return { text: await callOpenAI(prompt, m), usedModel: m, usedVendor: 'openai' };
        }
        throw new Error(
          `Gemini 한도 초과 + OPENAI_API_KEY 없음. https://ai.studio/spend 또는 Railway에 OPENAI_API_KEY 추가 후 재시도.`,
        );
      }
      throw e;
    }
  };
}

// ── 입력 → 처리할 문항 리스트 결정 ─────────────────────────────────────────
type InputBody = {
  questionText?: string;
  fileData?: string;
  fileName?: string;
  fileType?: string;
  explanationMode?: 'full' | 'partial';
  selectedQuestions?: number[];
};

type ResolvedItem = { questionNo: string; questionText: string };
type ExtractedMeta = {
  totalQuestions: number;
  selectedNumbers: number[];
  source: string;
};

type Resolved =
  | { ok: true; items: ResolvedItem[]; extracted?: ExtractedMeta }
  | { ok: false; error: string };

const MAX_QUESTIONS_PER_REQUEST = 10; // LLM 한도·시간 보호 — 한 번에 최대 10문항

async function resolveItems(body: InputBody): Promise<Resolved> {
  // 1) 텍스트 직접 입력 — 항상 단일 문항
  if (body.questionText && body.questionText.trim().length >= 5) {
    return {
      ok: true,
      items: [{ questionNo: '1', questionText: body.questionText.trim() }],
    };
  }

  // 2) 파일 업로드
  if (body.fileData && body.fileName && body.fileType) {
    const extracted = await extractTextFromUploadedFile({
      fileData: body.fileData,
      fileName: body.fileName,
      fileType: body.fileType,
    });
    if (!extracted.ok) return { ok: false, error: extracted.error };

    const questions = extractQuestionsFromText(extracted.text);

    // 부분 해설: 선택된 문항만
    if (
      body.explanationMode === 'partial' &&
      body.selectedQuestions &&
      body.selectedQuestions.length > 0
    ) {
      const wanted = new Set(body.selectedQuestions);
      const picked = questions.filter((q) => wanted.has(q.number));
      if (picked.length === 0) {
        return {
          ok: false,
          error: `선택한 문항(${body.selectedQuestions.join(', ')})을 추출 결과에서 찾지 못했습니다. (인식된 문항: ${questions.map((q) => q.number).join(', ') || '없음'})`,
        };
      }
      return {
        ok: true,
        items: picked.slice(0, MAX_QUESTIONS_PER_REQUEST).map(toResolvedItem),
        extracted: {
          totalQuestions: questions.length,
          selectedNumbers: picked.map((q) => q.number),
          source: extracted.source,
        },
      };
    }

    // 전체 해설
    if (questions.length > 0) {
      const limit = Math.min(questions.length, MAX_QUESTIONS_PER_REQUEST);
      const truncated = questions.slice(0, limit);
      return {
        ok: true,
        items: truncated.map(toResolvedItem),
        extracted: {
          totalQuestions: questions.length,
          selectedNumbers: truncated.map((q) => q.number),
          source: extracted.source,
        },
      };
    }

    // 문항 분리 실패 → 전체 텍스트를 한 문항처럼
    return {
      ok: true,
      items: [{ questionNo: '?', questionText: extracted.text }],
      extracted: {
        totalQuestions: 0,
        selectedNumbers: [],
        source: extracted.source,
      },
    };
  }

  return { ok: false, error: 'questionText (>=5 chars) or fileData is required' };
}

function toResolvedItem(q: ExtractedQuestion): ResolvedItem {
  return { questionNo: String(q.number), questionText: q.content };
}

// ── 한 문항 실행 + 영속화 (다중 모드 공용) ──────────────────────────────────
type RunRow = {
  questionNo: string;
  questionText: string;
  parsed: PipelineResult['parsed'];
  attempts: number;
  errors: string[];
  trace: PipelineResult['trace'];
  manualReviewChecklist: string[];
  runId: string | null;
  persistError?: string;
  profile: Profile;
  profileReason: string;
  usedModel?: string;
  usedVendor?: 'gemini' | 'openai';
  approxCostCents?: number;
};

async function executeOne(params: {
  retriever: ReferenceRetriever;
  routedCall: RoutedCall;
  topK: number;
  maxRetries: number;
  examName?: string;
  modelPref: string;
  persist: boolean;
  item: ResolvedItem;
  /** 사용자가 강제 지정한 프로필 — 'auto' 면 자동 추정 */
  profileOverride: Profile | 'auto';
}): Promise<RunRow> {
  // 1) 난이도 추정 또는 강제값
  const inference =
    params.profileOverride === 'auto'
      ? inferDifficulty(params.item.questionNo, params.item.questionText)
      : { profile: params.profileOverride, reason: '사용자 지정' };

  let usedModel: string | undefined;
  let usedVendor: 'gemini' | 'openai' | undefined;
  let totalPromptChars = 0;

  const llmCall = async (prompt: string): Promise<string> => {
    totalPromptChars += prompt.length;
    const r = await params.routedCall(prompt, inference.profile);
    usedModel = r.usedModel;
    usedVendor = r.usedVendor;
    return r.text;
  };

  const result = await runAutoPipeline(params.item.questionText, {
    retriever: params.retriever,
    llmCall,
    topK: params.topK,
    maxRetries: params.maxRetries,
  });

  const checklist = buildAutoChecklist(result);
  let runId: string | null = null;
  let persistError: string | undefined;

  if (params.persist) {
    const log = await recordAutoPipelineRun(
      {
        questionText: params.item.questionText,
        examName: params.examName,
        questionNo: params.item.questionNo,
        model: usedModel || params.modelPref,
        topK: params.topK,
        maxRetries: params.maxRetries,
      },
      result,
      checklist,
    );
    runId = log.id;
    persistError = log.error;
  }

  const cost = usedModel
    ? Math.round(approxCostCents(usedModel, totalPromptChars) * 1000) / 1000
    : undefined;

  return {
    questionNo: params.item.questionNo,
    questionText: params.item.questionText,
    parsed: result.parsed,
    attempts: result.attempts,
    errors: result.errors,
    trace: result.trace,
    manualReviewChecklist: checklist,
    runId,
    persistError,
    profile: inference.profile,
    profileReason: inference.reason,
    usedModel,
    usedVendor,
    approxCostCents: cost,
  };
}

// ── 핸들러 ─────────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  let body: InputBody & {
    examName?: string;
    questionNo?: string;
    topK?: number;
    maxRetries?: number;
    model?: string;
    persist?: boolean;
    /** 'auto' | 'easy' | 'balanced' | 'killer' — 미지정 시 'auto' */
    profile?: 'auto' | Profile;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const resolved = await resolveItems(body);
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: 400 });
  }

  const model = (body.model || 'gemini').toLowerCase();
  const topK = body.topK ?? 3;
  const maxRetries = body.maxRetries ?? 2;
  const persist = body.persist !== false;
  const profileOverride: Profile | 'auto' =
    body.profile === 'easy' || body.profile === 'balanced' || body.profile === 'killer'
      ? body.profile
      : 'auto';

  // 텍스트 입력으로 들어왔지만 사용자가 questionNo를 지정한 경우 그걸로 덮어쓴다
  if (body.questionText && body.questionNo) {
    resolved.items[0].questionNo = body.questionNo;
  }

  try {
    const retriever = await getRetriever();
    const routedCall = makeRoutedLlmCall(model);

    // ─── 단일 문항 모드 ──────────────────────────────────────────────────
    if (resolved.items.length === 1) {
      const row = await executeOne({
        retriever,
        routedCall,
        topK,
        maxRetries,
        examName: body.examName,
        modelPref: model,
        persist,
        item: resolved.items[0],
        profileOverride,
      });

      // 추출 메타가 0문항이면 분리 실패 경고 추가
      if (resolved.extracted && resolved.extracted.totalQuestions === 0) {
        row.manualReviewChecklist.push(
          '[문항 분리 실패] 추출된 텍스트에서 문항 번호를 인식하지 못했습니다 — 전체를 1문항으로 처리. PDF 품질·OCR 결과를 확인하세요.',
        );
      }

      return NextResponse.json({
        ok: row.parsed !== null && row.errors.length === 0,
        parsed: row.parsed,
        attempts: row.attempts,
        errors: row.errors,
        trace: row.trace,
        manualReviewChecklist: row.manualReviewChecklist,
        runId: row.runId,
        persistError: row.persistError,
        extracted: resolved.extracted,
        // 단일 모드도 runs[]에 동일 정보를 넣어 UI가 일관된 뷰를 그릴 수 있게
        runs: [row],
      });
    }

    // ─── 다중 문항 모드: 순차 실행 ────────────────────────────────────────
    const runs: RunRow[] = [];
    for (const item of resolved.items) {
      // 한 문항이라도 throw 나도 다른 문항은 계속 진행
      try {
        const row = await executeOne({
          retriever,
          routedCall,
          topK,
          maxRetries,
          examName: body.examName,
          modelPref: model,
          persist,
          item,
          profileOverride,
        });
        runs.push(row);
      } catch (e) {
        const inf =
          profileOverride === 'auto'
            ? inferDifficulty(item.questionNo, item.questionText)
            : { profile: profileOverride, reason: '사용자 지정' };
        runs.push({
          questionNo: item.questionNo,
          questionText: item.questionText,
          parsed: null,
          attempts: 0,
          errors: [`예외: ${(e as Error).message}`],
          trace: [],
          manualReviewChecklist: [`[문항 ${item.questionNo}] 예외 발생: ${(e as Error).message}`],
          runId: null,
          profile: inf.profile,
          profileReason: inf.reason,
        });
      }
    }

    const partialFailures = runs.filter((r) => !r.parsed).length;
    return NextResponse.json({
      ok: partialFailures === 0,
      runs,
      partialFailures,
      extracted: resolved.extracted,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// 헬스체크용 (Railway 배포 후 GET으로 KB 크기 확인)
export async function GET() {
  try {
    const r = await getRetriever();
    return NextResponse.json({ ok: true, kb_size: r.size() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
