/**
 * analysisRecordsBackfill.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  기존 analysis_records 의 content 에서 problem_no 를 사후 추출해 채워 넣는다.
 *  재OCR 없이 텍스트 분석만 하므로 비용 0.
 *
 *  배경:
 *   - 처음 학습 시점에는 analysisTextNormalizer 패턴이 미흡해 problem_no 가
 *     null 로 저장된 record 가 다수 존재 (예: 시험지 원안의 「1.」 「2.」 패턴 미인식).
 *   - Drive 의 modifiedTime 이 같으면 캐시 hit 으로 재OCR 안 함 → 새 패턴이
 *     기존 record 에 적용 안 됨.
 *   - 이 모듈은 record 의 content 를 다시 normalize/추출 → problem_no 만 update.
 *
 *  보수적 동작:
 *   - 이미 problem_no 가 있는 record 는 건드리지 않음
 *   - 추출 휴리스틱: 본문 시작 부분(첫 200자)에서 「N.」 「N)」 「[문항 N]」 「N번」 패턴
 *     중 가장 신뢰도 높은 첫 매치 사용
 *   - 1~99 범위 + 단순 숫자(1.5 같은 소수 차단)
 *
 *  실행:
 *   - POST /api/drive/analysis/backfill-pairing
 *   - dry-run 모드로 미리보기 가능
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { ReferenceRecord } from "./referenceRetriever";
import { getSupabaseServiceClient } from "./supabaseServiceClient";

const TABLE = "analysis_records";

/**
 * 한 record 의 content 에서 problem_no 한 개 추출.
 * 못 찾으면 null. 본문 시작 200자 우선 — 페이지 헤더의 번호가 가장 신뢰도 높음.
 */
export function extractProblemNoFromContent(content: string): number | null {
  if (!content) return null;
  const head = content.replace(/\s+/g, " ").slice(0, 250).trim();

  // 우선순위:
  //  1) [문항 N] / [해설 N]  — analysisTextNormalizer 가 표준화한 신뢰도 최고 마커
  //  2) **N.** / **N)**     — 시중교재 굵게 처리 (Mathpix)
  //  3) 「예제 N」「유형 N」「문제 N」 「문항 N」 — 시중교재 라벨
  //  4) 본문 시작 「N.」 「N)」 + 한글/$/괄호  — 시험지 원안 페이지 시작 번호
  //  5) 「N번」 — 한글 보조 표기

  const patterns: RegExp[] = [
    /\[(?:문항|해설)\s*(\d{1,3})\]/,
    /\*\*\s*(\d{1,3})\s*[\.)]\s*\*\*/,
    /(?:예제|유형|문제|문항)\s*(\d{1,3})\b/,
    /^\s*(\d{1,2})\s*[\.\)]\s+[가-힣\$\(\\\[°∀-⋿]/,  // 시험지 원안: 줄 시작 번호 + 한글/수식
    /\b(\d{1,2})\s*번\b/,
  ];

  for (const re of patterns) {
    const m = head.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 1 && n <= 99) {
        return n;
      }
    }
  }
  return null;
}

export type BackfillResult = {
  scanned: number;
  alreadyHadProblemNo: number;
  extracted: number;     // 새로 추출된 record 수
  applied: number;       // 실제 update 된 row (dry=false)
  failures: string[];
  samples: Array<{ id: string; source: string; problemNo: number; snippet: string }>;
};

/**
 * 모든 analysis_records 를 스캔해 problem_no 가 null 인 row 에 대해
 * content 에서 problem_no 추출 시도.
 *
 *  opts.dryRun: true 면 update 안 하고 결과만 반환
 *  opts.maxApply: 최대 update 수 (안전 제한)
 */
export async function backfillProblemNumbers(opts?: {
  dryRun?: boolean;
  maxApply?: number;
}): Promise<BackfillResult> {
  const result: BackfillResult = {
    scanned: 0,
    alreadyHadProblemNo: 0,
    extracted: 0,
    applied: 0,
    failures: [],
    samples: [],
  };
  const sb = getSupabaseServiceClient();
  if (!sb) {
    result.failures.push("Supabase 미설정");
    return result;
  }
  const dryRun = !!opts?.dryRun;
  const maxApply = opts?.maxApply ?? 5000;

  // 모든 record 조회 — limit 50000 (실제론 1만 미만 가정)
  const { data, error } = await sb
    .from(TABLE)
    .select("id, source, content, problem_no")
    .limit(50000);
  if (error || !data) {
    result.failures.push(`조회 실패: ${error?.message ?? "no data"}`);
    return result;
  }
  result.scanned = data.length;

  type Row = Pick<ReferenceRecord, "id" | "source"> & {
    problem_no: number | null;
    content: string;
  };

  // 추출 + 후보 누적
  type Candidate = { id: string; source: string; problemNo: number; snippet: string };
  const candidates: Candidate[] = [];

  for (const r of data as Row[]) {
    if (typeof r.problem_no === "number") {
      result.alreadyHadProblemNo += 1;
      continue;
    }
    const no = extractProblemNoFromContent(r.content || "");
    if (no === null) continue;
    result.extracted += 1;
    candidates.push({
      id: r.id,
      source: r.source,
      problemNo: no,
      snippet: (r.content || "").replace(/\s+/g, " ").slice(0, 80),
    });
  }

  // 처음 30개 샘플
  result.samples = candidates.slice(0, 30);

  if (dryRun) return result;

  // 실제 update — 한 row 씩 (Supabase JS bulk upsert 는 별도 endpoint 필요)
  // maxApply 까지 적용
  const apply = candidates.slice(0, maxApply);
  for (const c of apply) {
    const { error: upErr } = await sb
      .from(TABLE)
      .update({ problem_no: c.problemNo })
      .eq("id", c.id);
    if (upErr) {
      result.failures.push(`${c.id}: ${upErr.message}`);
      continue;
    }
    result.applied += 1;
  }
  return result;
}
