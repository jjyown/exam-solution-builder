/**
 * analysisIntegrityCheck.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  driveAnalysisLearner 가 만든 ReferenceRecord[] 를 검사해 다음을 식별한다:
 *
 *   1) 「누락」: 같은 series 안에서 problem_no 시퀀스에 빈 번호가 있을 때
 *      예: series="쎈 대수", 본 번호 = [1, 2, 3, 5, 6] → 4번 누락
 *   2) 「중복」: 같은 (series, problem_no) 가 두 번 이상 나올 때
 *      → OCR 실수로 같은 페이지가 두 번 들어왔거나 페이지 중복 가능성
 *   3) 「풀이 누락」: problem_no 는 있지만 solution_text 가 비어있는 record
 *      → 1:1 페어 매핑이 깨진 단위
 *
 *  비용 0 — 순수 규칙 기반. 학습 끝난 직후 호출하면 summary 에 한꺼번에 누적.
 *  AI 보조 정제는 별도 모듈(pairingAssistedRefiner)에서 unpaired 만 골라 호출.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { ReferenceRecord } from "./referenceRetriever";

export type IntegrityIssue =
  | {
      kind: "missing";
      series: string;          // pair_series 또는 source 폴더 path
      missingNos: number[];    // 빈 번호들
      range: [number, number]; // 추정 시리즈 범위
      knownCount: number;
    }
  | {
      kind: "duplicate";
      series: string;
      problemNo: number;
      sources: string[];       // 중복으로 보이는 record 의 source 들 (디버깅)
      contentDigests: string[]; // 본문 앞부분 해시 — 진짜 중복인지 사람이 판단
    }
  | {
      kind: "unpaired";
      series: string;
      problemNo: number;
      side: "missing-solution" | "missing-problem";
      source: string;
      contentSnippet: string;
    };

export type IntegrityReport = {
  totalRecords: number;
  totalSeries: number;
  issues: IntegrityIssue[];
  /** kind 별 카운트 — 임계 검사·UI 요약용 */
  counts: { missing: number; duplicate: number; unpaired: number };
};

/**
 * series 키 결정 — pair_series 가 있으면 우선, 없으면 source 의 파일명 stem.
 * 같은 PDF 안 [문항 N]/[해설 N] 페어는 source 가 같아 자연스럽게 한 series 로 묶임.
 */
function resolveSeriesKey(rec: ReferenceRecord): string {
  if (rec.pair_series && rec.pair_series.trim()) return rec.pair_series.trim();
  const src = rec.source || "";
  // "drive/분석용자료/시중교재/EBS_2024.pdf" → "EBS_2024.pdf"
  const tail = src.split("/").pop() || src;
  return tail || "(unknown)";
}

/** 본문 앞 80자 정규화 — 같은 페이지 OCR 두 번 들어왔는지 거칠게 비교 */
function digestContent(rec: ReferenceRecord): string {
  const body = ((rec.content || "") + " " + (rec.solution_text || "")).replace(/\s+/g, " ").trim();
  return body.slice(0, 80);
}

export function checkIntegrity(records: ReferenceRecord[]): IntegrityReport {
  const issues: IntegrityIssue[] = [];

  // series 별로 그룹화
  const bySeries = new Map<string, ReferenceRecord[]>();
  for (const r of records) {
    if (typeof r.problem_no !== "number") continue;
    const k = resolveSeriesKey(r);
    const arr = bySeries.get(k) ?? [];
    arr.push(r);
    bySeries.set(k, arr);
  }

  for (const [series, list] of bySeries) {
    // 같은 (series, problem_no) 그룹 — 중복 후보
    const byNo = new Map<number, ReferenceRecord[]>();
    for (const r of list) {
      const arr = byNo.get(r.problem_no!) ?? [];
      arr.push(r);
      byNo.set(r.problem_no!, arr);
    }

    // 1) 중복 검출 — 같은 번호가 둘 이상이면서 본문이 거의 같으면 진짜 중복
    for (const [no, group] of byNo) {
      if (group.length < 2) continue;
      const digests = group.map(digestContent);
      const uniq = new Set(digests);
      // 본문 digest 가 거의 같으면 중복, 다르면 (다른 페이지가 같은 번호로 라벨) 도 알림
      issues.push({
        kind: "duplicate",
        series,
        problemNo: no,
        sources: Array.from(new Set(group.map((g) => g.source))),
        contentDigests: Array.from(uniq).slice(0, 3),
      });
    }

    // 2) 누락 검출 — 알려진 번호의 min~max 범위에서 빠진 번호
    const knownNos = Array.from(byNo.keys()).sort((a, b) => a - b);
    if (knownNos.length >= 3) {
      // 의미 있는 시리즈만 (3개 이상 잡힌 series)
      const lo = knownNos[0];
      const hi = knownNos[knownNos.length - 1];
      const present = new Set(knownNos);
      const missing: number[] = [];
      for (let n = lo; n <= hi; n += 1) {
        if (!present.has(n)) missing.push(n);
      }
      // 너무 큰 시리즈에서 듬성 인식되면 false-positive 큼 — 빈 번호 비율로 게이트
      const missRatio = missing.length / (hi - lo + 1);
      if (missing.length > 0 && missRatio < 0.5) {
        issues.push({
          kind: "missing",
          series,
          missingNos: missing,
          range: [lo, hi],
          knownCount: knownNos.length,
        });
      }
    }

    // 3) 풀이 누락 — problem_no 있는데 solution_text 없음
    for (const r of list) {
      const hasSolution = !!(r.solution_text && r.solution_text.trim());
      const hasProblem = !!(r.content && r.content.trim());
      if (!hasSolution && hasProblem) {
        issues.push({
          kind: "unpaired",
          series,
          problemNo: r.problem_no!,
          side: "missing-solution",
          source: r.source,
          contentSnippet: r.content.replace(/\s+/g, " ").slice(0, 100),
        });
      } else if (hasSolution && !hasProblem) {
        issues.push({
          kind: "unpaired",
          series,
          problemNo: r.problem_no!,
          side: "missing-problem",
          source: r.source,
          contentSnippet: r.solution_text!.replace(/\s+/g, " ").slice(0, 100),
        });
      }
    }
  }

  return {
    totalRecords: records.length,
    totalSeries: bySeries.size,
    issues,
    counts: {
      missing: issues.filter((i) => i.kind === "missing").length,
      duplicate: issues.filter((i) => i.kind === "duplicate").length,
      unpaired: issues.filter((i) => i.kind === "unpaired").length,
    },
  };
}
