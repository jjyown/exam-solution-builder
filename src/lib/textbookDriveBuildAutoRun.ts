/**
 * textbookDriveBuildAutoRun.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  서버 startup 시 등록되는 백그라운드 스케줄러.
 *  Drive 「분석용 자료/시중교재」(+ 「시험지 원안」) 폴더의 PDF 들을 페이지 단위로
 *  Gemini Vision OCR 해 책별 작업 폴더에 저장한다. 사용자가 PC 에 매달릴 필요 없이
 *  Railway 가 매일 자동 처리.
 *
 *  주기: TEXTBOOK_DRIVE_BUILD_INTERVAL_MS (기본 24h)
 *    - 0 또는 음수면 비활성 (개발 환경에서 비용 보호)
 *  첫 실행: startup 후 TEXTBOOK_DRIVE_BUILD_FIRST_DELAY_MS (기본 5분)
 *    - healthcheck·콜드스타트 끝난 뒤에 시작해서 부팅 막지 않음
 *  동시 실행 방지: inProgress 플래그
 *  실패는 silent — 다음 주기에 다시 시도
 *
 *  Drive 폴더 우선순위:
 *    1) 시중교재 — 새 PDF 있으면 그것만 처리
 *    2) 시중교재 새 게 없으면 → 시험지 원안 자동 진행
 *  (runTextbookDriveBuild 내부 정책)
 *
 *  비용:
 *    - 처리할 게 없으면 ~0 (Drive list API 몇 번만, Drive 무료 할당량 안)
 *    - 새 책 1권 ≈ $0.03 (gemini-2.0-flash, 300페이지 기준)
 *
 *  UI 연동:
 *    getTextbookDriveBuildSnapshot() → /cost 페이지 등에서 마지막 실행 결과 노출.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { TextbookDriveBuildResult } from "./textbookDriveBuildRunner";

let started = false;
let inProgress = false;

type Snapshot = {
  intervalMs: number;
  lastRunAt: number | null;
  lastOk: boolean;
  lastErrors: string[];
  lastResult: TextbookDriveBuildResult | null;
  /** 누적 자동 실행 횟수. 0 이면 아직 한 번도 안 돔 */
  totalRuns: number;
};

let snapshot: Snapshot = {
  intervalMs: 0,
  lastRunAt: null,
  lastOk: false,
  lastErrors: [],
  lastResult: null,
  totalRuns: 0,
};

export function getTextbookDriveBuildSnapshot(): Snapshot {
  if (!started) startTextbookDriveBuildAutoRun();
  return snapshot;
}

export function startTextbookDriveBuildAutoRun(): void {
  if (started) return;
  started = true;

  const raw = process.env.TEXTBOOK_DRIVE_BUILD_INTERVAL_MS?.trim();
  const intervalMs = raw ? Number(raw) : 24 * 60 * 60 * 1000; // 기본 24시간
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    console.log("[textbook-build-auto] 비활성 (TEXTBOOK_DRIVE_BUILD_INTERVAL_MS=0)");
    return;
  }
  snapshot = { ...snapshot, intervalMs };

  const firstDelayRaw = process.env.TEXTBOOK_DRIVE_BUILD_FIRST_DELAY_MS?.trim();
  const firstDelayMs = firstDelayRaw ? Number(firstDelayRaw) : 5 * 60 * 1000;

  const runOnce = async () => {
    if (inProgress) {
      console.log("[textbook-build-auto] 이전 실행 진행 중 — skip");
      return;
    }
    inProgress = true;
    const startedAt = Date.now();
    const logs: string[] = [];
    const log = (m: string) => {
      logs.push(m);
      console.log(`[textbook-build-auto] ${m}`);
    };
    try {
      const { runTextbookDriveBuild } = await import("./textbookDriveBuildRunner");
      const { resetDriveTextbookReferenceCache } = await import(
        "./textbookDriveReferenceLoader"
      );
      const { resetAutoPipelineRetriever } = await import("./autoPipelineRetriever");
      log(`자동 실행 시작 (interval=${(intervalMs / 1000 / 60 / 60).toFixed(1)}h)`);
      const result = await runTextbookDriveBuild({
        log,
      });
      // 새 책 처리됐으면 RAG 캐시 무효화 → 다음 풀이 호출 때 새 데이터 반영
      if (result.totalProcessedBooks > 0) {
        resetDriveTextbookReferenceCache();
        resetAutoPipelineRetriever();
        log(`새 책 ${result.totalProcessedBooks}건 처리 — retriever 캐시 무효화`);
      }
      snapshot = {
        ...snapshot,
        lastRunAt: Date.now(),
        lastOk: true,
        lastErrors: [],
        lastResult: result,
        totalRuns: snapshot.totalRuns + 1,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error && e.stack ? e.stack : "";
      // 진단용 — 첫 행은 사용자 친화 메시지, stack 첫 5줄로 원인 추적
      console.error(`[textbook-build-auto] 실패: ${msg}`);
      if (stack) {
        const stackLines = stack.split("\n").slice(0, 6).join("\n");
        console.error(`[textbook-build-auto] stack:\n${stackLines}`);
      }
      snapshot = {
        ...snapshot,
        lastRunAt: Date.now(),
        lastOk: false,
        lastErrors: [msg, ...(stack ? [stack.split("\n").slice(0, 3).join(" | ")] : [])],
        totalRuns: snapshot.totalRuns + 1,
      };
    } finally {
      inProgress = false;
      console.log(
        `[textbook-build-auto] 완료 — ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
      );
    }
  };

  // 첫 실행은 startup 직후가 아닌 firstDelayMs 후
  setTimeout(() => void runOnce(), firstDelayMs).unref?.();
  // 이후 주기 실행
  setInterval(() => void runOnce(), intervalMs).unref?.();

  console.log(
    `[textbook-build-auto] 등록 완료 — 첫 실행 ${(firstDelayMs / 1000 / 60).toFixed(0)}분 후, 이후 ${(intervalMs / 1000 / 60 / 60).toFixed(1)}h 주기`,
  );
}
