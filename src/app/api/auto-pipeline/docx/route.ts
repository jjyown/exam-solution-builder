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
import { noThinkingConfig, isResponseTruncated } from "@/lib/geminiGenerationConfig";
import {
  getDriveClient,
  findOrCreateChildFolder,
  isGoogleDriveConfigured,
  resolveDriveWorkCompleteFolderId,
  uploadBufferToDriveFolder,
} from "@/lib/googleDrive";
import { injectGeneratedGraphsIntoRuns } from "@/lib/explanationGraphInjection";
import {
  validateExplanationConsistency,
  type ValidationSeverity,
} from "@/lib/explanationAnswerValidators";
import { simplifyLatexContent } from "@/lib/latexToPlainText";

/**
 * 방어 후처리 (PR-1 Commit 4) — LLM 이 룰을 위반해 `text` 필드에 raw LaTeX
 * 명령(`\frac`, `\sqrt`, `^{}` 등)을 박는 케이스 대응. `$$..$$` / `$..$` 토큰
 * 안은 examExplanationDocx 가 latexAware 로 처리하므로 그대로 두고, 토큰 밖에서만
 * `simplifyLatexContent` 평문화.
 *
 * 검토창 3회차 Commit 4 보강 — Commit 4 가정 "$$ 분기로 떨어질 일 없음" 너무
 * 낙관적, 본 sanitize 가 방어망.
 */
function sanitizeOutsideToken(s: string): string {
  if (
    /\\(?:frac|sqrt|sum|int|alpha|beta|gamma|delta|pi|theta|sigma|lambda|omega|cdot|times|leq|geq|neq|infty|to|left|right)\b/.test(
      s,
    ) ||
    /[\^_]\{[^}]+\}/.test(s)
  ) {
    return simplifyLatexContent(s);
  }
  return s;
}

function sanitizeStepTextForRender(text: string): string {
  const tokenRe = /\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g;
  let lastIdx = 0;
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const pre = text.slice(lastIdx, m.index);
    if (pre) parts.push(sanitizeOutsideToken(pre));
    parts.push(m[0]);
    lastIdx = m.index + m[0].length;
  }
  const tail = text.slice(lastIdx);
  if (tail) parts.push(sanitizeOutsideToken(tail));
  return parts.join("");
}

// ── OCR 설정 ──────────────────────────────────────────────────────────────────
const OCR_ENABLED = process.env.ENABLE_DOCX_OCR === "true";

const OCR_EXTRACT_PROMPT = `이 수학 시험 문제 이미지에서 내용을 추출하세요.

규칙:
1. 한국어 텍스트 그대로 출력
2. 수식: 인라인은 $...$, 별도 줄은 $$...$$ (LaTeX). 분수는 반드시 \\frac{a}{b} (변수 포함 분수도 LaTeX 필수, 평문 슬래시 a/b 표기 절대 금지 — 예: 잘못 \`f(x)=3x+2/-3x+a\`, 올바름 \`f(x)=\\frac{3x+2}{-3x+a}\`). 루트 \\sqrt{x}, 적분 \\int, 시그마 \\sum 등 표준 명령어 사용
3. 도형/그래프/좌표계/기하도형이 있으면 본문 끝에 \`[그림: 좌표평면 위에 ...]\` 한 줄로 핵심 요소를 묘사한다. 좌표·점 라벨·선분 관계·곡선 종류를 포함. matplotlib Python 코드 출력 금지
4. 객관식 선지 번호는 반드시 ①②③④⑤ 로 출력. 1) 2) 3) 또는 (1) (2) (3) 변환 금지
5. <보기> 형태의 ㄱ, ㄴ, ㄷ 보기는 각 줄에. 본문 안의 박스로 묶인 영역(보기, 조건)은 <보기>...</보기> 태그로 감싼다
6. 문항 번호는 원문 표기 그대로 (1., 2., 001 등). 임의 변형 금지
7. 한자·특수기호는 원문 그대로 옮긴다. 한글 변환·생략 금지
8. 시험지 헤더/페이지 번호/시험지명 등 메타 정보는 출력 제외
9. HTML/마크다운 이미지 태그 없이 순수 텍스트/LaTeX 만 출력`.trim();

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
      // plan v26 단계 2.5: thinking 비활성 + maxOutputTokens 명시.
      // 문제 본문 OCR은 보통 짧지만 시험지 한 문항이 길어지면 잘림 가능 → 4096 충분.
      generationConfig: noThinkingConfig(4096, { temperature: 0.1 }),
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini OCR ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  // 잘림 감지 — retrospective 가 자동 집계
  if (isResponseTruncated(data)) {
    console.warn(
      `[ocr_truncated] docx/route.ts ${model} maxOutputTokens=4096 한도 도달 — 응답 잘림 가능.`,
    );
  }
  const text: string =
    data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text)
      .filter(Boolean)
      .join("") || "";

  const usage = data?.usageMetadata;
  if (usage) {
    console.log(
      `[docx/ocr] tokens: input=${usage.promptTokenCount ?? "?"} output=${usage.candidatesTokenCount ?? "?"} total=${usage.totalTokenCount ?? "?"}`,
    );
  }

  return text.trim() || "[이미지]";
}

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
  /**
   * 원본 문제 이미지 (data URL 형식: 'data:image/png;base64,...').
   * /crop 에서 잘라낸 이미지가 있으면 [문제] 섹션 위에 그대로 삽입.
   * DOCX 빌더가 마크다운 이미지 라인을 자동으로 ImageRun 으로 변환.
   * 비전 모드에서 questionText 가 placeholder 라 본문 텍스트가 거의 없어도
   * 사용자가 어떤 문제인지 한눈에 알 수 있게 해주는 핵심 단서.
   */
  questionImageDataUrl?: string;
};

type Body = {
  examName?: string;
  runs?: RunItem[];
};

function safeExamFolder(name: string): string {
  return (name || "기타").replace(/[\\/:*?"<>|]/g, "_").slice(0, 50);
}

function toKstDateTimeStr(): string {
  // UTC → KST(+9) → "YYYY-MM-DD HH-mm" (콜론은 Drive 폴더명 불가 → 하이픈)
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
}

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
  // 원본 크롭 이미지가 있으면 마크다운 이미지 라인으로 삽입 — DOCX 빌더가
  // parseMarkdownImageLine + bufferFromDataUrl 로 자동 임베드.
  // 이미지 있으면 본문 텍스트 생략 — 평문화 회피 (v29 F안, plan v18~v28 종결).
  if (run.questionImageDataUrl?.startsWith("data:image/")) {
    lines.push(`![문항 ${run.questionNo} 원본 이미지](${run.questionImageDataUrl})`);
  } else {
    const body = cleanQuestionText(run.questionNo, run.questionText);
    lines.push(body || "(문제 본문 누락 — 운영자 검수 필요)");
  }
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
    if (step.text) lines.push(`${num} ${sanitizeStepTextForRender(step.text)}`);
    if (step.equation) {
      // Fix-W2c: LaTeX 줄바꿈 `\\` 기준 split → 라인별 별도 $$..$$ PNG.
      // Fix-W2b(한 줄 join)가 가로 폭 초과로 잘림 발생 → 라인별 분리로 해소.
      // 함정: \begin{cases}...\\...\end{cases} 환경 내부 \\ 도 split됨 — 환경 깨짐
      // 발견 시 별도 Fix-W2d (환경 검출 후 보존) 회차 진입.
      // \n 은 먼저 공백으로 normalize (line split 시 $$..$$ 매칭 깨짐 방지).
      const flat = step.equation.replace(/\n/g, " ");
      const eqLines = flat.split(/\\\\/).map((l) => l.trim()).filter(Boolean);
      for (const eqLine of eqLines) {
        lines.push(`   $$${eqLine}$$`);
      }
    }
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

  // ── 1. questionImageDataUrl OCR 처리 ─────────────────────────────────────
  // ENABLE_DOCX_OCR=true: Gemini Vision → OCR 텍스트로 questionText 대체
  // ENABLE_DOCX_OCR=false(기본): 현행 유지 (이미지 그대로 embed)
  if (OCR_ENABLED) {
    body.runs = await Promise.all(
      body.runs.map(async (r) => {
        const dataUrl = r.questionImageDataUrl;
        if (!dataUrl?.startsWith("data:image/")) return r;
        const m = dataUrl.match(
          /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)$/,
        );
        if (!m) return r;
        const mimeType = `image/${m[1] === "jpg" ? "jpeg" : m[1]}`;
        try {
          const ocrText = await callGeminiOcrVision(m[2].replace(/\s/g, ""), mimeType);
          return { ...r, questionImageDataUrl: undefined, questionText: ocrText };
        } catch (e) {
          console.error("[docx/ocr] 실패:", (e as Error).message.slice(0, 200));
          return r; // 실패 시 원본 유지 (이미지 embed 경로)
        }
      }),
    );
  }

  // ── 2. 그래프 후처리 ─────────────────────────────────────────────────────
  // ```python``` 펜스 → matplotlib PNG → dataURL 마크다운.
  // EXPLANATION_GRAPH_RUN env 가 켜진 환경에서만 실제 실행. 꺼져 있으면 그대로 통과.
  const { runs: processedRuns, logs: graphLogs } = await injectGeneratedGraphsIntoRuns(body.runs);
  if (graphLogs.length > 0) {
    console.log("[docx/graph-inject]", graphLogs.join(" | "));
  }
  body.runs = processedRuns;

  const explanationBody = body.runs.map(renderRunAsBlock).join("\n\n");
  const quickAnswerLine = body.runs
    .filter((r) => r.parsed?.answer)
    .map((r) => `${r.questionNo}: ${r.parsed!.answer}`)
    .join(", ");

  // ── 자동 검증 5종 (PR-1 Commit 4, LLM 호출 X — 정규식·구조만, 비용 0) ──
  // 결과는 응답 헤더 X-Validation-Severity 로 전달. 자세한 issues 는 Commit 5.7
  // 4배지 UI 가 별 endpoint(향후 신설) 또는 본 console.log 로 확인.
  let validationSeverity: ValidationSeverity = "ok";
  const allValidationIssues: string[] = [];
  for (const run of body.runs) {
    if (!run.parsed) continue;
    const blockText = renderRunAsBlock(run);
    const equations = run.parsed.explanation_steps
      .map((s) => s.equation || "")
      .filter(Boolean);
    const result = validateExplanationConsistency(blockText, equations);
    if (result.severity === "error") validationSeverity = "error";
    else if (result.severity === "warn" && validationSeverity === "ok") validationSeverity = "warn";
    if (result.issues.length > 0) {
      allValidationIssues.push(...result.issues.map((s) => `[Q${run.questionNo}] ${s}`));
    }
  }
  if (allValidationIssues.length > 0) {
    console.log(
      `[docx/validation] severity=${validationSeverity} issues=${allValidationIssues.length}건`,
    );
    for (const issue of allValidationIssues.slice(0, 20)) {
      console.log(`  · ${issue}`);
    }
  }

  try {
    const { buffer, docxFileName } = await buildExamExplanationDocxBuffer({
      examName,
      explanationBody,
      quickAnswer: quickAnswerLine || "-",
    });

    // Drive 「작업완료」 폴더 자동 업로드 — 페이지에서 링크 받아 표시
    let driveFileId = "";
    let driveWebViewLink = "";
    let driveError = "";
    if (isGoogleDriveConfigured()) {
      try {
        const drive = getDriveClient();
        const workCompleteFolderId = await resolveDriveWorkCompleteFolderId(drive);
        const examFolderId = await findOrCreateChildFolder(workCompleteFolderId, safeExamFolder(examName));
        const folderId = await findOrCreateChildFolder(examFolderId, toKstDateTimeStr());
        const up = await uploadBufferToDriveFolder({
          folderId,
          fileName: docxFileName,
          buffer,
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
        driveFileId = up.id;
        driveWebViewLink = up.webViewLink;
      } catch (e) {
        // 업로드 실패해도 다운로드 자체는 성공시켜서 사용자 작업이 끊기지 않게 한다
        driveError = (e as Error).message;
      }
    }

    const headers: Record<string, string> = {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(docxFileName)}"`,
      "Content-Length": String(buffer.length),
      "X-Validation-Severity": validationSeverity,
      "X-Validation-Issue-Count": String(allValidationIssues.length),
    };
    if (driveFileId) {
      headers["X-Drive-File-Id"] = driveFileId;
      headers["X-Drive-Web-View-Link"] = driveWebViewLink;
    }
    if (driveError) headers["X-Drive-Upload-Error"] = encodeURIComponent(driveError);
    headers["Access-Control-Expose-Headers"] =
      "X-Drive-File-Id, X-Drive-Web-View-Link, X-Drive-Upload-Error, Content-Disposition";

    return new NextResponse(new Uint8Array(buffer), { status: 200, headers });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `DOCX 생성 실패: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
