/**
 * pairingAssistedRefiner.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  규칙 기반(parseProblemSolutionPairs + analysisTextNormalizer) 으로도 페어가
 *  못 묶인 record 들을 모아, gemini-2.0-flash (저렴) 한 번 호출로 일괄 분류한다.
 *
 *  방식 (효율 우선):
 *   1) 같은 series 안 unpaired record 들을 묶어 한 프롬프트로 보냄 (배치)
 *   2) 모델은 각 record 가 「문제」인지 「풀이」인지, problem_no 가 무엇인지만
 *      JSON 으로 회신 (긴 본문 재OCR 안 함 — 분류만)
 *   3) 회신을 바탕으로 같은 series + 같은 problem_no 의 문제 ↔ 풀이 record 끼리
 *      Supabase 에서 join 하여 solution_text 컬럼에 채워 넣음 (실제 적용은 별도 단계)
 *
 *  비용 절감:
 *   - 모델 기본값: gemini-2.0-flash (입력 1M 토큰 ≈ $0.10, 분류만이라 출력 짧음)
 *   - 환경변수 ASSISTED_PAIRING_MODEL 로 변경 가능
 *   - env 게이트: ASSISTED_PAIRING_ENABLED=true 일 때만 동작
 *   - 배치 크기 제한: 기본 30 record / 호출
 *   - record 본문은 200자만 보냄 (분류에 충분, 토큰 절약)
 *
 *  적용:
 *   - 호출 결과 → analysisRecordsStore.applyAssistedPairing(plan) (별도 함수)
 *   - dry-run 모드 (apply=false) 로 결과만 보고 적용 안 가능
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { ReferenceRecord } from "./referenceRetriever";
import { GoogleGenerativeAI } from "@google/generative-ai";

export type PairingPlan = {
  /** 모델이 분류한 결과 — record id 기준 */
  classifications: Array<{
    id: string;
    side: "problem" | "solution" | "unknown";
    /** 모델이 추정한 problem_no (없으면 null) */
    problemNo: number | null;
    /** 모델이 같이 본 series 키 */
    series: string;
    /** 신뢰도 — 0~1, 모델이 낮게 답하면 적용 보류 */
    confidence: number;
  }>;
  /** 토큰·호출 통계 */
  stats: {
    callsMade: number;
    recordsProcessed: number;
    estimatedCostUsd: number;
    model: string;
  };
};

export type AssistedPairingOptions = {
  /** 한 호출에 묶을 최대 record 수 (기본 30) */
  batchSize?: number;
  /** 사용할 Gemini 모델 (기본 ASSISTED_PAIRING_MODEL or gemini-2.0-flash) */
  model?: string;
  /** dry-run — 모델 호출은 하지만 적용은 별도 단계 */
  dryRun?: boolean;
};

const DEFAULT_BATCH_SIZE = 30;

export function isAssistedPairingEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.ASSISTED_PAIRING_ENABLED || "");
}

function resolveModel(opts?: AssistedPairingOptions): string {
  return opts?.model || process.env.ASSISTED_PAIRING_MODEL || "gemini-2.0-flash";
}

/**
 * unpaired record 만 골라 series 별로 그룹화 → 모델 호출 → 분류 plan 반환.
 * 적용(Supabase update)은 호출자가 별도로 결정.
 */
export async function buildAssistedPairingPlan(
  unpairedRecords: ReferenceRecord[],
  opts: AssistedPairingOptions = {},
): Promise<PairingPlan> {
  const model = resolveModel(opts);
  const batchSize = opts.batchSize || DEFAULT_BATCH_SIZE;
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY 미설정 — 보조 페어 매핑 비활성");
  }
  if (unpairedRecords.length === 0) {
    return {
      classifications: [],
      stats: { callsMade: 0, recordsProcessed: 0, estimatedCostUsd: 0, model },
    };
  }

  const client = new GoogleGenerativeAI(apiKey);
  const ai = client.getGenerativeModel({
    model,
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  });

  // series 별 그룹화 — 같은 시리즈 안에서 묶어 분류해야 problem_no 매칭 정확도 ↑
  const bySeries = new Map<string, ReferenceRecord[]>();
  for (const r of unpairedRecords) {
    const key = (r.pair_series && r.pair_series.trim()) || r.source.split("/").pop() || "(unknown)";
    const arr = bySeries.get(key) ?? [];
    arr.push(r);
    bySeries.set(key, arr);
  }

  const classifications: PairingPlan["classifications"] = [];
  let callsMade = 0;
  let totalRecs = 0;

  for (const [series, records] of bySeries) {
    // 한 series 가 너무 크면 batchSize 단위로 잘라서 호출
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      callsMade += 1;
      totalRecs += batch.length;
      try {
        const prompt = buildPrompt(series, batch);
        const res = await ai.generateContent(prompt);
        const text = res.response.text() || "[]";
        const parsed = parseClassification(text);
        for (const item of parsed) {
          classifications.push({ ...item, series });
        }
      } catch {
        // 한 배치 실패해도 다음 진행 — 부분 적용 허용
      }
      if (opts.dryRun && callsMade >= 3) {
        // dry-run 표본만 — 더 도는 의미 없음
        break;
      }
    }
    if (opts.dryRun && callsMade >= 3) break;
  }

  // 비용 추정 — gemini-2.0-flash 기준 (대략적)
  // 입력 1M 토큰 ≈ $0.10, 출력 1M ≈ $0.40. record 당 평균 250자 입력 + 출력 150자 가정.
  const estimatedCostUsd = (totalRecs * 250 / 1e6) * 0.1 + (totalRecs * 150 / 1e6) * 0.4;

  return {
    classifications,
    stats: { callsMade, recordsProcessed: totalRecs, estimatedCostUsd, model },
  };
}

function buildPrompt(series: string, batch: ReferenceRecord[]): string {
  const records = batch.map((r, i) => ({
    id: r.id,
    idx: i,
    snippet: (r.content || r.solution_text || "").replace(/\s+/g, " ").slice(0, 200),
    existingProblemNo: typeof r.problem_no === "number" ? r.problem_no : null,
    hasContent: !!r.content,
    hasSolution: !!r.solution_text,
  }));

  return [
    `너는 한국 수학 교재 OCR 결과를 정리하는 분류기다. 시리즈 "${series}" 의 다음 record 들을`,
    `각각 「문제(problem)」/「풀이(solution)」 / 「판단불가(unknown)」 로 분류하고 problem_no 를 추정한다.`,
    "",
    "분류 단서:",
    "- '구하시오', '~인 것은?', '~의 값은?' 같은 발문 → problem",
    "- '∴', 'i)', 'ii)', '따라서', '∵', '풀이', '[정답]' → solution",
    "- '예제 N', 'N.', 'N)' 형태로 시작하는 본문 → 그 N 이 problem_no 후보",
    "- 풀이 안 '[정답] ② ' 같은 라인 → problem_no 는 그 풀이가 다루는 번호",
    "",
    "응답 형식: 다음 JSON 배열만 (코드펜스 없이, 다른 텍스트 없이):",
    `[{"id":"...","side":"problem","problemNo":7,"confidence":0.9}, ...]`,
    "",
    `record 입력 (${batch.length}건):`,
    JSON.stringify(records, null, 2),
  ].join("\n");
}

function parseClassification(
  raw: string,
): Array<{ id: string; side: "problem" | "solution" | "unknown"; problemNo: number | null; confidence: number }> {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.id === "string")
      .map((x) => ({
        id: String(x.id),
        side: x.side === "problem" || x.side === "solution" ? x.side : "unknown",
        problemNo: typeof x.problemNo === "number" ? x.problemNo : null,
        confidence: typeof x.confidence === "number" ? x.confidence : 0,
      }));
  } catch {
    return [];
  }
}
