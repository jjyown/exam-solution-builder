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
      "id, created_at, exam_name, question_no, question_text, model, ok, attempts, user_rating, reviewed_at",
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
