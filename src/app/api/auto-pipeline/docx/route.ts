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

type RunItem = { questionNo: string; parsed: Parsed | null };

type Body = {
  examName?: string;
  runs?: RunItem[];
};

/** ParsedExplanation 1건 → `[문항 N]/[정답]/[해설]` 마크다운 블록. */
function renderRunAsBlock(run: RunItem): string {
  const lines: string[] = [];
  lines.push(`[문항 ${run.questionNo}]`);
  if (!run.parsed) {
    lines.push("[정답] -");
    lines.push("[해설] (생성 실패)");
    return lines.join("\n");
  }
  lines.push(`[정답] ${run.parsed.answer || "-"}`);
  lines.push("[해설]");
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
