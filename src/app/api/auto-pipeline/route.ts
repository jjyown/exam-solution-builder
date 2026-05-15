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
import { findRelevantCautions, recordAutoPipelineRun } from '@/lib/autoPipelineLog';
import { extractTextFromUploadedFile } from '@/lib/fileExtraction';
import { logApiCall as apiCallLog } from '@/lib/apiCallLogger';
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

// ── 진행 상황 추적 (UI 라이브 폴링용) ─────────────────────────────────────
/**
 * 현재 실행 중인 파이프라인의 진행 상태를 모듈 전역에 보관한다.
 * UI 가 /api/auto-pipeline/progress 를 폴링해 실시간 진행률을 표시한다.
 * 동시 실행은 1개 (admin tool 가정) — 새 POST 가 시작되면 덮어쓴다.
 */
type ProgressStage =
  | 'idle'
  | 'preparing'      // 입력 파싱·문항 추출 중
  | 'processing'     // 문항 풀이 진행 중 (currentIdx 사용)
  | 'completed'
  | 'failed';

type ProgressState = {
  stage: ProgressStage;
  startedAt: number | null;
  updatedAt: number | null;
  /** 처리 중인 현재 문항(0-indexed). processing 단계에서만 의미있음 */
  currentIdx: number;
  /** 전체 문항 수 */
  total: number;
  /** 현재 처리 중 문항 번호 — UI 표시용 */
  currentNo: string | null;
  /** processing 안에서의 세부 단계 */
  subStage:
    | null
    | 'searching'      // 참고 예시 검색
    | 'generating'     // LLM 풀이 생성
    | 'validating'     // V1-V6 검증
    | 'retrying'       // 검증 실패 → 재시도
    | 'persisting';    // Supabase 영속화
  /** 지금까지 완료된 문항 수 */
  completedCount: number;
  /** 마지막 에러 (failed 일 때) */
  error: string | null;
};

let progressState: ProgressState = {
  stage: 'idle',
  startedAt: null,
  updatedAt: null,
  currentIdx: 0,
  total: 0,
  currentNo: null,
  subStage: null,
  completedCount: 0,
  error: null,
};

function setProgress(patch: Partial<ProgressState>): void {
  progressState = { ...progressState, ...patch, updatedAt: Date.now() };
}

function startProgress(total: number): void {
  progressState = {
    stage: 'preparing',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    currentIdx: 0,
    total,
    currentNo: null,
    subStage: null,
    completedCount: 0,
    error: null,
  };
}

export function getProgressSnapshot(): ProgressState {
  return progressState;
}

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
  // 모델 계열별 파라미터 분기:
  //   - reasoning 계열(o1/o3/gpt-5/o4): reasoning_effort 사용, temperature 미지원
  //   - 일반 chat 계열(gpt-4o, gpt-4.1, gpt-4o-mini 등): temperature 사용,
  //     reasoning_effort 보내면 400 "Unrecognized request argument" 로 거부됨.
  // 본 프로젝트 profileRouting 은 기본 gpt-4o 계열을 쓰므로 과거 무조건 reasoning_effort
  // 를 보내던 코드가 모든 OpenAI 호출을 막던 버그를 픽스.
  const isReasoningModel = /^o[1-9]|^o[1-9]-|gpt-5/i.test(model);
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  };
  if (isReasoningModel) {
    body.reasoning_effort = 'high';
  } else {
    body.temperature = 0.2;
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
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
  // 429/quota 시 같은 모델 backoff 재시도 스케줄. vision/route.ts 패턴 동일.
  // 즉시 OpenAI 진급은 비용 spike 위험 (Gemini 일시 혼잡 ≠ 영구 한도 초과).
  // 짧은 backoff 로 quota 회복 시 그대로 Gemini 사용. 3회 모두 실패 시에만 OpenAI.
  const QUOTA_BACKOFF_MS = [100, 500, 1000];
  return async (prompt, profile) => {
    if (fallenBack) {
      const m = openaiModelFor(profile);
      return { text: await callOpenAI(prompt, m), usedModel: m, usedVendor: 'openai' };
    }
    const geminiModel = geminiModelFor(profile);
    let lastQuotaErr: GeminiQuotaError | null = null;
    for (let attempt = 0; attempt <= QUOTA_BACKOFF_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, QUOTA_BACKOFF_MS[attempt - 1]));
      }
      try {
        return { text: await callGemini(prompt, geminiModel), usedModel: geminiModel, usedVendor: 'gemini' };
      } catch (e) {
        if (e instanceof GeminiQuotaError) {
          lastQuotaErr = e;
          continue; // 다음 backoff 까지 대기 후 재시도
        }
        throw e;
      }
    }
    // 모든 backoff 실패 → 영구 한도 초과로 간주, OpenAI 로 sticky 진급
    fallenBack = true;
    if (process.env.OPENAI_API_KEY) {
      const m = openaiModelFor(profile);
      return { text: await callOpenAI(prompt, m), usedModel: m, usedVendor: 'openai' };
    }
    throw new Error(
      `Gemini 한도 초과 (${QUOTA_BACKOFF_MS.length + 1}회 backoff 실패) + OPENAI_API_KEY 없음. https://ai.studio/spend 또는 Railway에 OPENAI_API_KEY 추가 후 재시도. raw=${lastQuotaErr?.raw?.slice(0, 200) ?? ''}`,
    );
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
    // OCR 호출 단가는 LLM 풀이와 별개라 auto_pipeline_runs.model(LLM)에는 안 잡힘 →
    // api_call_logs 에 별도 라우트("/api/auto-pipeline:ocr")로 기록.
    // pdf-text 는 pdfjs(무료) 라 외부호출 X — 로깅 생략.
    if (extracted.ok && extracted.source !== 'pdf-text') {
      void apiCallLog({
        route: '/api/auto-pipeline:ocr',
        purpose: '해설 자동 제작 — 업로드 파일 OCR (풀이 생성 사전단계)',
        vendor: 'gemini',
        model: extracted.model || 'unknown',
        ok: true,
        units: extracted.pages && extracted.pages > 0 ? extracted.pages : 1,
        meta: { fileName: body.fileName, source: extracted.source },
      });
    }
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
  /** RAG 가 매칭한 비슷한 기출/예제 — UI 「유사 기출 N개」 카드 */
  similarReferences?: PipelineResult['similarReferences'];
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

  // 과거 비슷한 문제에서 사용자가 ★1~2 + 피드백 남긴 케이스를 찾아
  // 「검토 메모」 로 프롬프트에 주입 — 같은 실수 반복 방지.
  // Supabase 미설정·매칭 0건이면 빈 배열 → 기존 동선과 동일.
  let cautionNotes: string[] = [];
  try {
    cautionNotes = await findRelevantCautions(params.item.questionText, 3);
  } catch {
    // best-effort — 실패해도 풀이 진행
  }

  const result = await runAutoPipeline(params.item.questionText, {
    retriever: params.retriever,
    llmCall,
    topK: params.topK,
    maxRetries: params.maxRetries,
    cautionNotes,
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
    similarReferences: result.similarReferences,
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

  // 막누름 비용 폭탄 방지 — 이미 진행 중이면 새 호출 거부.
  // UI 가드(disabled={running}) 가 새로고침/우회로 무력화돼도 백엔드에서 막음.
  // progressState 는 모듈 전역 단일 (admin tool, 동시 1개 가정).
  if (progressState.stage === 'preparing' || progressState.stage === 'processing') {
    const elapsedMs = progressState.startedAt ? Date.now() - progressState.startedAt : 0;
    return NextResponse.json(
      {
        ok: false,
        error: `이전 요청 처리 중 (${Math.round(elapsedMs / 1000)}초 경과). 완료 후 다시 시도하세요.`,
        inProgress: true,
        progress: { ...progressState, elapsedMs },
      },
      { status: 409 },
    );
  }

  // 진행 상황 초기화 — preparing 단계로 시작
  startProgress(0);

  const resolved = await resolveItems(body);
  if (!resolved.ok) {
    setProgress({ stage: 'failed', error: resolved.error });
    return NextResponse.json({ ok: false, error: resolved.error }, { status: 400 });
  }
  setProgress({ total: resolved.items.length, stage: 'processing' });

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
      setProgress({
        currentIdx: 0,
        currentNo: resolved.items[0].questionNo,
        subStage: 'generating',
      });
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
      setProgress({ stage: 'completed', completedCount: 1, subStage: null });

      // 추출 메타가 0문항이면 분리 실패 경고 추가
      if (resolved.extracted && resolved.extracted.totalQuestions === 0) {
        row.manualReviewChecklist.push(
          '[문항 분리 실패] 추출된 텍스트에서 문항 번호를 인식하지 못했습니다 — 전체를 1문항으로 처리. PDF 품질·OCR 결과를 확인하세요.',
        );
      }

      // 「ok=false 인데 errors 가 비어 있는」 휑한 응답 방지.
      // parsed=null 인 모든 케이스에 진단성 기본 메시지를 1줄 채워, 클라이언트가
      // 「서버 200」 같은 무의미한 fallback 을 표시하지 않게 한다.
      if (row.parsed === null && row.errors.length === 0) {
        const checklistHint =
          Array.isArray(row.manualReviewChecklist) && row.manualReviewChecklist[0]
            ? ` (검수: ${String(row.manualReviewChecklist[0]).slice(0, 100)})`
            : '';
        const traceTail =
          Array.isArray(row.trace) && row.trace.length > 0
            ? ` [last stage=${row.trace[row.trace.length - 1]?.stage ?? 'unknown'}]`
            : '';
        row.errors.push(
          `풀이 결과가 비어 있습니다 (parsed=null) — 검증 단계 통과 못 했거나 모델 응답이 형식 어긋남.${checklistHint}${traceTail}`,
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
    let idx = 0;
    for (const item of resolved.items) {
      setProgress({
        currentIdx: idx,
        currentNo: item.questionNo,
        subStage: 'generating',
      });
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
        setProgress({ completedCount: idx + 1 });
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
        setProgress({ completedCount: idx + 1 });
      }
      idx += 1;
    }

    const partialFailures = runs.filter((r) => !r.parsed).length;
    setProgress({ stage: 'completed', subStage: null });
    return NextResponse.json({
      ok: partialFailures === 0,
      runs,
      partialFailures,
      extracted: resolved.extracted,
    });
  } catch (e) {
    setProgress({ stage: 'failed', error: (e as Error).message });
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

// 헬스체크용 (Railway 배포 후 GET으로 KB 크기 확인)
//
// 응답에 다음을 포함해 운영 가시성 확보:
//  - kb_size : 현재 retriever 가 보유한 record 수 (kb.jsonl + Drive 분석자료 합산)
//  - drive_sync : 분석용 자료 마지막 동기화 시각·status (UI 「N분 전 동기화」 표시용)
//  - supervisor : 감독관(retrospective) 마지막 자동 실행 요약 (HIGH 제안 수 등)
export async function GET() {
  try {
    const r = await getRetriever();
    // 동시 import — 둘 다 module 전역 스냅샷이라 비용 거의 0
    const [{ getDriveAnalysisSyncSnapshot }, supervisor] = await Promise.all([
      import('@/lib/driveAnalysisAutoSync'),
      import('@/lib/supervisorScheduler'),
    ]);
    const { getSupervisorSnapshot, getAutoSupervisorCautions } = supervisor;
    // instrumentation 등록 여부 확인 — Railway 빌드에서 안 호출되는 경우 진단용
    let instrumentationRegistered = false;
    try {
      const inst = await import("@/instrumentation");
      instrumentationRegistered = inst.instrumentationRegistered;
    } catch {
      // ignore
    }
    return NextResponse.json({
      ok: true,
      kb_size: r.size(),
      drive_sync: getDriveAnalysisSyncSnapshot(),
      supervisor: getSupervisorSnapshot(),
      supervisor_cautions: getAutoSupervisorCautions(),
      instrumentationRegistered,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
