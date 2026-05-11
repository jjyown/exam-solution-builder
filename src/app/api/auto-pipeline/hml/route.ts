/**
 * src/app/api/auto-pipeline/hml/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST: parsed 결과(단일 또는 다중)를 한컴 한글 .hml 로 변환해 즉시 다운로드.
 *
 *  body:
 *    { examName?: string, runs: [{ questionNo, questionText?, parsed }] }
 *
 *  응답: HML XML 파일 (Content-Type: application/x-hwpml).
 *  사용자가 한컴 한글에서 열기 → 자동 변환 → 그대로 편집·저장 가능.
 *
 *  운영자 시나리오:
 *   - 마이일타·수학비서 류 한컴 워크플로 학원이 그대로 사용
 *   - DOCX 와 동일한 입력으로 다른 포맷 출력 (DOCX 는 Word, HML 은 한컴)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { buildExamExplanationHmlMultiBuffer } from "@/lib/examExplanationHml";
import {
  getDriveClient,
  isGoogleDriveConfigured,
  resolveDriveWorkCompleteFolderId,
  uploadBufferToDriveFolder,
} from "@/lib/googleDrive";
import { injectGeneratedGraphsIntoRuns } from "@/lib/explanationGraphInjection";

type ParsedStep = { text: string; equation: string };
type Parsed = {
  answer: string;
  explanation_steps: ParsedStep[];
  summary?: string;
};

type RunItem = {
  questionNo: string;
  questionText?: string;
  parsed: Parsed | null;
  /**
   * /crop 에서 잘라낸 원본 문제 이미지 (data URL).
   * 있으면 questionText 머리에 마크다운 이미지 라인을 prepend 해서
   * HML 빌더가 자동으로 해당 위치에 이미지 임베드.
   */
  questionImageDataUrl?: string;
};

type Body = {
  examName?: string;
  runs?: RunItem[];
};

function safeFilename(s: string): string {
  return (s || "해설지").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.runs || body.runs.length === 0) {
    return NextResponse.json(
      { ok: false, error: "runs[] 가 필요합니다." },
      { status: 400 },
    );
  }

  const examName = (body.examName || "해설지").trim();
  const validRunsRaw = body.runs.filter((r) => r.parsed);
  if (validRunsRaw.length === 0) {
    return NextResponse.json(
      { ok: false, error: "유효한 parsed 결과가 없습니다." },
      { status: 400 },
    );
  }

  // 그래프 후처리 — ```python``` 펜스 → matplotlib PNG → dataURL 마크다운.
  // EXPLANATION_GRAPH_RUN env 가 켜진 환경에서만 실제 실행. 꺼져 있으면 그대로 통과.
  const { runs: validRuns, logs: graphLogs } = await injectGeneratedGraphsIntoRuns(validRunsRaw);
  if (graphLogs.length > 0) {
    // 빌드 진단 — 운영자가 Railway 로그로 확인. UI 에는 노출 안 함.
    console.log("[hml/graph-inject]", graphLogs.join(" | "));
  }

  // 멀티 문항 → PDF 구조(문제 전체 → 빠른정답 → 해설 전체) 빌더 호출.
  // 기존엔 문항별 SECTION 잘라 concat 해서 [문제]/[정답]/[해설] 가 문항마다 인라인으로
  // 섞이는 잘못된 구조였음 — buildExamExplanationHmlMultiBuffer 가 3섹션으로 정리.
  const buffer = buildExamExplanationHmlMultiBuffer({
    examName,
    runs: validRuns.map((r) => {
      // 원본 크롭 이미지가 있으면 questionText 머리에 마크다운 이미지 라인 prepend.
      // HML 빌더가 마크다운 이미지를 자동으로 해당 위치에 임베드.
      const imgLine =
        r.questionImageDataUrl && r.questionImageDataUrl.startsWith("data:image/")
          ? `![문항 ${r.questionNo} 원본 이미지](${r.questionImageDataUrl})\n\n`
          : "";
      return {
        questionNo: r.questionNo,
        questionText: imgLine + (r.questionText || ""),
        parsed: r.parsed!,
      };
    }),
  });

  const fileName = `${safeFilename(examName)}_해설.hml`;

  // Drive 「작업완료」 폴더 자동 업로드 — DOCX 와 동일 동선.
  // HWP 가 실무 메인 포맷이므로 Drive 동기화도 동등하게 받쳐 준다.
  let driveFileId = "";
  let driveWebViewLink = "";
  let driveError = "";
  if (isGoogleDriveConfigured()) {
    try {
      const drive = getDriveClient();
      const folderId = await resolveDriveWorkCompleteFolderId(drive);
      const up = await uploadBufferToDriveFolder({
        folderId,
        fileName,
        buffer,
        mimeType: "application/x-hwpml",
      });
      driveFileId = up.id;
      driveWebViewLink = up.webViewLink;
    } catch (e) {
      // 업로드 실패해도 다운로드는 성공시킴 — 사용자 작업 끊기지 않게
      driveError = (e as Error).message;
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/x-hwpml; charset=utf-8",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
    "Content-Length": String(buffer.length),
  };
  if (driveFileId) {
    headers["X-Drive-File-Id"] = driveFileId;
    headers["X-Drive-Web-View-Link"] = driveWebViewLink;
  }
  if (driveError) headers["X-Drive-Upload-Error"] = encodeURIComponent(driveError);
  headers["Access-Control-Expose-Headers"] =
    "X-Drive-File-Id, X-Drive-Web-View-Link, X-Drive-Upload-Error, Content-Disposition";

  return new NextResponse(new Uint8Array(buffer), { status: 200, headers });
}
