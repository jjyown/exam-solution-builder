/**
 * src/app/api/drive/analysis/bbox-fallback/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST → 페어링률 <40% PDF 에 대해 Mathpix `lines.json` (좌표/bbox) 응답으로
 *         segment 분할 + 표준 헤더 텍스트 재구성 → 페어링률 비교 → 향상 시 records 영속화.
 *
 *  Body:
 *    { fileId: string }   대상 PDF 의 Drive fileId
 *
 *  응답:
 *    {
 *      ok, fileId, fileName,
 *      before: { problem, paired, rate },
 *      after:  { problem, paired, rate },
 *      improved: boolean,
 *      diagnostics: { totalLines, problemHeaderCount, hasSolutionSection }
 *    }
 *
 *  보호:
 *    - BBOX_FALLBACK_ENABLED=true 환경변수 없으면 거부 (비용 보호 — Mathpix 1회 추가 호출)
 *    - Mathpix 키 미설정이면 거부 (driveAnalysisLearner 안에서 한 번 더 검사)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { bboxFallbackForFile } from "@/lib/driveAnalysisLearner";
import { resolveMathpixCredentials } from "@/lib/mathpixV3Text";
import { logApiCall } from "@/lib/apiCallLogger";

function isBboxFallbackEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.BBOX_FALLBACK_ENABLED || "");
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    enabled: isBboxFallbackEnabled(),
    mathpixConfigured: !!resolveMathpixCredentials(),
    note:
      "POST { fileId } 으로 bbox 기반 재처리. BBOX_FALLBACK_ENABLED=true 필요. " +
      "텍스트 헤더 매칭이 깨진 PDF 만 대상.",
  });
}

export async function POST(req: Request) {
  if (!isBboxFallbackEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "BBOX_FALLBACK_ENABLED=true 환경변수가 필요합니다. Railway env 에 설정 후 재배포.",
      },
      { status: 403 },
    );
  }
  if (!resolveMathpixCredentials()) {
    return NextResponse.json(
      { ok: false, error: "MATHPIX_APP_ID/MATHPIX_APP_KEY 미설정" },
      { status: 501 },
    );
  }

  let body: { fileId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const fileId = body.fileId?.trim();
  if (!fileId) {
    return NextResponse.json(
      { ok: false, error: "fileId is required" },
      { status: 400 },
    );
  }

  const result = await bboxFallbackForFile(fileId);
  // BBox 폴백은 Mathpix /v3/pdf 1회 추가 호출 — 페이지 수만큼 과금됨.
  // 결과에 pageCount 가 있으면 그걸로 보정, 없으면 1로.
  const pageCount = (result as { pageCount?: number }).pageCount;
  void logApiCall({
    route: "/api/drive/analysis/bbox-fallback",
    purpose: "분석자료 — BBox 기반 PDF 재처리 (페어링률 보강)",
    vendor: "mathpix",
    model: "mathpix-v3-pdf",
    ok: result.ok,
    units: pageCount && pageCount > 0 ? pageCount : 1,
    meta: { fileId },
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, fileId, status: result.status, error: result.message },
      { status: 500 },
    );
  }
  return NextResponse.json(result);
}
