/**
 * analysisRecordsStore.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  분석용 자료 Gemini OCR 결과를 Supabase `analysis_records` 테이블에 영구 저장.
 *  Railway 재배포·재시작 후에도 OCR 비용 들이지 않고 바로 사용 가능.
 *
 *  핵심 룰:
 *   - 같은 drive_file_id 라도 drive_modified_time 이 다르면 옛 row 모두 삭제하고
 *     새 chunk 들로 교체 (수정된 PDF 재 OCR 결과를 깨끗하게 반영).
 *   - Supabase 미설정 시(키 없음) 모든 작업 no-op → in-memory fallback 만 동작.
 *
 *  스키마: supabase/analysis_records.sql 참고.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { ReferenceRecord } from "./referenceRetriever";
import { getSupabaseServiceClient } from "./supabaseServiceClient";

const TABLE = "analysis_records";

type Row = {
  id: string;
  drive_file_id: string;
  drive_modified_time: string | null;
  source: string;
  problem_hint: string | null;
  content: string;
  equations: string[] | null;
  answer: string | null;
  // 1:1 매핑
  problem_no: number | null;
  solution_text: string | null;
  solution_equations: string[] | null;
  pair_series: string | null;
};

function rowToRecord(r: Row): ReferenceRecord {
  return {
    id: r.id,
    source: r.source,
    problem_hint: r.problem_hint ?? "",
    content: r.content,
    equations: Array.isArray(r.equations) ? r.equations : [],
    answer: r.answer ?? "",
    problem_no: r.problem_no ?? undefined,
    solution_text: r.solution_text ?? undefined,
    solution_equations: Array.isArray(r.solution_equations) ? r.solution_equations : undefined,
    pair_series: r.pair_series ?? undefined,
  };
}

/** 특정 drive 파일의 캐시된 OCR 결과를 가져온다. modifiedTime 이 일치할 때만 적중. */
export async function fetchCachedRecords(
  driveFileId: string,
  driveModifiedTime: string | null,
): Promise<ReferenceRecord[] | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  let q = sb.from(TABLE).select("*").eq("drive_file_id", driveFileId);
  if (driveModifiedTime) {
    q = q.eq("drive_modified_time", driveModifiedTime);
  } else {
    q = q.is("drive_modified_time", null);
  }
  const { data, error } = await q;
  if (error || !data || data.length === 0) return null;
  return (data as Row[]).map(rowToRecord);
}

/**
 * 저장: 같은 driveFileId 의 옛 row 모두 삭제 후 새 records 일괄 insert.
 * insert 실패해도 silent — 다음 호출에 다시 시도.
 */
export async function persistRecordsForFile(
  driveFileId: string,
  driveModifiedTime: string | null,
  records: ReferenceRecord[],
): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  await sb.from(TABLE).delete().eq("drive_file_id", driveFileId);
  if (records.length === 0) return;
  const rows = records.map((r) => ({
    id: r.id,
    drive_file_id: driveFileId,
    drive_modified_time: driveModifiedTime,
    source: r.source,
    problem_hint: r.problem_hint || "",
    content: r.content,
    equations: r.equations,
    answer: r.answer,
    problem_no: r.problem_no ?? null,
    solution_text: r.solution_text ?? null,
    solution_equations: r.solution_equations ?? [],
    pair_series: r.pair_series ?? null,
  }));
  await sb.from(TABLE).insert(rows);
}

/** Drive 에서 사라진 파일의 row 들 정리 — sync 끝나고 호출. */
export async function pruneOrphanRecords(
  presentDriveFileIds: string[],
): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) return 0;
  if (presentDriveFileIds.length === 0) {
    // 분석용 자료 폴더가 비었으면 전체 삭제는 위험하므로 noop
    return 0;
  }
  // not in (...) 를 PostgREST 로 — neq 들 조합이 어색하므로 raw 비교
  const { data, error } = await sb
    .from(TABLE)
    .delete()
    .not("drive_file_id", "in", `(${presentDriveFileIds.map((id) => `"${id}"`).join(",")})`)
    .select("id");
  if (error || !data) return 0;
  return data.length;
}

/** 전체 캐시 한 번에 가져오기 (서버 startup 시 retriever hydration 등에 활용 가능) */
export async function fetchAllRecords(): Promise<ReferenceRecord[]> {
  const sb = getSupabaseServiceClient();
  if (!sb) return [];
  const { data, error } = await sb.from(TABLE).select("*").limit(50000);
  if (error || !data) return [];
  return (data as Row[]).map(rowToRecord);
}

/**
 * 보조 페어 매핑 plan 을 Supabase 에 적용.
 *
 * plan.classifications 를 보고 같은 series + 같은 problem_no 의
 * problem record 와 solution record 를 join — solution record 의 content 를
 * problem record 의 solution_text 에 채워 넣고, solution record 는 보조 chunk 로 둔다.
 *
 * 보수적으로 동작:
 *  - confidence < 0.6 인 분류는 적용 안 함
 *  - 같은 (series, problemNo) 에 problem 이 둘 이상이면 가장 긴 쪽을 정본
 *  - 이미 solution_text 가 채워져 있으면 덮어쓰지 않음
 *  - 모든 변경은 row 단위 update — 트랜잭션 아님 (Supabase JS 한계)
 *
 * 반환: 적용 통계 + 미적용 사유
 */
export async function applyAssistedPairing(plan: {
  classifications: Array<{
    id: string;
    side: "problem" | "solution" | "unknown";
    problemNo: number | null;
    series: string;
    confidence: number;
  }>;
  stats: { callsMade: number; recordsProcessed: number; model: string };
}): Promise<{ updated: number; skipped: number; failures: string[] }> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { updated: 0, skipped: 0, failures: ["supabase 미설정"] };

  let updated = 0;
  let skipped = 0;
  const failures: string[] = [];

  // (series, problemNo) → { problem ids[], solution ids[] }
  type Bucket = { problems: string[]; solutions: string[] };
  const buckets = new Map<string, Bucket>();
  for (const c of plan.classifications) {
    if (c.confidence < 0.6) {
      skipped += 1;
      continue;
    }
    if (c.problemNo === null || c.side === "unknown") {
      skipped += 1;
      continue;
    }
    const key = `${c.series}::${c.problemNo}`;
    const b = buckets.get(key) ?? { problems: [], solutions: [] };
    if (c.side === "problem") b.problems.push(c.id);
    else b.solutions.push(c.id);
    buckets.set(key, b);
  }

  // 각 bucket 마다 한 번 update — problem 이 있고 solution 도 있는 경우만
  for (const [, bucket] of buckets) {
    if (bucket.problems.length === 0 || bucket.solutions.length === 0) {
      skipped += bucket.problems.length + bucket.solutions.length;
      continue;
    }
    // 정본 problem: 가장 긴 content 가진 record
    const allIds = [...bucket.problems, ...bucket.solutions];
    const { data, error } = await sb.from(TABLE).select("*").in("id", allIds);
    if (error || !data) {
      failures.push(error?.message || "fetch 실패");
      continue;
    }
    const rows = data as Row[];
    const problems = rows.filter((r) => bucket.problems.includes(r.id));
    const solutions = rows.filter((r) => bucket.solutions.includes(r.id));
    if (problems.length === 0 || solutions.length === 0) {
      skipped += rows.length;
      continue;
    }
    const primaryProblem = problems.reduce((a, b) => (a.content.length >= b.content.length ? a : b));
    const bestSolution = solutions.reduce((a, b) =>
      (a.content?.length ?? 0) >= (b.content?.length ?? 0) ? a : b,
    );
    if (primaryProblem.solution_text && primaryProblem.solution_text.trim()) {
      // 이미 채워져 있으면 안 건드림
      skipped += 1;
      continue;
    }
    const { error: updErr } = await sb
      .from(TABLE)
      .update({
        solution_text: bestSolution.content,
        solution_equations: bestSolution.equations ?? [],
      })
      .eq("id", primaryProblem.id);
    if (updErr) {
      failures.push(`${primaryProblem.id}: ${updErr.message}`);
      continue;
    }
    updated += 1;
  }

  return { updated, skipped, failures };
}

/** 사용자 검색 (problem_hint + content + solution_text trigram). limit 기본 30. */
export async function searchAnalysisRecords(
  query: string,
  limit = 30,
): Promise<Array<ReferenceRecord & { snippet: string; matchedIn: "problem" | "solution" | "hint" }>> {
  const sb = getSupabaseServiceClient();
  if (!sb) return [];
  const q = query.trim();
  if (!q) return [];
  // ilike 단순 부분일치 — 한국어 trigram 인덱스가 있어 빠름. 풀이 본문도 검색 대상.
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .or(
      `problem_hint.ilike.%${q}%,content.ilike.%${q}%,solution_text.ilike.%${q}%`,
    )
    .limit(limit);
  if (error || !data) return [];
  return (data as Row[]).map((r) => {
    const rec = rowToRecord(r);
    const lq = q.toLowerCase();
    // 매칭된 위치를 우선순위로 검색 (문제 → 풀이 → 힌트)
    const candidates: Array<{ field: "problem" | "solution" | "hint"; text: string }> = [
      { field: "problem", text: r.content || "" },
      { field: "solution", text: r.solution_text || "" },
      { field: "hint", text: r.problem_hint || "" },
    ];
    const found =
      candidates.find((c) => c.text.toLowerCase().includes(lq)) || candidates[0];
    const idx = found.text.toLowerCase().indexOf(lq);
    const start = Math.max(0, idx - 40);
    const end = Math.min(found.text.length, (idx >= 0 ? idx : 0) + 100);
    const snippet =
      (start > 0 ? "…" : "") +
      found.text.slice(start, end) +
      (end < found.text.length ? "…" : "");
    return { ...rec, snippet, matchedIn: found.field };
  });
}
