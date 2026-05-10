/**
 * supervisorScheduler.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  「감독관」 백그라운드 루프.
 *
 *  retrospective.ts 가 누적 데이터를 분석해 개선 제안을 만들어 주지만 — 사람이
 *  /api/retrospective 를 직접 호출해야만 동작했다. 이 모듈은 그걸 주기적으로
 *  자동 실행해 다음을 수행한다:
 *
 *   1) generateRetrospective() 자동 호출
 *   2) HIGH priority 제안이 있으면 명시적으로 console.warn — Railway 로그에 남음
 *   3) 마지막 실행 결과(요약 + suggestions)를 모듈 전역에 보관 →
 *      /api/auto-pipeline GET 헬스체크에서 노출 가능
 *
 *  주기: SUPERVISOR_INTERVAL_MS (기본 6시간 = 21,600,000ms).
 *        0 또는 음수면 비활성. retrospective 는 read-only 분석이라 비용 거의 없음.
 *  첫 실행: startup 후 90초 (Drive 자동 동기화 60초 뒤보다 살짝 늦게 — DB 안정화).
 *
 *  실패 시 silent — 다음 주기에 재시도.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { ImprovementSuggestion, RetrospectiveReport } from "./retrospective";

let started = false;
let inProgress = false;

export type SupervisorSnapshot = {
  ranAt: number | null;
  ok: boolean;
  totalRuns: number;
  successRate: number;
  avgUserRating: number | null;
  highPrioritySuggestions: ImprovementSuggestion[];
  /** 전체 제안 수 (high/medium/low 합) */
  suggestionsCount: number;
  /**
   * 1:1 페어 매핑 적중률 — improvementSuggestions 의 「1:1 페어 매핑 적중률」
   * 항목에서 추출한 paired/problem 비율 (0~1). 측정 불가시 null.
   */
  pairingRate: number | null;
  /**
   * 시리즈 무결성 — improvementSuggestions 안 「시리즈 누락」 「중복 문항」 「페어 깨짐」
   * finding 에서 추출. 사용자 UI 배지 hover 시 한 줄 요약에 사용.
   */
  integrityIssues: { missing: number; duplicate: number; unpaired: number };
  /** 실패했을 때만 채워짐 */
  error: string | null;
};

let lastSnapshot: SupervisorSnapshot = {
  ranAt: null,
  ok: false,
  totalRuns: 0,
  successRate: 0,
  avgUserRating: null,
  highPrioritySuggestions: [],
  suggestionsCount: 0,
  pairingRate: null,
  integrityIssues: { missing: 0, duplicate: 0, unpaired: 0 },
  error: null,
};

export function getSupervisorSnapshot(): SupervisorSnapshot {
  return lastSnapshot;
}

function reportToSnapshot(report: RetrospectiveReport): SupervisorSnapshot {
  const high = report.improvementSuggestions.filter((s) => s.priority === "high");
  // 「1:1 페어 매핑 적중률」 finding 에서 비율 추출 — "(40.5%)" / "40.5%" 패턴 둘 다 잡음.
  let pairingRate: number | null = null;
  const pairingItem = report.improvementSuggestions.find((s) => s.area === "1:1 페어 매핑 적중률");
  if (pairingItem) {
    const m = pairingItem.finding.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) pairingRate = Number(m[1]) / 100;
  }
  // 무결성 카운트 — 각 area finding 의 첫 정수를 추출
  const pickInt = (area: string): number => {
    const item = report.improvementSuggestions.find((s) => s.area === area);
    if (!item) return 0;
    const m = item.finding.match(/(\d+)\s*건/);
    return m ? Number(m[1]) : 0;
  };
  const integrityIssues = {
    missing: pickInt("시리즈 누락"),
    duplicate: pickInt("중복 문항"),
    unpaired: pickInt("페어 깨짐 정제 권장"),
  };
  return {
    ranAt: Date.now(),
    ok: true,
    totalRuns: report.summary.totalRuns,
    successRate: report.summary.successRate,
    avgUserRating: report.summary.avgUserRating,
    highPrioritySuggestions: high,
    suggestionsCount: report.improvementSuggestions.length,
    pairingRate,
    integrityIssues,
    error: null,
  };
}

async function runOnce(): Promise<void> {
  if (inProgress) return;
  inProgress = true;
  try {
    const { generateRetrospective } = await import("./retrospective");
    const report = await generateRetrospective({ days: 30, maxRows: 1000 });
    lastSnapshot = reportToSnapshot(report);
    if (lastSnapshot.highPrioritySuggestions.length > 0) {
      // Railway 로그·관제에 잡히도록 명시적 warn
      console.warn(
        `[supervisor] HIGH priority 제안 ${lastSnapshot.highPrioritySuggestions.length}건 — /api/retrospective 확인 권장`,
      );
      for (const s of lastSnapshot.highPrioritySuggestions) {
        console.warn(`[supervisor]   · [${s.area}] ${s.finding}`);
      }
    }
  } catch (e) {
    lastSnapshot = {
      ...lastSnapshot,
      ranAt: Date.now(),
      ok: false,
      error: (e as Error).message,
    };
  } finally {
    inProgress = false;
  }
}

export function startSupervisorScheduler(): void {
  if (started) return;
  started = true;

  const raw = process.env.SUPERVISOR_INTERVAL_MS?.trim();
  const intervalMs = raw ? Number(raw) : 6 * 60 * 60 * 1000; // 기본 6시간
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

  setTimeout(() => {
    void runOnce();
  }, 90_000);
  setInterval(() => {
    void runOnce();
  }, intervalMs);
}
