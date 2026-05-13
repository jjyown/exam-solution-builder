/**
 * textbookOcrProgress.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  /textbook-ocr 페이지가 사용하는 모듈 전역 진행률 상태.
 *  /api/textbook-ocr/start 가 갱신하고 /api/textbook-ocr/progress 가 조회.
 *
 *  auto-pipeline 의 progressState (route.ts:44-113) 와 같은 패턴이지만
 *  완전히 분리된 별도 인스턴스 — 두 작업이 동시에 돌아도 충돌 없음.
 *
 *  동시 실행은 1개 (admin tool 가정) — 새 start 가 시작되면 덮어쓴다.
 *  in-flight 가드는 start route 진입부에서 stage 를 보고 결정.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { TextbookDriveBuildResult } from "./textbookDriveBuildRunner";

export type TextbookOcrStage =
  | "idle"
  | "preparing" // Drive 폴더 조회·옵션 검증 중
  | "processing" // 책 OCR 진행 중
  | "completed"
  | "failed";

export type TextbookOcrProgress = {
  stage: TextbookOcrStage;
  startedAt: number | null;
  updatedAt: number | null;
  /** 처리 대상 책 총 수 (선택 책 수) */
  totalBooks: number;
  /** 현재 책의 폴더 라벨 — "시중교재" 등 */
  currentBookFolder: string | null;
  /** 현재 처리 중 책 이름 */
  currentBookName: string | null;
  /** 현재 처리 중 페이지 번호 */
  currentPageNo: number;
  /** 현재 처리 중 책의 총 페이지 수 */
  currentBookTotal: number;
  /** 누적 성공 페이지 (전체 책 통틀어) */
  successPageCount: number;
  /** 누적 실패 페이지 (전체 책 통틀어) */
  failedPageCount: number;
  /** 끝난 책 수 */
  finishedBookCount: number;
  /** 작업 종료 후 결과 */
  result: TextbookDriveBuildResult | null;
  /** 마지막 에러 (failed 단계) */
  error: string | null;
};

let progress: TextbookOcrProgress = {
  stage: "idle",
  startedAt: null,
  updatedAt: null,
  totalBooks: 0,
  currentBookFolder: null,
  currentBookName: null,
  currentPageNo: 0,
  currentBookTotal: 0,
  successPageCount: 0,
  failedPageCount: 0,
  finishedBookCount: 0,
  result: null,
  error: null,
};

export function getTextbookOcrProgress(): TextbookOcrProgress {
  return progress;
}

export function startTextbookOcrProgress(totalBooks: number): void {
  progress = {
    stage: "preparing",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    totalBooks,
    currentBookFolder: null,
    currentBookName: null,
    currentPageNo: 0,
    currentBookTotal: 0,
    successPageCount: 0,
    failedPageCount: 0,
    finishedBookCount: 0,
    result: null,
    error: null,
  };
}

export function patchTextbookOcrProgress(patch: Partial<TextbookOcrProgress>): void {
  progress = { ...progress, ...patch, updatedAt: Date.now() };
}

/**
 * runner 의 log 콜백 텍스트를 파싱해 progress 를 자동 갱신.
 * 인식 패턴:
 *   "=== 📘 [시중교재] BOOKNAME (12.3MB) ===" → 새 책 시작
 *   "  ✔ NN 페이지 — OCR 시작"            → 현재 책 총 페이지 수
 *   "  [page 042/120] ✓ ..."              → 페이지 성공
 *   "  [page 042/120] ✗ ..."              → 페이지 실패
 *   "  [skip] 이미 ocr md ..."            → 책 skip (force=false 이미 처리분)
 */
export function feedProgressFromLog(line: string): void {
  // 새 책 시작
  const bookStart = /=== 📘 \[(.+?)\] (.+?) \(.+?MB\) ===/.exec(line);
  if (bookStart) {
    progress = {
      ...progress,
      stage: "processing",
      currentBookFolder: bookStart[1] ?? null,
      currentBookName: bookStart[2] ?? null,
      currentPageNo: 0,
      currentBookTotal: 0,
      updatedAt: Date.now(),
    };
    return;
  }

  // 현재 책 총 페이지 수
  const totalMatch = /^\s*✔ (\d+) 페이지 — OCR 시작/.exec(line);
  if (totalMatch) {
    progress = {
      ...progress,
      currentBookTotal: parseInt(totalMatch[1] ?? "0", 10),
      updatedAt: Date.now(),
    };
    return;
  }

  // 페이지 성공/실패
  const pageMatch = /\[page (\d+)\/(\d+)\] ([✓✗])/.exec(line);
  if (pageMatch) {
    const pageNo = parseInt(pageMatch[1] ?? "0", 10);
    const ok = pageMatch[3] === "✓";
    progress = {
      ...progress,
      currentPageNo: pageNo,
      successPageCount: ok ? progress.successPageCount + 1 : progress.successPageCount,
      failedPageCount: !ok ? progress.failedPageCount + 1 : progress.failedPageCount,
      updatedAt: Date.now(),
    };
    return;
  }

  // 책 skip (이미 처리분)
  if (/^\s*\[skip\]/.test(line)) {
    progress = {
      ...progress,
      finishedBookCount: progress.finishedBookCount + 1,
      updatedAt: Date.now(),
    };
    return;
  }

  // 책 완료 (manifest 업로드 끝나는 시점) — "▷ Drive: " 같은 마무리 로그
  if (/^\s*▷ Drive:/.test(line)) {
    progress = {
      ...progress,
      finishedBookCount: progress.finishedBookCount + 1,
      updatedAt: Date.now(),
    };
    return;
  }
}
