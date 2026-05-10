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
import { buildExamExplanationHmlBuffer } from "@/lib/examExplanationHml";

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
  const validRuns = body.runs.filter((r) => r.parsed);
  if (validRuns.length === 0) {
    return NextResponse.json(
      { ok: false, error: "유효한 parsed 결과가 없습니다." },
      { status: 400 },
    );
  }

  // 다중 문항 — 각 문항을 같은 SECTION 안에 차례로 (단순 concat).
  // HML 빌더가 single 입력을 받으므로 각 문항마다 본문 누적.
  // 첫 문항만 examName 헤더 표시, 나머지는 [문항 N] 만.
  let combinedHmlBody = "";
  validRuns.forEach((r, idx) => {
    const oneHml = buildExamExplanationHmlBuffer({
      examName: idx === 0 ? examName : undefined,
      questionNo: r.questionNo,
      questionText: r.questionText,
      parsed: r.parsed!,
    }).toString("utf8");
    // BODY/SECTION 안 P 들만 추출 (단순 정규식)
    const m = oneHml.match(/<SECTION>([\s\S]*?)<\/SECTION>/);
    combinedHmlBody += m ? m[1] : "";
    if (idx < validRuns.length - 1) {
      combinedHmlBody += "<P><TEXT><CHAR></CHAR></TEXT></P>";  // 빈 줄 구분
    }
  });

  // 합본 HML 생성 — 첫 문항의 head 를 wrapper 로 재사용
  const head = `<HEAD SecCnt="1"><BEGINNUM Page="1" Footnote="1" Endnote="1" Pic="1" Tbl="1" Equation="1"/><FACENAMELIST><FONTFACE Lang="HANGUL" Count="1"><FONT Id="0" Type="TTF" Name="함초롬바탕"/></FONTFACE></FACENAMELIST></HEAD>`;
  const finalHml = `<?xml version="1.0" encoding="UTF-8"?>\n<HWPML Version="2.81" SubVersion="2.81">${head}<BODY><SECTION>${combinedHmlBody}</SECTION></BODY></HWPML>`;
  const buffer = Buffer.from(finalHml, "utf8");

  const fileName = `${safeFilename(examName)}_해설.hml`;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-hwpml; charset=utf-8",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
    "Content-Length": String(buffer.length),
    "Access-Control-Expose-Headers": "Content-Disposition",
  };
  return new NextResponse(new Uint8Array(buffer), { status: 200, headers });
}
