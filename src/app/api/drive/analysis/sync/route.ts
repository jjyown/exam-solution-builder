/**
 * src/app/api/drive/analysis/sync/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST → 백그라운드 작업 시작 후 즉시 반환 (502 방지)
 *  GET  → 현재 작업 상태 조회 (UI가 폴링)
 *
 *  과거에는 POST가 모든 PDF Gemini OCR 까지 동기 await 해서, 분석용 자료
 *  파일이 많을 경우 Railway proxy 60초 timeout / 메모리 OOM 으로 502 발생.
 *  비동기 + 폴링 패턴으로 변경 — 사용자 UI 는 진행률을 보면서 대기.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import {
  AnalysisLearnSummary,
  invalidateAnalysisCache,
  loadDriveAnalysisRecords,
} from "@/lib/driveAnalysisLearner";
import { resetAutoPipelineRetriever } from "@/lib/autoPipelineRetriever";

type JobStatus = "idle" | "running" | "completed" | "failed";

type Job = {
  status: JobStatus;
  startedAt: number | null;
  finishedAt: number | null;
  summary: AnalysisLearnSummary | null;
  recordCount: number;
  error: string | null;
  /** 진행 중일 때 사용자에게 보여줄 elapsed 시간 (ms) */
  elapsedMs?: number;
};

// 모듈 전역 — Railway 단일 인스턴스 가정. 다중 replica 면 별도 store 필요(현재 안 씀).
let currentJob: Job = {
  status: "idle",
  startedAt: null,
  finishedAt: null,
  summary: null,
  recordCount: 0,
  error: null,
};

async function runSyncInBackground(): Promise<void> {
  try {
    invalidateAnalysisCache();
    resetAutoPipelineRetriever();
    const { records, summary } = await loadDriveAnalysisRecords();
    currentJob = {
      status: "completed",
      startedAt: currentJob.startedAt,
      finishedAt: Date.now(),
      summary,
      recordCount: records.length,
      error: null,
    };
  } catch (e) {
    currentJob = {
      status: "failed",
      startedAt: currentJob.startedAt,
      finishedAt: Date.now(),
      summary: null,
      recordCount: 0,
      error: (e as Error).message,
    };
  }
}

export async function POST() {
  if (currentJob.status === "running") {
    return NextResponse.json({
      ok: true,
      alreadyRunning: true,
      job: currentJob,
    });
  }
  currentJob = {
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    summary: null,
    recordCount: 0,
    error: null,
  };
  // fire-and-forget — POST 응답을 막지 않음
  void runSyncInBackground();
  return NextResponse.json({ ok: true, started: true, job: currentJob });
}

export async function GET() {
  // 진행 중이면 elapsed 시간 계산해 응답 — 사용자가 「N분째 처리 중」 확인 가능.
  const elapsedMs =
    currentJob.status === "running" && currentJob.startedAt
      ? Date.now() - currentJob.startedAt
      : undefined;
  return NextResponse.json({
    ok: true,
    job: { ...currentJob, elapsedMs },
  });
}
