/**
 * driveAnalysisAutoSync.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  서버 startup 시 등록되는 백그라운드 스케줄러.
 *  주기적으로 「분석용 자료」 폴더를 자동 동기화 → 사용자가 「새로 학습」을
 *  누르지 않아도 새 파일이 KB 에 자동 반영된다.
 *
 *  ▷ 주기: DRIVE_ANALYSIS_AUTO_SYNC_MS (기본 4시간 = 14,400,000ms).
 *           0 또는 음수 값이면 비활성. 비용 최소화 우선.
 *           실시간성 필요 없음 — /auto-pipeline 호출 시에도 60초 throttle
 *           안에서 자동 감지가 따로 동작하므로, 활동 중이면 거의 즉시 반영됨.
 *  ▷ 첫 실행: startup 후 60초 뒤 (healthcheck/콜드스타트 방해 안 함).
 *  ▷ 동시 실행 방지: loadDriveAnalysisRecords() 자체에 in-memory cache 가
 *    있어 같은 파일은 modifiedTime 기반 skip. 또한 inProgress 플래그로 중복 실행 차단.
 *  ▷ 실패는 silent — 다음 주기에 다시 시도.
 *
 *  Railway 처럼 24h running 컨테이너에서 setInterval 가 정상 동작.
 *  Serverless cold-start 환경에서는 의미 없으나 그 경우 instrumentation 자체가
 *  요청 직후 만 호출되므로 사용자 영향은 동일하게 0.
 * ────────────────────────────────────────────────────────────────────────────
 */

let started = false;
let inProgress = false;

export function startDriveAnalysisAutoSync(): void {
  if (started) return;
  started = true;

  const raw = process.env.DRIVE_ANALYSIS_AUTO_SYNC_MS?.trim();
  const intervalMs = raw ? Number(raw) : 4 * 60 * 60 * 1000; // 기본 4시간 (비용 최적화)
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    // 비활성
    return;
  }

  const runOnce = async () => {
    if (inProgress) return;
    inProgress = true;
    try {
      // 의존성을 lazy import 해서 module 그래프가 startup 을 막지 않게 함
      const { loadDriveAnalysisRecords } = await import("./driveAnalysisLearner");
      const { resetAutoPipelineRetriever } = await import("./autoPipelineRetriever");
      const { summary } = await loadDriveAnalysisRecords();
      // 변경분 있으면 retriever 캐시 invalidate → 다음 호출에 재인덱싱
      if (summary.newOrChanged > 0) {
        resetAutoPipelineRetriever();
      }
    } catch {
      // best-effort — 다음 주기에 재시도
    } finally {
      inProgress = false;
    }
  };

  // 첫 실행: startup 60초 후 (healthcheck 안전 마진)
  setTimeout(() => {
    void runOnce();
  }, 60_000);

  // 주기 실행
  setInterval(() => {
    void runOnce();
  }, intervalMs);
}
