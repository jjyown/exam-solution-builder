/**
 * autoPipelineRetriever.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  자동 파이프라인 KB 검색기를 모듈 전역으로 1회 인덱싱해 재사용.
 *   - reference/kb.jsonl (시드)
 *   - Google Drive 「분석용 자료」 폴더 (있으면 자동 합산. 시중교재/개인자료
 *     서브폴더 재귀 탐색)
 *
 *  ▷ 자동 변경 감지 (Drive 새 파일 자동 반영)
 *      매 호출 시 throttle 안에서만 Drive list API 1회 호출 → modifiedTime
 *      비교 → 변경된 파일이 있으면 백그라운드로 재인덱싱. 사용자가 PDF 를
 *      Drive 에 올리고 ~1분 안에 다음 풀이 호출하면 자동 반영됨.
 *      throttle: DRIVE_ANALYSIS_FRESHNESS_MS (기본 60_000)
 *
 *  ▷ 강제 재동기화: resetAutoPipelineRetriever() → 다음 호출 때 재로딩.
 * ────────────────────────────────────────────────────────────────────────────
 */
import path from "node:path";
import { ReferenceRetriever } from "./referenceRetriever";

let retrieverPromise: Promise<ReferenceRetriever> | null = null;
let lastFreshnessCheckMs = 0;
let bgRefreshing = false;

const FRESHNESS_THROTTLE_MS = (() => {
  const raw = Number(process.env.DRIVE_ANALYSIS_FRESHNESS_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
})();

function initRetriever(): Promise<ReferenceRetriever> {
  const kbPath =
    process.env.REFERENCE_KB_PATH ||
    path.join(process.cwd(), "reference", "kb.jsonl");
  // ⚠️ 핵심 로딩 순서 / 비용:
  //  1) kb.jsonl (~50ms)                            — 즉시
  //  2) 로컬 「교재 참고자료/」 *.md (~100~200ms)    — 인라인 (이미 빌드된 1k+ 시중교재 참고자료)
  //  3) Drive 분석용 자료 (네트워크·OCR)             — 백그라운드 (응답 막지 않음)
  //
  //  로컬 교재는 동기 인라인으로 로드해서 startup 직후 호출에도 RAG 에 포함되게 한다.
  //  비활성화: TEXTBOOK_REFERENCE_DIR= (빈 값)
  return ReferenceRetriever.fromJsonl(kbPath).then(async (r) => {
    try {
      const { loadLocalTextbookReferenceRecords } = await import(
        "./textbookReferenceLocalLoader"
      );
      const { records, fileCount } = await loadLocalTextbookReferenceRecords();
      if (records.length > 0) {
        r.addRecords(records);
        console.log(
          `[retriever] 로컬 교재 참고자료 ${records.length}개 record 합산 (파일 ${fileCount}개)`,
        );
      }
    } catch (e) {
      console.warn(
        `[retriever] 로컬 교재 참고자료 로드 실패 — Drive/kb 만으로 동작: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    void (async () => {
      try {
        const { loadDriveAnalysisRecords } = await import("./driveAnalysisLearner");
        const { records } = await loadDriveAnalysisRecords();
        if (records.length > 0) r.addRecords(records);
      } catch {
        // best-effort — Drive 실패해도 베이스 KB·로컬 교재 만으로 동작
      }
    })();
    // Drive 책별 ocr/*.md (Railway 자동 빌드 산출물) 도 합산.
    // 로컬 미러가 ephemeral 한 Railway 환경에서 RAG 데이터의 진짜 출처.
    void (async () => {
      try {
        const { loadDriveTextbookReferenceRecords } = await import(
          "./textbookDriveReferenceLoader"
        );
        const { records, fileCount } = await loadDriveTextbookReferenceRecords();
        if (records.length > 0) {
          r.addRecords(records);
          console.log(
            `[retriever] Drive 교재 ocr record ${records.length}개 합산 (md 파일 ${fileCount}개)`,
          );
        }
      } catch (e) {
        console.warn(
          `[retriever] Drive 교재 ocr 로드 실패 — kb/로컬만으로 동작: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();
    return r;
  });
}

/** 백그라운드: Drive 변경 감지 → 변경됐으면 다음 호출용 promise 새로 만들어 둠 */
async function maybeRefreshAnalysisInBackground(): Promise<void> {
  if (bgRefreshing) return;
  bgRefreshing = true;
  try {
    const { loadDriveAnalysisRecords } = await import("./driveAnalysisLearner");
    const { summary } = await loadDriveAnalysisRecords();
    if (summary.newOrChanged > 0) {
      // 새 파일/수정 감지 → 다음 호출 때 새 promise 가 사용됨
      retrieverPromise = initRetriever();
    }
  } catch {
    // 무시 — 베이스 KB 는 그대로 동작
  } finally {
    bgRefreshing = false;
  }
}

export function getAutoPipelineRetriever(): Promise<ReferenceRetriever> {
  // 첫 호출 — 동기 초기화
  if (!retrieverPromise) {
    retrieverPromise = initRetriever();
    lastFreshnessCheckMs = Date.now();
    return retrieverPromise;
  }
  // 이후 호출 — throttle 안이면 그대로 반환
  const now = Date.now();
  if (now - lastFreshnessCheckMs < FRESHNESS_THROTTLE_MS) {
    return retrieverPromise;
  }
  // throttle 지남 — 백그라운드로 변경 감지. 현재 응답은 기존 promise 로 즉시 반환.
  lastFreshnessCheckMs = now;
  void maybeRefreshAnalysisInBackground();
  return retrieverPromise;
}

export function resetAutoPipelineRetriever(): void {
  retrieverPromise = null;
  lastFreshnessCheckMs = 0;
}
