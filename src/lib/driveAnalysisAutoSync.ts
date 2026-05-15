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

// 마지막 자동 동기화 결과 — UI / 헬스체크 노출용.
// 사용자가 "마지막 동기화 N분 전, 새로 흡수된 파일 X개" 같은 정보를 보고
// 분석자료가 실제로 따라오고 있는지 확인할 수 있다.
type AutoSyncSnapshot = {
  lastRunAt: number | null;
  lastOk: boolean;
  /** 마지막 실행에서 새로 학습/변경된 파일 수 */
  lastNewOrChanged: number;
  /** 마지막 실행에서 화이트리스트 매칭된 파일 수 */
  lastTotalFiles: number;
  /** 마지막 실행 errors (있으면 운영 경고 단서) */
  lastErrors: string[];
  /** 다음 자동 실행 주기(ms) — 0 이면 비활성 */
  intervalMs: number;
  /**
   * 화이트리스트 root 폴더(시중교재/시험지 원안 등) 별 마지막 처리 결과.
   * 사용자가 「시중교재 0건 처리됐다」 같은 진단을 UI 에서 즉시 볼 수 있게.
   */
  lastByRootFolder: Record<
    string,
    { filesFound: number; sizeSkipped: number; ocrFailed: number; cacheHit: number; newOrChanged: number }
  >;
  /** 마지막 학습에서 발견된 시리즈 무결성 카운트 (누락/중복/페어 깨짐) */
  lastIntegrityCounts: { missing: number; duplicate: number; unpaired: number };
  /**
   * 페어링률 < 40% 인 PDF 큐 — 텍스트 헤더 매칭이 깨진 신호.
   * UI 「bbox 재처리 권장」 칩으로 노출, scripts/textbook_page_split_mathpix.py
   * 로 재처리 후보가 됨.
   */
  lastLowPairingFiles: Array<{
    fileId: string;
    source: string;
    problemRecords: number;
    pairedRecords: number;
    rate: number;
  }>;
  /**
   * sync 직후 자동 트리거된 bbox 폴백 결과 — BBOX_FALLBACK_AUTO=true 일 때만 채워짐.
   * 비용 보호: BBOX_FALLBACK_MAX_PER_SYNC (기본 3) 으로 한 sync 당 최대 N개만 시도.
   * UI 「bbox 재처리」 패널에서 「✓ 자동 적용」 표기로 노출.
   */
  lastAutoFallback: {
    enabled: boolean;
    attempted: number;
    improved: number;
    results: Array<{
      fileId: string;
      source: string;
      improved: boolean;
      beforeRate: number;
      afterRate: number;
      error?: string;
    }>;
  };
};

let snapshot: AutoSyncSnapshot = {
  lastRunAt: null,
  lastOk: false,
  lastNewOrChanged: 0,
  lastTotalFiles: 0,
  lastErrors: [],
  intervalMs: 0,
  lastByRootFolder: {},
  lastIntegrityCounts: { missing: 0, duplicate: 0, unpaired: 0 },
  lastLowPairingFiles: [],
  lastAutoFallback: { enabled: false, attempted: 0, improved: 0, results: [] },
};

export function getDriveAnalysisSyncSnapshot(): AutoSyncSnapshot {
  // 안전망: instrumentation.ts 의 register 가 Railway 등에서 호출 안 됐을 때
  // 첫 API 호출 시점에 자동으로 스케줄러를 시작 (idempotent — `if (started) return`).
  // 정상 부팅이면 startup 60초 안에 이미 started=true 라 영향 없음.
  if (!started) {
    startDriveAnalysisAutoSync();
  }
  return snapshot;
}

export function startDriveAnalysisAutoSync(): void {
  if (started) return;
  started = true;

  const raw = process.env.DRIVE_ANALYSIS_AUTO_SYNC_MS?.trim();
  const intervalMs = raw ? Number(raw) : 4 * 60 * 60 * 1000; // 기본 4시간 (비용 최적화)
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    // 비활성
    return;
  }
  snapshot = { ...snapshot, intervalMs };

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
      snapshot = {
        ...snapshot,
        lastRunAt: Date.now(),
        lastOk: true,
        lastNewOrChanged: summary.newOrChanged,
        lastTotalFiles: summary.totalFiles,
        lastErrors: summary.errors,
        lastByRootFolder: summary.byRootFolder,
        lastIntegrityCounts: summary.integrity.counts,
        lastLowPairingFiles: summary.pairing.lowPairingFiles,
      };
      if (summary.pairing.lowPairingFiles.length > 0) {
        console.warn(
          `[driveAnalysisAutoSync] 페어링률 <40% PDF ${summary.pairing.lowPairingFiles.length}개 — bbox 재처리 권장`,
        );
        for (const f of summary.pairing.lowPairingFiles.slice(0, 5)) {
          console.warn(
            `[driveAnalysisAutoSync]   · ${f.source}: ${f.pairedRecords}/${f.problemRecords} (${(f.rate * 100).toFixed(0)}%)`,
          );
        }
      }

      // Mathpix bbox 폴백 폐기 — 페어링 향상은 refine-pairing(LLM) 으로 별도 수행.
      snapshot = {
        ...snapshot,
        lastAutoFallback: {
          enabled: false,
          attempted: 0,
          improved: 0,
          results: [],
        },
      };
      // 화이트리스트 매칭 0건처럼 명시적 경고가 나오면 운영 로그에 흘려둔다
      for (const err of summary.errors) {
        if (/화이트리스트 매칭 0건/.test(err)) {
          console.warn(`[driveAnalysisAutoSync] ${err}`);
        }
      }
      // 화이트리스트 폴더 중 처리된 newOrChanged 가 0이고 sizeSkipped 가 있다면 — 시중교재가 OCR 안 된 패턴
      for (const [folder, stat] of Object.entries(summary.byRootFolder)) {
        if (stat.filesFound > 0 && stat.newOrChanged === 0 && stat.cacheHit === 0) {
          console.warn(
            `[driveAnalysisAutoSync] 폴더 「${folder}」: 파일 ${stat.filesFound}개 발견했지만 처리 0건 ` +
              `(size-skip ${stat.sizeSkipped}, ocr-fail ${stat.ocrFailed}). ANALYSIS_FILE_MAX_MB 상향 또는 PDF 분할 필요.`,
          );
        }
      }
    } catch (e) {
      // best-effort — 다음 주기에 재시도. 다만 마지막 실패는 기록.
      snapshot = {
        ...snapshot,
        lastRunAt: Date.now(),
        lastOk: false,
        lastErrors: [(e as Error).message],
      };
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
