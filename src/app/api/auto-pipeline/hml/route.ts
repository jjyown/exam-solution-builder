/**
 * src/app/api/auto-pipeline/hml/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST: parsed 결과(단일 또는 다중)를 한컴 한글 .hml 로 변환해 즉시 다운로드.
 *
 *  body:
 *    { examName?: string, runs: [{ questionNo, questionText?, parsed, questionImageDataUrl? }] }
 *
 *  크롭 이미지 처리 (ENABLE_HML_OCR 환경변수):
 *    false(기본): questionText 내 마크다운 이미지 data URL → "[이미지]" 텍스트로 strip.
 *                  한컴 파서 크래시 방지.
 *    true:         Gemini Vision OCR → 텍스트/LaTeX 추출. 비용 실측 후 운영 노출.
 *
 *  응답: HML XML 파일 (Content-Type: application/x-hwpml).
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
  questionImageDataUrl?: string;
};

type Body = {
  examName?: string;
  runs?: RunItem[];
};

// ── OCR 설정 ──────────────────────────────────────────────────────────────────
const OCR_ENABLED = process.env.ENABLE_HML_OCR === "true";

const OCR_EXTRACT_PROMPT = `이 수학 시험 문제 이미지에서 내용을 추출하세요.

규칙:
1. 한국어 텍스트 그대로 출력
2. 수식: 인라인은 $...$, 별도 줄은 $$...$$ (LaTeX)
3. 그래프/함수그래프/좌표계/기하도형이 있으면 matplotlib Python 코드로 재현:
   \`\`\`python
   import matplotlib.pyplot as plt
   # 그래프 재현 코드
   plt.savefig("output.png", dpi=150)
   \`\`\`
4. 보기(ㄱ, ㄴ, ㄷ)는 각 줄에
5. HTML/마크다운 이미지 태그 없이 순수 텍스트/LaTeX/Python만 출력`.trim();

/** questionText 내 마크다운 이미지 data URL → "[이미지]" 치환 (OCR 비활성 시 fallback) */
function stripMarkdownImages(text: string): string {
  return text.replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, "[이미지]");
}

/** Gemini Vision으로 이미지 → 텍스트/LaTeX 추출. 실패 시 "[이미지]" 반환. */
async function callGeminiOcrVision(base64: string, mimeType: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "[이미지]";
  const model =
    process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: OCR_EXTRACT_PROMPT },
            { inlineData: { mimeType, data: base64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0.1 },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini OCR ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  const text: string =
    data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text)
      .filter(Boolean)
      .join("") || "";

  // 단가 추적용 로깅 — Railway 로그에서 확인
  const usage = data?.usageMetadata;
  if (usage) {
    console.log(
      `[hml/ocr] tokens: input=${usage.promptTokenCount ?? "?"} output=${usage.candidatesTokenCount ?? "?"} total=${usage.totalTokenCount ?? "?"}`,
    );
  }

  return text.trim() || "[이미지]";
}

/**
 * questionText 내 마크다운 이미지 data URL → Gemini OCR 텍스트로 치환.
 * 실패 시 "[이미지 — OCR 실패]" fallback.
 */
async function ocrQuestionImages(text: string): Promise<string> {
  const MDI_RE = /!\[[^\]]*\]\((data:image\/(png|jpe?g|webp);base64,[^)]+)\)/g;
  const matches = [...text.matchAll(MDI_RE)];
  if (matches.length === 0) return text;

  let result = text;
  for (const match of matches) {
    const fullMatch = match[0];
    const dataUrl = match[1];
    const subtype = match[2] === "jpg" ? "jpeg" : match[2];
    const mimeType = `image/${subtype}`;
    const base64 = dataUrl.replace(/^data:[^,]+,/, "");

    try {
      const extracted = await callGeminiOcrVision(base64, mimeType);
      result = result.replace(fullMatch, extracted);
    } catch (e) {
      console.error(`[hml/ocr] 실패:`, (e as Error).message.slice(0, 200));
      result = result.replace(fullMatch, "[이미지 — OCR 실패]");
    }
  }
  return result;
}

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
    return NextResponse.json({ ok: false, error: "runs[] 가 필요합니다." }, { status: 400 });
  }

  const examName = (body.examName || "해설지").trim();
  const validRunsRaw = body.runs.filter((r) => r.parsed);
  if (validRunsRaw.length === 0) {
    return NextResponse.json(
      { ok: false, error: "유효한 parsed 결과가 없습니다." },
      { status: 400 },
    );
  }

  // ── 1. questionText 이미지 처리 ────────────────────────────────────────────
  // questionImageDataUrl 도 questionText 앞에 prepend (기존 동작 유지)
  const runsWithImg = validRunsRaw.map((r) => {
    const imgLine =
      r.questionImageDataUrl && r.questionImageDataUrl.startsWith("data:image/")
        ? `![문항 ${r.questionNo} 원본 이미지](${r.questionImageDataUrl})\n\n`
        : "";
    return {
      ...r,
      questionText: imgLine + (r.questionText || ""),
    };
  });

  // OCR_ENABLED=true: Gemini Vision으로 텍스트 추출
  // OCR_ENABLED=false(기본): 이미지 data URL만 strip → 크래시 방지
  const processedRuns = await Promise.all(
    runsWithImg.map(async (r) => ({
      ...r,
      questionText: OCR_ENABLED
        ? await ocrQuestionImages(r.questionText || "")
        : stripMarkdownImages(r.questionText || ""),
    })),
  );

  // ── 2. Python 그래프 블록 → matplotlib PNG 주입 ───────────────────────────
  const { runs: validRuns, logs: graphLogs } =
    await injectGeneratedGraphsIntoRuns(processedRuns);
  if (graphLogs.length > 0) {
    console.log("[hml/graph-inject]", graphLogs.join(" | "));
  }

  // ── 3. HML 빌드 ───────────────────────────────────────────────────────────
  const buffer = buildExamExplanationHmlMultiBuffer({
    examName,
    runs: validRuns.map((r) => ({
      questionNo: r.questionNo,
      questionText: r.questionText,
      parsed: r.parsed!,
    })),
  });

  const fileName = `${safeFilename(examName)}_해설.hml`;

  // ── 4. Drive 「작업완료」 폴더 자동 업로드 ────────────────────────────────
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
