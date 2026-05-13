/**
 * GET /api/textbook-ocr/progress
 *
 * /textbook-ocr 페이지가 1.5초 간격으로 폴링해 진행률 표시.
 * 모듈 전역 progress state (textbookOcrProgress.ts) 그대로 반환 + elapsedMs 계산.
 */
import { NextResponse } from "next/server";
import { getTextbookOcrProgress } from "@/lib/textbookOcrProgress";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const snap = getTextbookOcrProgress();
  const elapsedMs = snap.startedAt ? Date.now() - snap.startedAt : 0;
  return NextResponse.json({ ...snap, elapsedMs });
}
