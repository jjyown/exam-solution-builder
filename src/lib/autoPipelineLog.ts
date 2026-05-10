/**
 * autoPipelineLog.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  자동 파이프라인 실행을 Supabase에 영속화한다.
 *  Supabase 미설정 시 조용히 무시(로컬 개발 동선 유지).
 * ────────────────────────────────────────────────────────────────────────────
 */
import { getSupabaseServiceClient } from "./supabaseServiceClient";
import type { PipelineResult } from "./autoPipeline";

export type RunInput = {
  questionText: string;
  examName?: string;
  questionNo?: string;
  model: string;
  topK: number;
  maxRetries: number;
};

const TABLE = "auto_pipeline_runs";

/** 실행 직후 결과를 저장한다. 실패해도 throw 하지 않는다. */
export async function recordAutoPipelineRun(
  input: RunInput,
  result: PipelineResult,
  manualReviewChecklist: string[],
): Promise<{ id: string | null; persisted: boolean; error?: string }> {
  const client = getSupabaseServiceClient();
  if (!client) {
    console.warn("[autoPipelineLog] Supabase 클라이언트 생성 실패 — 환경변수 미설정");
    return { id: null, persisted: false };
  }

  const { data, error } = await client
    .from(TABLE)
    .insert({
      exam_name: input.examName ?? null,
      question_no: input.questionNo ?? null,
      question_text: input.questionText,
      model: input.model,
      top_k: input.topK,
      max_retries: input.maxRetries,
      ok: result.ok,
      attempts: result.attempts,
      parsed: result.parsed,
      trace: result.trace,
      errors: result.errors,
      manual_review_checklist: manualReviewChecklist,
    })
    .select("id")
    .single();

  if (error) {
    console.warn(`[autoPipelineLog] insert 실패: ${error.message}`);
    return { id: null, persisted: false, error: error.message };
  }
  return { id: data?.id ?? null, persisted: true };
}

export type FeedbackInput = {
  runId: string;
  userRating?: number;
  userFeedback?: string;
  finalBody?: string;
};

/** 사용자가 결과를 검수한 후 피드백·최종본을 덧붙인다. */
export async function recordUserFeedback(
  input: FeedbackInput,
): Promise<{ ok: boolean; error?: string }> {
  const client = getSupabaseServiceClient();
  if (!client) return { ok: false, error: "Supabase 미설정" };

  const update: Record<string, unknown> = {
    reviewed_at: new Date().toISOString(),
  };
  if (typeof input.userRating === "number") update.user_rating = input.userRating;
  if (input.userFeedback !== undefined) update.user_feedback = input.userFeedback;
  if (input.finalBody !== undefined) update.final_body = input.finalBody;

  const { error } = await client.from(TABLE).update(update).eq("id", input.runId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export type RunHistoryRow = {
  id: string;
  created_at: string;
  exam_name: string | null;
  question_no: string | null;
  question_text: string;
  model: string;
  ok: boolean;
  attempts: number;
  user_rating: number | null;
  reviewed_at: string | null;
  /** UI 「복원」 버튼이 결과 패널까지 되살리기 위한 컬럼 — 새로고침 후에도 보이게 함 */
  parsed?: unknown;
  trace?: unknown;
  errors?: string[] | null;
  manual_review_checklist?: string[] | null;
};

export type ListResult =
  | { status: "ok"; runs: RunHistoryRow[] }
  | { status: "no-env" }
  | { status: "no-table"; error: string }
  | { status: "error"; error: string };

/** 최근 실행 이력을 시간 역순으로 가져온다. 셋업 상태도 분류해 반환. */
export async function listRecentRunsWithStatus(limit = 30): Promise<ListResult> {
  const client = getSupabaseServiceClient();
  if (!client) return { status: "no-env" };

  const { data, error } = await client
    .from(TABLE)
    .select(
      "id, created_at, exam_name, question_no, question_text, model, ok, attempts, user_rating, reviewed_at, parsed, trace, errors, manual_review_checklist",
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (/schema cache/i.test(error.message) || /relation .* does not exist/i.test(error.message)) {
      return { status: "no-table", error: error.message };
    }
    return { status: "error", error: error.message };
  }
  return { status: "ok", runs: (data ?? []) as RunHistoryRow[] };
}

/** 하위 호환 — 기존 호출자용 */
export async function listRecentRuns(limit = 30): Promise<RunHistoryRow[]> {
  const r = await listRecentRunsWithStatus(limit);
  return r.status === "ok" ? r.runs : [];
}

/**
 * 비슷한 문제에서 사용자가 낮은 평점(≤2)을 줬을 때 남긴 피드백을 가져온다.
 * 새 문제 풀이 시 프롬프트에 「과거 비슷한 문제 검토 메모」 로 주입해
 * 같은 실수를 반복하지 않게 한다.
 *
 * 매칭 휴리스틱:
 *  - 새 문제 텍스트에서 의미있는 한글·수식 토큰 추출 (2글자 이상)
 *  - 상위 8개 토큰 중 하나라도 question_text 에 포함된 row 검색
 *  - user_rating <= 2 AND user_feedback 비어있지 않은 것만
 *  - 최근 90일 안 + 최대 limit 건
 *
 *  반환: 사람이 읽기 좋은 한 줄 요약 배열 (프롬프트에 그대로 삽입 가능).
 *  Supabase 미설정/조회 실패 시 빈 배열 — 기존 동선 영향 없음.
 */
export async function findRelevantCautions(
  questionText: string,
  limit = 3,
): Promise<string[]> {
  // 감독관(supervisor)이 retrospective 결과에서 자동 추출한 메모를 항상 먼저 포함.
  // 사용자가 별점 안 남겨도 이게 다음 호출에 「같은 실수 반복 금지」 가이드로 작동.
  let supervisorNotes: string[] = [];
  try {
    const sup = await import("./supervisorScheduler");
    supervisorNotes = sup.getAutoSupervisorCautions().slice(0, 3);
  } catch {
    /* best-effort */
  }

  const client = getSupabaseServiceClient();
  if (!client) return supervisorNotes;

  const tokens = extractMatchingTokens(questionText);
  if (tokens.length === 0) return supervisorNotes;

  // PostgREST or 절: question_text.ilike.%token1%,question_text.ilike.%token2%,...
  // 너무 흔한 한 글자 토큰은 제외해 노이즈 차단
  const orClauses = tokens
    .slice(0, 8)
    .map((t) => `question_text.ilike.%${escapeIlike(t)}%`)
    .join(",");

  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await client
    .from(TABLE)
    .select("question_text, question_no, user_rating, user_feedback, created_at")
    .lte("user_rating", 2)
    .not("user_feedback", "is", null)
    .gte("created_at", since)
    .or(orClauses)
    .order("created_at", { ascending: false })
    .limit(Math.max(limit * 3, 6));

  if (error || !data) return supervisorNotes;

  // 같은 피드백 중복 제거 후 limit 만큼만 — 감독관 자동 메모와 합쳐 반환
  const seen = new Set<string>();
  const userNotes: string[] = [];
  for (const row of data as Array<{
    question_text: string | null;
    question_no: string | null;
    user_rating: number | null;
    user_feedback: string | null;
  }>) {
    const fb = (row.user_feedback ?? "").trim();
    if (!fb) continue;
    const key = fb.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    const qno = row.question_no ? `(과거 ${row.question_no}번) ` : "";
    userNotes.push(`${qno}${fb.slice(0, 240)}`);
    if (userNotes.length >= limit) break;
  }
  return [...supervisorNotes, ...userNotes];
}

/** 한글·영문·수식 토큰 추출 — 2글자 이상, 흔한 어미·조사 제외. */
function extractMatchingTokens(text: string): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  // 한글 단어 / 영문 단어 / LaTeX 명령
  const re = /(?:[가-힣]{2,}|[A-Za-z]{3,}|\\[a-zA-Z]+)/g;
  const stop = new Set([
    "이때", "그리고", "그러므로", "따라서", "다음", "구하시오", "구하라", "보기",
    "정답", "문제", "문항", "해설", "있다", "없다", "이다", "되다", "위하여",
    "대하여", "사이", "모든", "어떤", "최댓값", "최솟값",
  ]);
  const counts = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const tok = m[0];
    if (stop.has(tok)) continue;
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, 20);
}

function escapeIlike(s: string): string {
  return s.replace(/[%_,]/g, " ").replace(/\s+/g, " ").trim();
}
