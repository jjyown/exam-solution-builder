/**
 * POST /api/textbook-ocr/start
 *
 * /textbook-ocr 페이지에서 사용자가 선택한 책 OCR 시작.
 *
 * 요청 body: { bookIds: string[], force?: boolean, maxPages?: number }
 *
 * 핵심 동작:
 *  - in-flight 가드 — 이미 진행 중이면 409 (모듈 전역 progress state 참조)
 *  - fire-and-forget — POST 응답 즉시, runTextbookDriveBuild 는 백그라운드에서 진행
 *    → 사용자 PC/브라우저 꺼도 Railway 서버 컨테이너에서 계속 처리
 *  - log 콜백을 progress state 갱신과 결합 — UI 폴링이 실시간 진행률 표시
 *  - folderScope='textbook' 으로 시험지 원안 자동 체인 차단
 */
import { NextResponse } from "next/server";
import {
  getTextbookOcrProgress,
  startTextbookOcrProgress,
  patchTextbookOcrProgress,
  feedProgressFromLog,
} from "@/lib/textbookOcrProgress";

export const dynamic = "force-dynamic";

type StartRequest = {
  bookIds?: unknown;
  force?: unknown;
  maxPages?: unknown;
};

export async function POST(req: Request): Promise<Response> {
  let body: StartRequest;
  try {
    body = (await req.json()) as StartRequest;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  // 입력 정규화
  const bookIds = Array.isArray(body.bookIds)
    ? body.bookIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
  const force = body.force === true;
  const maxPages =
    typeof body.maxPages === "number" && body.maxPages > 0 ? Math.floor(body.maxPages) : 0;

  if (bookIds.length === 0) {
    return NextResponse.json(
      { ok: false, error: "bookIds 가 비어있습니다. 처리할 책을 선택하세요." },
      { status: 400 },
    );
  }

  // in-flight 가드 — 이미 textbook-ocr 진행 중이면 거부
  const current = getTextbookOcrProgress();
  if (current.stage === "preparing" || current.stage === "processing") {
    const elapsedMs = current.startedAt ? Date.now() - current.startedAt : 0;
    return NextResponse.json(
      {
        ok: false,
        error: `이전 OCR 작업이 진행 중입니다 (${Math.round(elapsedMs / 1000)}초 경과). 완료 후 다시 시도하세요.`,
        inProgress: true,
      },
      { status: 409 },
    );
  }

  // progress state 초기화 — 응답 보내기 전에 stage='preparing' 으로 잠금
  startTextbookOcrProgress(bookIds.length);

  // 백그라운드 OCR 시작 (fire-and-forget). await 하지 않음 — 사용자 PC 무관 진행.
  void (async () => {
    try {
      const { runTextbookDriveBuild } = await import("@/lib/textbookDriveBuildRunner");
      const result = await runTextbookDriveBuild({
        bookIds,
        folderScope: "textbook",
        force,
        maxPages,
        log: (m) => {
          // 콘솔 로그 + progress state 자동 갱신
          console.log(`[textbook-ocr] ${m}`);
          feedProgressFromLog(m);
        },
      });
      patchTextbookOcrProgress({ stage: "completed", result });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[textbook-ocr] 실패: ${msg}`);
      patchTextbookOcrProgress({ stage: "failed", error: msg });
    }
  })();

  return NextResponse.json({ ok: true, started: bookIds.length });
}
