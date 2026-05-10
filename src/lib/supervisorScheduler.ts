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

/**
 * 감독관이 retrospective 결과에서 자동 추출한 「검토 메모」.
 * 사용자가 별점·피드백을 남기지 않아도, 자주 발생하는 실패 패턴이 다음 호출의
 * cautionNotes 로 주입돼 같은 실수를 반복하지 않게 한다.
 *
 * findRelevantCautions(autoPipelineLog.ts) 가 이 배열을 함께 가져와 프롬프트에 합친다.
 */
let autoCautions: string[] = [];

export function getAutoSupervisorCautions(): string[] {
  return autoCautions;
}

export function getSupervisorSnapshot(): SupervisorSnapshot {
  // 안전망: instrumentation 미동작 환경 대비 — 첫 호출 시 자동 시작 (idempotent).
  if (!started) {
    startSupervisorScheduler();
  }
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

/**
 * retrospective 의 failureCategories / lowRatedRuns 에서 자동 cautionNote 를 만들어낸다.
 * 사용자가 별점 안 남겨도, 「최근 N건이 X 사유로 실패」 라는 사실 자체가 학습 메모가 됨.
 *
 * - 카테고리별 임계치: count >= 3 일 때만 메모로 채택 (소음 차단)
 * - 카테고리당 1줄 + 가장 흔한 실제 에러 1건 인용
 * - 최대 5건으로 제한해 프롬프트 길이 폭증 방지
 */
function deriveAutoCautions(report: import("./retrospective").RetrospectiveReport): string[] {
  const out: string[] = [];
  const cats = Object.entries(report.failureCategories ?? {})
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5);
  for (const [cat, info] of cats) {
    if (info.count < 3) continue;
    const sample = (info.examples?.[0] ?? "").split(":").slice(1).join(":").trim().slice(0, 140);
    const human = labelForCategory(cat);
    out.push(
      `[감독관 자동 메모] 최근 ${report.summary.totalRuns}건 중 ${info.count}건이 「${human}」 사유로 실패함${
        sample ? ` (예: ${sample})` : ""
      }. 같은 종류의 오류·누락을 반복하지 마세요.`,
    );
    if (out.length >= 5) break;
  }
  // 낮은 평점 구체 피드백도 1~2건 같이 — supervisor 가 별점 학습을 보강
  for (const lr of report.lowRatedRuns.slice(0, 2)) {
    const fb = (lr.feedback ?? "").trim();
    if (!fb) continue;
    out.push(`[감독관] 과거 ★${lr.rating} 평가 피드백: ${fb.slice(0, 200)}`);
    if (out.length >= 7) break;
  }
  return out;
}

function labelForCategory(cat: string): string {
  switch (cat) {
    case "format-mismatch":
      return "형식 미달 / JSON 파싱 / 평문에 raw LaTeX 노출";
    case "json-parse-failed":
      return "JSON 파싱 실패";
    case "quota-exhausted":
      return "API 한도 초과";
    case "timeout":
      return "타임아웃";
    case "network":
      return "네트워크 오류";
    case "empty-output":
      return "빈 응답";
    case "no-detail":
      return "원인 미상 실패";
    default:
      return cat;
  }
}

/**
 * 외부에서 즉시 한 번 감독관을 돌리고 갱신된 스냅샷·자동 메모를 반환한다.
 * 6시간 주기를 기다리지 않고 변경 직후 학습 결과를 확인하고 싶을 때 사용.
 */
export async function runSupervisorNow(): Promise<{
  snapshot: SupervisorSnapshot;
  autoCautions: string[];
}> {
  await runOnce();
  return { snapshot: lastSnapshot, autoCautions };
}

async function runOnce(): Promise<void> {
  if (inProgress) return;
  inProgress = true;
  try {
    const { generateRetrospective } = await import("./retrospective");
    const report = await generateRetrospective({ days: 30, maxRows: 1000 });
    lastSnapshot = reportToSnapshot(report);
    autoCautions = deriveAutoCautions(report);
    if (autoCautions.length > 0) {
      console.warn(
        `[supervisor] 자동 메모 ${autoCautions.length}건 갱신 — 다음 풀이 호출의 cautionNotes 에 주입됨`,
      );
    }
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
