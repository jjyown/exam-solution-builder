/**
 * src/app/api/auto-pipeline/progress/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  /auto 페이지가 실행 중에 호출하는 라이브 진행률 폴링 엔드포인트.
 *  auto-pipeline 라우트가 모듈 전역에 갱신해 두는 progressState 를 그대로 반환.
 *
 *  반환:
 *  {
 *    stage: 'idle' | 'preparing' | 'processing' | 'completed' | 'failed',
 *    startedAt, updatedAt,                      // epoch ms
 *    currentIdx, total, currentNo, subStage,    // 처리 중 위치
 *    completedCount,                            // 지금까지 완료된 문항 수
 *    error,                                     // failed 일 때 메시지
 *    elapsedMs,                                 // 시작 후 경과 (계산해서 같이)
 *  }
 *
 *  비용·메모리: 단순 객체 한 번 읽고 반환 → 무시 가능 수준.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from 'next/server';
import { getProgressSnapshot } from '../route';

export async function GET(): Promise<Response> {
  const snap = getProgressSnapshot();
  const elapsedMs = snap.startedAt ? Date.now() - snap.startedAt : 0;
  return NextResponse.json({ ...snap, elapsedMs });
}
