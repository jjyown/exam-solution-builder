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
};

function rowToRecord(r: Row): ReferenceRecord {
  return {
    id: r.id,
    source: r.source,
    problem_hint: r.problem_hint ?? "",
    content: r.content,
    equations: Array.isArray(r.equations) ? r.equations : [],
    answer: r.answer ?? "",
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

/** 사용자 검색 (problem_hint + content trigram). limit 기본 30. */
export async function searchAnalysisRecords(
  query: string,
  limit = 30,
): Promise<Array<ReferenceRecord & { snippet: string }>> {
  const sb = getSupabaseServiceClient();
  if (!sb) return [];
  const q = query.trim();
  if (!q) return [];
  // ilike 단순 부분일치 — 한국어 trigram 인덱스가 있어 빠름
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .or(`problem_hint.ilike.%${q}%,content.ilike.%${q}%`)
    .limit(limit);
  if (error || !data) return [];
  return (data as Row[]).map((r) => {
    const rec = rowToRecord(r);
    // 짧은 snippet 만들기
    const lower = r.content.toLowerCase();
    const idx = lower.indexOf(q.toLowerCase());
    const start = Math.max(0, idx - 40);
    const end = Math.min(r.content.length, (idx >= 0 ? idx : 0) + 80);
    const snippet = (start > 0 ? "…" : "") + r.content.slice(start, end) + (end < r.content.length ? "…" : "");
    return { ...rec, snippet };
  });
}
