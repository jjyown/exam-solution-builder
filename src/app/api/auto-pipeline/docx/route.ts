/**
 * src/app/api/auto-pipeline/docx/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST: parsed 결과(단일 또는 다중)를 기존 DOCX 빌더(examExplanationDocx)
 *  형식으로 변환해 즉시 다운로드.
 *
 *  body: {
 *    examName?: string,
 *    runs: [
 *      { questionNo: string, parsed: ParsedExplanation }
 *    ]
 *  }
 *
 *  응답: docx 바이너리 (Content-Disposition: attachment).
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { buildExamExplanationDocxBuffer } from "@/lib/examExplanationDocx";

type ParsedStep = { text: string; equation: string };
type Parsed = {
  answer: string;
  explanation_steps: ParsedStep[];
  summary?: string;
};

type RunItem = {
  questionNo: string;
  /** 원본 문제 본문 (자동 파이프라인이 보존한 questionText) — DOCX 「문제」 섹션에 들어간다 */
  questionText?: string;
  parsed: Parsed | null;
};

type Body = {
  examName?: string;
  runs?: RunItem[];
};

/**
 * questionText에서 노이즈(시험지 메타·번호 머리)를 떼고 본문만 남긴다.
 * `[문항 N] ` 접두는 빌더가 다시 붙이므로 제거.
 */
function cleanQuestionText(no: string, raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(new RegExp(`^\\s*\\[문항\\s*${no}\\]\\s*`, "i"), "")
    .replace(/^\s*\d+\s*[\.\)번]\s*/, "")
    .trim();
}

/**
 * ParsedExplanation 1건 → `[문항 N] / [문제] / [정답] / [해설]` 형식.
 * examExplanationDocx의 parseExplanationBlocks 가 [문제] 마커를 우선 인식해
 * 자동으로 (문제) → (빠른정답) → (해설) 3섹션 양식 (TEST 1, 2 표준) 으로 분리한다.
 * `[문제]` 마커를 명시해야 본문 누락 없이 안정적으로 분리된다.
 */
function renderRunAsBlock(run: RunItem): string {
  const lines: string[] = [];
  lines.push(`[문항 ${run.questionNo}]`);
  lines.push(`[문제]`);
  const body = cleanQuestionText(run.questionNo, run.questionText);
  lines.push(body || "(문제 본문 누락 — 운영자 검수 필요)");
  if (!run.parsed) {
    lines.push(`[정답] -`);
    lines.push(`[해설]`);
    lines.push(`(생성 실패 — 운영자 검수 필요)`);
    return lines.join("\n");
  }
  lines.push(`[정답] ${run.parsed.answer || "-"}`);
  lines.push(`[해설]`);
  run.parsed.explanation_steps.forEach((step, i) => {
    const num = `${i + 1}.`;
    if (step.text) lines.push(`${num} ${step.text}`);
    if (step.equation) lines.push(`   $$${step.equation}$$`);
  });
  if (run.parsed.summary) {
    lines.push("");
    lines.push(run.parsed.summary);
  }
  return lines.join("\n");
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
  const explanationBody = body.runs.map(renderRunAsBlock).join("\n\n");
  const quickAnswerLine = body.runs
    .filter((r) => r.parsed?.answer)
    .map((r) => `${r.questionNo}: ${r.parsed!.answer}`)
    .join(", ");

  try {
    const { buffer, docxFileName } = await buildExamExplanationDocxBuffer({
      examName,
      explanationBody,
      quickAnswer: quickAnswerLine || "-",
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(docxFileName)}"`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `DOCX 생성 실패: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
