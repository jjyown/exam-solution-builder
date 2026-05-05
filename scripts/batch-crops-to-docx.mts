/**
 * 크롭 이미지 폴더 → (로컬 Next) `/api/generate-explanation`(Gemini·OpenAI 라우트) → `해설지 최종본` DOCX
 *
 * **기본(의도):** 문항마다 API로 `[정답]`/`[해설]` 생성 후, `[문항 1]`… 형식으로 **한 파일**에 묶어 단일 DOCX 저장.
 *
 * 입력: 폴더의 PNG/JPEG/Webp 또는 `.zip`(내부 ZIP·이미지 재귀 — 기존 로직).
 *
 * 전제: `npm run dev` + `.env.local` (GEMINI_API_KEY 등 — 서버 라우트와 동일). `--mathpix` 사용 시 같은 파일에 MATHPIX_APP_ID / MATHPIX_APP_KEY.
 *
 * 사용:
 *   npm run batch:crops-to-docx
 *   npm run batch:crops-to-docx -- --exam-name "2026 모의고사"
 *   npm run batch:crops-to-docx -- --split-docx
 *   npm run batch:crops-to-docx -- --drafts-only   # DOCX 안 만듦 → 해설 작업중/ 초안만 (MCP·Cursor 중재 후 write-final-docx)
 *
 * 옵션:
 *   --input <dir>       기본: ./크롭된 시험지
 *   --exam-name <이름>  합본 DOCX 시험지 표제(생략 시 zip/폴더명 추정)
 *   --split-docx          문항마다 DOCX **분리**(구 동작). 생략 시 **합본 1개(기본)**.
 *   --drafts-only       **DOCX 생성 안 함.** API 초안만 `해설 작업중/<시험명>/` 에 텍스트로 저장 → Cursor·MCP 중재 후 `npm run write-final-docx`.
 *   --mathpix           해설 요청 전에 `/api/mathpix-text` 로 OCR → `questionText`로 Gemini에 전달(이미지와 불일치 시 이미지 우선 지시).
 *   --mathpix-min-confidence <0~1>  Mathpix confidence 미만이면 questionText 생략(기본 0 = 미사용).
 *   --mathpix-strict    Mathpix 실패·한도 초과 시 해당 문항을 실패 처리(기본은 경고만 하고 이미지만으로 진행).
 *   --mathpix-no-cache  Mathpix 결과 파일 캐시(.cache/mathpix) 무시.
 *   --base-url <url>    기본: http://localhost:3000
 *   --recursive / --no-recursive
 *   --delay-ms <n>      기본 800
 *   --generation-mode test|final
 *   --solver-profile easy|balanced|killer
 *   --dry-run
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { ExplanationProgressReport } from "../src/lib/explanationProgressReport";

/**
 * tsx가 배치 엔트리를 번들할 때 `../src/lib/explanationProgressReport` 값 import 가 깨지는 경우가 있어
 * `formatProgressReportKo` 만 여기 복제한다. (`src/lib/explanationProgressReport.ts` 와 동기화 유지)
 */
function formatProgressReportKo(
  questionLabel: string,
  report: {
    phases: {
      phase1_gemini: { label: string; detail: string; modelHint: string };
      phase1b_autoChecks: {
        objectiveMcFormatOk: boolean;
        objectiveMcIssues: string[];
        truncatedSuspected: boolean;
        explanationCharCount: number;
        explanationTooLongForProfile: boolean;
        profileMaxCharsHint: number;
        killerStyleSuspected: boolean;
        unsolvableOrNegativeMeta: boolean;
      };
      phase2_crossVerify: { applied: boolean; detail: string };
    };
    cursorManualChecklist: string[];
  },
): string {
  const p = report.phases;
  const lines: string[] = [];
  lines.push(`──────── 문항 ${questionLabel} ────────`);
  lines.push(`[1차] ${p.phase1_gemini.label}: ${p.phase1_gemini.detail}`);
  lines.push(`      모델 힌트: ${p.phase1_gemini.modelHint}`);
  lines.push(`[자동검사] 객관식·정답 형식: ${p.phase1b_autoChecks.objectiveMcFormatOk ? "통과" : "주의"}`);
  if (p.phase1b_autoChecks.objectiveMcIssues.length > 0) {
    p.phase1b_autoChecks.objectiveMcIssues.forEach((x) => lines.push(`          · ${x}`));
  }
  lines.push(
    `          잘림 의심: ${p.phase1b_autoChecks.truncatedSuspected ? "예" : "아니오"} · 해설 글자수: ${p.phase1b_autoChecks.explanationCharCount} (권장≤${p.phase1b_autoChecks.profileMaxCharsHint})`,
  );
  lines.push(
    `          킬러급 분량 의심: ${p.phase1b_autoChecks.killerStyleSuspected || p.phase1b_autoChecks.explanationTooLongForProfile ? "예(검토)" : "아니오"}`,
  );
  lines.push(
    `          부정 메타(못 푼다 등): ${p.phase1b_autoChecks.unsolvableOrNegativeMeta ? "감지됨" : "없음"}`,
  );
  lines.push(`[2차] 교차검증: ${p.phase2_crossVerify.applied ? "적용" : "미적용/유지"} — ${p.phase2_crossVerify.detail}`);
  if (report.cursorManualChecklist.length > 0) {
    lines.push(`[Cursor 수동 확인 권장]`);
    report.cursorManualChecklist.forEach((c) => lines.push(`  · ${c}`));
  }
  lines.push("");
  return lines.join("\n");
}

/** `src/lib/outputPaths.ts` 의 `CROPPED_EXAMS_DIR_NAME` 과 동일 */
const CROPPED_EXAMS_DIR_NAME = "크롭된 시험지";
const FINAL_EXPLANATION_DIR_NAME = "해설지 최종본";
/** `--drafts-only` 시 초안 텍스트만 저장 (DOCX 전 Cursor·MCP 중재용) */
const DRAFT_WORK_DIR_NAME = "해설 작업중";

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

type Cli = {
  inputDir: string;
  baseUrl: string;
  recursive: boolean;
  dryRun: boolean;
  delayMs: number;
  generationMode: "test" | "final";
  solverProfile: "easy" | "balanced" | "killer";
  /** true면 문항별 DOCX; false(기본)면 전부 합쳐 1개 DOCX */
  splitDocx: boolean;
  examName: string;
  /** true면 DOCX 생략, 해설 작업중 폴더에 초안 텍스트만 */
  draftsOnly: boolean;
  /** Mathpix OCR로 questionText 보강 */
  mathpix: boolean;
  /** 0이면 신뢰도 필터 없음. 0~1 사이면 Mathpix confidence가 이보다 작을 때 questionText 생략 */
  mathpixMinConfidence: number;
  mathpixStrict: boolean;
  mathpixNoCache: boolean;
};

function parseArgs(argv: string[]): Cli {
  let inputDir = "";
  let baseUrl = "http://localhost:3000";
  let recursive = true;
  let dryRun = false;
  let delayMs = 800;
  let generationMode: "test" | "final" = "final";
  let solverProfile: "easy" | "balanced" | "killer" = "balanced";
  let splitDocx = false;
  let examName = "";
  let draftsOnly = false;
  let mathpix = false;
  let mathpixMinConfidence = 0;
  let mathpixStrict = false;
  let mathpixNoCache = false;

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) {
      inputDir = argv[i + 1];
      i += 1;
    } else if (a === "--base-url" && argv[i + 1]) {
      baseUrl = argv[i + 1].replace(/\/$/, "");
      i += 1;
    } else if (a === "--recursive" || a === "-r") {
      recursive = true;
    } else if (a === "--no-recursive") {
      recursive = false;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--delay-ms" && argv[i + 1]) {
      delayMs = Math.max(0, Number(argv[i + 1]) || 0);
      i += 1;
    } else if (a === "--generation-mode" && argv[i + 1]) {
      const v = argv[i + 1].toLowerCase();
      if (v === "test" || v === "final") generationMode = v;
      i += 1;
    } else if (a === "--solver-profile" && argv[i + 1]) {
      const v = argv[i + 1].toLowerCase();
      if (v === "easy" || v === "balanced" || v === "killer") solverProfile = v;
      i += 1;
    } else if (a === "--split-docx" || a === "--one-doc-per-image") {
      splitDocx = true;
    } else if (a === "--exam-name" && argv[i + 1]) {
      examName = argv[i + 1];
      i += 1;
    } else if (a === "--drafts-only" || a === "--no-docx") {
      draftsOnly = true;
    } else if (a === "--mathpix") {
      mathpix = true;
    } else if (a === "--mathpix-min-confidence" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n >= 0 && n <= 1) mathpixMinConfidence = n;
      i += 1;
    } else if (a === "--mathpix-strict") {
      mathpixStrict = true;
    } else if (a === "--mathpix-no-cache") {
      mathpixNoCache = true;
    }
  }

  if (!inputDir.trim()) {
    inputDir = `./${CROPPED_EXAMS_DIR_NAME}`;
  }

  return {
    inputDir,
    baseUrl,
    recursive,
    dryRun,
    delayMs,
    generationMode,
    solverProfile,
    splitDocx,
    examName,
    draftsOnly,
    mathpix,
    mathpixMinConfidence,
    mathpixStrict,
    mathpixNoCache,
  };
}

function mimeForImage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function extractQuickAnswerFromBody(body: string): string {
  const m = body.match(/\[정답\]\s*([^\n\r]*)/i);
  const v = m?.[1]?.trim();
  return v && v.length > 0 ? v : "-";
}

/** generate-explanation 라우트와 동일: `[문제]` 선행 시 `[정답]`부터만 남김 */
function sliceFromFirstAnswerHeader(text: string): string {
  const t = text.trim();
  const idx = t.search(/\[정답\]/i);
  if (idx < 0) return t;
  return t.slice(idx).trim();
}

function buildCompositeQuickAnswer(bodies: string[]): string {
  const parts = bodies.map((body, i) => `${i + 1}:${extractQuickAnswerFromBody(body)}`);
  const s = parts.join(" ");
  return s.length > 220 ? `${parts.slice(0, 10).join(" ")} …` : s;
}

function examNameFromImage(inputRoot: string, filePath: string): string {
  const rel = path.relative(path.resolve(inputRoot), filePath);
  const noExt = rel.replace(IMAGE_EXT, "");
  return noExt.split(path.sep).join("_") || path.parse(filePath).name;
}

type BatchImageJob = {
  relLabel: string;
  examName: string;
  buffer: Buffer;
  mimeType: string;
};

function inferBundleExamName(jobs: BatchImageJob[], fallbackDir: string, override: string): string {
  const o = override.trim();
  if (o) return o;
  const lbl = jobs[0]?.relLabel ?? "";
  const outer = lbl.split(" > ")[0]?.trim() ?? "";
  if (outer) {
    const base = path.basename(outer);
    if (/\.zip$/i.test(base)) return base.replace(/\.zip$/i, "");
    return base || path.basename(path.resolve(fallbackDir));
  }
  return path.basename(path.resolve(fallbackDir));
}

function safeDraftFolderName(name: string): string {
  const base = name.trim() || "무제";
  return base
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
}

/** ZIP 안에 ZIP이 한 번 더 들어 있는 묶음(이중 압축)까지 재귀 처리, 깊이 최대 5 */
const MAX_ZIP_NEST = 5;

type CropManifest = {
  items?: Array<{
    questionNo?: string;
    file?: string;
  }>;
};

async function extractJobsFromZipBuffer(
  zipBuf: Buffer,
  examPathPrefix: string,
  relLabelPrefix: string,
  depth: number,
): Promise<BatchImageJob[]> {
  if (depth > MAX_ZIP_NEST) {
    console.error(`ZIP 중첩이 ${MAX_ZIP_NEST}단을 넘어 건너뜀: ${relLabelPrefix}`);
    return [];
  }
  const zip = await JSZip.loadAsync(zipBuf);
  const jobList: BatchImageJob[] = [];
  const allNames = Object.keys(zip.files)
    .filter((n) => !zip.files[n]?.dir)
    .sort((a, b) => a.localeCompare(b, "ko"));
  let manifestMainFiles: Set<string> | null = null;

  const manifestEntry = zip.file("manifest.json");
  if (manifestEntry) {
    try {
      const manifestRaw = await manifestEntry.async("string");
      const manifest = JSON.parse(manifestRaw) as CropManifest;
      const files = (manifest.items ?? [])
        .map((x) => String(x.file ?? "").trim())
        .filter((x) => x.length > 0);
      if (files.length > 0) {
        manifestMainFiles = new Set(files);
      }
    } catch (err) {
      console.warn(
        `manifest.json 파싱 실패(계속 진행): ${relLabelPrefix} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  for (const name of allNames) {
    const base = path.basename(name);
    if (/\.(png|jpe?g|webp)$/i.test(base)) {
      if (manifestMainFiles && !manifestMainFiles.has(base)) {
        continue;
      }
      const f = zip.file(name);
      if (!f) continue;
      const buffer = Buffer.from(await f.async("uint8array"));
      const innerStem = name.replace(/[/\\]/g, "_").replace(IMAGE_EXT, "");
      const examName = `${examPathPrefix}_${innerStem}`.replace(/_+/g, "_").replace(/^_|_$/g, "") || examPathPrefix;
      jobList.push({
        relLabel: `${relLabelPrefix} :: ${name}`,
        examName,
        buffer,
        mimeType: mimeForImage(name),
      });
      continue;
    }
    if (/\.zip$/i.test(base)) {
      const f = zip.file(name);
      if (!f) continue;
      const innerBuf = Buffer.from(await f.async("uint8array"));
      /** 안쪽 이미지 파일명에 이미 q1_… 이 있으므로, examPathPrefix 는 바깥과 동일하게 유지 */
      const nested = await extractJobsFromZipBuffer(
        innerBuf,
        examPathPrefix,
        `${relLabelPrefix} > ${name}`,
        depth + 1,
      );
      jobList.push(...nested);
    }
  }
  return jobList;
}

async function extractJobsFromZipFile(zipPath: string): Promise<BatchImageJob[]> {
  const zipBuf = await fs.readFile(zipPath);
  const zipBase = path.basename(zipPath).replace(/\.zip$/i, "") || "bundle";
  const rel = path.relative(process.cwd(), zipPath);
  return extractJobsFromZipBuffer(zipBuf, zipBase, rel, 0);
}

async function collectJobs(root: string, recursive: boolean): Promise<BatchImageJob[]> {
  const jobs: BatchImageJob[] = [];
  const rootAbs = path.resolve(root);

  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (recursive) await walk(full);
        continue;
      }
      if (/\.zip$/i.test(e.name)) {
        try {
          const zjobs = await extractJobsFromZipFile(full);
          jobs.push(...zjobs);
        } catch (err) {
          console.error(`ZIP 읽기 실패: ${full}`, err instanceof Error ? err.message : err);
        }
        continue;
      }
      if (!IMAGE_EXT.test(e.name)) continue;
      const buffer = await fs.readFile(full);
      jobs.push({
        relLabel: path.relative(process.cwd(), full),
        examName: examNameFromImage(rootAbs, full),
        buffer,
        mimeType: mimeForImage(full),
      });
    }
  }

  await walk(rootAbs);
  jobs.sort((a, b) => a.relLabel.localeCompare(b.relLabel, "ko"));
  return jobs;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** generate-explanation 의 `[문제 텍스트]` 블록에 넣을 Mathpix 안내 + 본문 */
const MATHPIX_QUESTION_PREFIX = `[문항 OCR 참고 — Mathpix]
아래는 크롭 이미지에 대한 OCR·수식 추출 결과이다. **이미지와 충돌하면 이미지 판독을 우선**하고, OCR은 식·문장 확인용 보조로만 쓴다.

`;

type MathpixRouteResult =
  | { ok: true; questionText: string | undefined; note?: string }
  | { ok: false; detail: string };

async function callMathpixRoute(
  mathpixUrl: string,
  cli: Cli,
  job: BatchImageJob,
): Promise<MathpixRouteResult> {
  const rel = job.relLabel;
  const imageBase64 = job.buffer.toString("base64");
  const imageMimeType = job.mimeType;

  let res: Response;
  try {
    res = await fetch(mathpixUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64,
        imageMimeType,
        skipCache: cli.mathpixNoCache,
      }),
    });
  } catch (e) {
    return {
      ok: false,
      detail: `Mathpix 요청 실패: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const raw = await res.text();
  let data: {
    ok?: boolean;
    error?: string;
    text?: string;
    confidence?: number;
    confidence_rate?: number;
    fromCache?: boolean;
  };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return { ok: false, detail: `Mathpix 응답 파싱 실패 HTTP ${res.status} — ${raw.slice(0, 200)}` };
  }

  if (!res.ok || data.ok === false) {
    const msg = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    return { ok: false, detail: msg };
  }

  const text = data.text?.trim() ?? "";
  if (!text) {
    return { ok: true, questionText: undefined, note: "Mathpix가 빈 텍스트를 반환했습니다." };
  }

  const conf =
    typeof data.confidence === "number" && Number.isFinite(data.confidence) ?
      data.confidence
    : undefined;
  if (cli.mathpixMinConfidence > 0 && conf !== undefined && conf < cli.mathpixMinConfidence) {
    return {
      ok: true,
      questionText: undefined,
      note: `Mathpix confidence ${conf} < ${cli.mathpixMinConfidence} — questionText 생략`,
    };
  }

  const cacheNote = data.fromCache ? " (캐시)" : "";
  return {
    ok: true,
    questionText: `${MATHPIX_QUESTION_PREFIX}${text}`,
    note: `Mathpix OCR 적용${cacheNote}${conf !== undefined ? `, confidence≈${conf.toFixed(3)}` : ""}`,
  };
}

type GenerateExplanationResult =
  | {
      ok: true;
      body: string;
      progressReport?: ExplanationProgressReport;
      model?: string;
    }
  | { ok: false; rel: string; detail: string };

async function postGenerateExplanation(
  generateUrl: string,
  mathpixUrl: string | null,
  cli: Cli,
  job: BatchImageJob,
): Promise<GenerateExplanationResult> {
  const rel = job.relLabel;
  const imageBase64 = job.buffer.toString("base64");
  const imageMimeType = job.mimeType;

  let questionText: string | undefined;
  if (cli.mathpix && mathpixUrl) {
    const mp = await callMathpixRoute(mathpixUrl, cli, job);
    if (!mp.ok) {
      if (cli.mathpixStrict) {
        return { ok: false, rel, detail: `[Mathpix] ${mp.detail}` };
      }
      console.warn(`[Mathpix] ${rel}: ${mp.detail} — strict 아님: 이미지만으로 진행`);
    } else {
      if (mp.note) console.warn(`[Mathpix] ${rel}: ${mp.note}`);
      questionText = mp.questionText;
    }
  }

  let res: Response;
  try {
    res = await fetch(generateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64,
        imageMimeType,
        ...(questionText ? { questionText } : {}),
        generationMode: cli.generationMode,
        solverModelProfile: cli.solverProfile,
        includeDiagramExplanation: true,
        explanationSelectionMode: "core",
        showAllMethods: false,
      }),
    });
  } catch (e) {
    return {
      ok: false,
      rel,
      detail: `요청 실패(서버가 켜져 있는지 확인): ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const raw = await res.text();
  let data: {
    result?: string;
    error?: string;
    details?: unknown;
    progressReport?: ExplanationProgressReport;
    model?: string;
  };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return {
      ok: false,
      rel,
      detail: `응답 파싱 실패 HTTP ${res.status} — ${raw.slice(0, 200)}`,
    };
  }

  if (!res.ok || !data.result?.trim()) {
    const detail =
      typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    const details = Array.isArray(data.details) ? data.details.join(" | ") : "";
    const suffix = details ? ` (${details.slice(0, 400)})` : "";
    return { ok: false, rel, detail: `${detail}${suffix}` };
  }

  return {
    ok: true,
    body: data.result.trim(),
    progressReport: data.progressReport,
    model: data.model,
  };
}

async function writeStageProgressFile(
  targetPath: string,
  headerLines: string[],
  sections: string[],
) {
  const body = [
    "■ 단계별 진행 상황 (1차 Gemini/API → 자동 검사 → 2차 교차검증)",
    "■ Cursor 수동 수정 시: 아래 [Cursor 수동 확인 권장] 블록을 우선 확인하세요.",
    "",
    ...headerLines,
    "",
    ...sections,
  ].join("\n");
  await fs.writeFile(targetPath, body, "utf8");
}

async function main() {
  const cli = parseArgs(process.argv);
  const dir = path.resolve(process.cwd(), cli.inputDir);

  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) {
      console.error(`폴더가 아닙니다: ${dir}`);
      process.exit(1);
    }
  } catch {
    console.error(`폴더를 찾을 수 없습니다: ${dir}`);
    process.exit(1);
  }

  const jobs = await collectJobs(dir, cli.recursive);
  if (jobs.length === 0) {
    console.error(
      `문항 이미지 없음 — 폴더 안의 .png/.jpg/.jpeg/.webp 또는 그 안의 .zip(내부 이미지): ${dir}${cli.recursive ? " (하위 포함)" : ""}`,
    );
    process.exit(1);
  }

  const docModeLabel = cli.draftsOnly
    ? "초안만 → 해설 작업중/ (DOCX 없음, MCP·Cursor 중재 후 write-final-docx)"
    : cli.splitDocx
      ? "문항별 분리"
      : "합본 1개(해설지 최종본)";
  const mathpixLabel = cli.mathpix
    ? ` Mathpix=ON(minConf=${cli.mathpixMinConfidence}${cli.mathpixStrict ? ",strict" : ""}${cli.mathpixNoCache ? ",no-cache" : ""})`
    : "";
  console.log(
    `발견 ${jobs.length}개 문항 이미지 — baseUrl=${cli.baseUrl} mode=${cli.generationMode} profile=${cli.solverProfile} 출력=${docModeLabel}${mathpixLabel}${cli.dryRun ? " (dry-run)" : ""}`,
  );

  if (cli.dryRun) {
    for (const j of jobs) {
      console.log(`  → ${j.relLabel}  (examName: ${j.examName})`);
    }
    if (!cli.splitDocx) {
      console.log(
        `  합본 표제(--exam-name 또는 추정): ${inferBundleExamName(jobs, dir, cli.examName)}`,
      );
    }
    console.log("종료(dry-run). dev 서버 없이 목록만 확인했습니다.");
    return;
  }

  const generateUrl = `${cli.baseUrl}/api/generate-explanation`;
  const mathpixUrl = cli.mathpix ? `${cli.baseUrl}/api/mathpix-text` : null;
  const outDir = path.join(process.cwd(), FINAL_EXPLANATION_DIR_NAME);

  if (cli.splitDocx && cli.draftsOnly) {
    const bundleExamName = inferBundleExamName(jobs, dir, cli.examName);
    const sub = safeDraftFolderName(bundleExamName);
    const workRoot = path.join(process.cwd(), DRAFT_WORK_DIR_NAME, sub);
    await fs.mkdir(workRoot, { recursive: true });
    const bodies: string[] = [];
    const progressSections: string[] = [];
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i]!;
      if (i > 0 && cli.delayMs > 0) await sleep(cli.delayMs);
      const result = await postGenerateExplanation(generateUrl, mathpixUrl, cli, job);
      if (!result.ok) {
        console.error(`해설 생성 실패: ${result.rel} — ${result.detail}`);
        process.exit(1);
      }
      bodies.push(result.body);
      if (result.progressReport) {
        progressSections.push(formatProgressReportKo(String(i + 1), result.progressReport));
      } else {
        progressSections.push(
          `──────── 문항 ${i + 1} ────────\n(progressReport 없음 — 서버를 최신 코드로 띄웠는지 확인)\n\n`,
        );
      }
      const num = String(i + 1).padStart(2, "0");
      await fs.writeFile(path.join(workRoot, `문항${num}_API초안.md`), result.body, "utf8");
    }
    await writeStageProgressFile(
      path.join(workRoot, "단계별_진행상황.txt"),
      [
        `시험지(추정): ${bundleExamName}`,
        `실행: ${new Date().toISOString()}`,
        `mode=${cli.generationMode} profile=${cli.solverProfile} split-docx`,
      ],
      progressSections,
    );
    const merged = bodies
      .map((b, i) => `[문항 ${i + 1}]\n${sliceFromFirstAnswerHeader(b)}`)
      .join("\n\n");
    await fs.writeFile(path.join(workRoot, "합본_편집용.md"), merged, "utf8");
    await fs.writeFile(path.join(workRoot, "빠른정답_요약.txt"), buildCompositeQuickAnswer(bodies), "utf8");
    await fs.writeFile(
      path.join(workRoot, "README.txt"),
      [
        "npm run batch:crops-to-docx -- --split-docx --drafts-only 로 생성한 문항별 초안입니다.",
        "",
        "MCP·Cursor로 각 문항 검토 후, 합본_편집용.md 를 정리하고 write-final-docx 하세요.",
      ].join("\n"),
      "utf8",
    );
    console.log(`초안만 저장( DOCX 없음 ): ${workRoot}`);
    return;
  }

  if (!cli.splitDocx) {
    const bodies: string[] = [];
    const progressSections: string[] = [];
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i]!;
      if (i > 0 && cli.delayMs > 0) await sleep(cli.delayMs);
      const result = await postGenerateExplanation(generateUrl, mathpixUrl, cli, job);
      if (!result.ok) {
        console.error(`해설 생성 실패(합본 중단, DOCX 미저장): ${result.rel} — ${result.detail}`);
        process.exit(1);
      }
      bodies.push(result.body);
      if (result.progressReport) {
        progressSections.push(formatProgressReportKo(String(i + 1), result.progressReport));
      } else {
        progressSections.push(
          `──────── 문항 ${i + 1} ────────\n(progressReport 없음 — 서버를 최신 코드로 띄웠는지 확인)\n\n`,
        );
      }
    }

    const merged = bodies
      .map((b, i) => `[문항 ${i + 1}]\n${sliceFromFirstAnswerHeader(b)}`)
      .join("\n\n");
    const quickAnswer = buildCompositeQuickAnswer(bodies);
    const bundleExamName = inferBundleExamName(jobs, dir, cli.examName);

    if (cli.draftsOnly) {
      const sub = safeDraftFolderName(bundleExamName);
      const workRoot = path.join(process.cwd(), DRAFT_WORK_DIR_NAME, sub);
      await fs.mkdir(workRoot, { recursive: true });
      for (let i = 0; i < bodies.length; i += 1) {
        const num = String(i + 1).padStart(2, "0");
        await fs.writeFile(path.join(workRoot, `문항${num}_API초안.md`), bodies[i]!, "utf8");
      }
      await fs.writeFile(path.join(workRoot, "합본_편집용.md"), merged, "utf8");
      await fs.writeFile(path.join(workRoot, "빠른정답_요약.txt"), quickAnswer, "utf8");
      await fs.writeFile(
        path.join(workRoot, "README.txt"),
        [
          "이 폴더는 npm run batch:crops-to-docx -- --drafts-only 로 만든 API 초안입니다.",
          "",
          "[중요] MCP 호출·Cursor 중재는 이 스크립트에 포함되지 않습니다. 아래를 진행하세요.",
          "",
          "1) 단계별_진행상황.txt 에서 1차·자동검사·2차 요약을 확인한 뒤, Cursor에서 수정 요청하세요.",
          "2) 문항##_API초안.md 또는 합본_편집용.md 를 열고 수식·표현을 손짜세요.",
          "3) 확정한 전체 본문을 합본_편집용.md 에 반영 ([문항 n] 헤더 유지).",
          "4) npm run write-final-docx -- --workdir \"./해설 작업중/<이폴더>\"   (또는 --latest)",
          "",
          "※ 초안은 /api/generate-explanation 과 동일 백엔드일 수 있습니다. 최종 품질 책임은 중재 후 단계에 있습니다.",
        ].join("\n"),
        "utf8",
      );
      await writeStageProgressFile(
        path.join(workRoot, "단계별_진행상황.txt"),
        [
          `시험지(추정): ${bundleExamName}`,
          `실행: ${new Date().toISOString()}`,
          `mode=${cli.generationMode} profile=${cli.solverProfile} 합본`,
        ],
        progressSections,
      );
      console.log(`초안만 저장( DOCX 없음 ): ${workRoot}`);
      console.log("완료: 단계별_진행상황.txt 확인 후 Cursor에서 중재 → npm run write-final-docx");
      return;
    }

    const { buildExamExplanationDocxBuffer } = await import("../src/lib/examExplanationDocx");
    await fs.mkdir(outDir, { recursive: true });

    try {
      const { buffer, docxFileName } = await buildExamExplanationDocxBuffer({
        examName: bundleExamName,
        explanationBody: merged,
        quickAnswer,
        assetBaseDir: dir,
      });
      const docxPath = path.join(outDir, docxFileName);
      await fs.writeFile(docxPath, buffer);
      console.log(`저장(합본): ${docxPath}`);
      const progressPath = path.join(
        outDir,
        `${safeDraftFolderName(bundleExamName)}_단계별_진행상황.txt`,
      );
      await writeStageProgressFile(
        progressPath,
        [
          `시험지(추정): ${bundleExamName}`,
          `실행: ${new Date().toISOString()}`,
          `mode=${cli.generationMode} profile=${cli.solverProfile} 합본+DOCX`,
          `DOCX: ${docxFileName}`,
        ],
        progressSections,
      );
      console.log(`단계별 진행 로그: ${progressPath}`);
    } catch (e) {
      console.error(`DOCX 실패: ${bundleExamName}`, e instanceof Error ? e.message : e);
      process.exit(1);
    }
    console.log(`완료: 합본 1개 → ${outDir}`);
    return;
  }

  const { buildExamExplanationDocxBuffer } = await import("../src/lib/examExplanationDocx");
  await fs.mkdir(outDir, { recursive: true });

  let ok = 0;
  let fail = 0;
  const splitProgressSections: string[] = [];

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i]!;
    const examName = job.examName;

    if (i > 0 && cli.delayMs > 0) await sleep(cli.delayMs);

    const gen = await postGenerateExplanation(generateUrl, mathpixUrl, cli, job);
    if (!gen.ok) {
      console.error(`해설 생성 실패: ${gen.rel} — ${gen.detail}`);
      fail += 1;
      continue;
    }

    if (gen.progressReport) {
      splitProgressSections.push(formatProgressReportKo(`${examName} (#${i + 1})`, gen.progressReport));
    } else {
      splitProgressSections.push(
        `──────── ${examName} (#${i + 1}) ────────\n(progressReport 없음)\n\n`,
      );
    }

    const explanationBody = gen.body;
    const quickAnswer = extractQuickAnswerFromBody(explanationBody);

    try {
      const { buffer, docxFileName } = await buildExamExplanationDocxBuffer({
        examName,
        explanationBody,
        quickAnswer,
        assetBaseDir: dir,
      });
      const docxPath = path.join(outDir, docxFileName);
      await fs.writeFile(docxPath, buffer);
      console.log(`저장: ${docxPath}`);
      ok += 1;
    } catch (e) {
      console.error(`DOCX 실패: ${examName}`, e instanceof Error ? e.message : e);
      fail += 1;
    }
  }

  const bundleTag = inferBundleExamName(jobs, dir, cli.examName);
  const splitProgressPath = path.join(
    outDir,
    `${safeDraftFolderName(bundleTag)}_단계별_진행상황_split.txt`,
  );
  await writeStageProgressFile(
    splitProgressPath,
    [
      `묶음(추정): ${bundleTag}`,
      `실행: ${new Date().toISOString()}`,
      `mode=${cli.generationMode} profile=${cli.solverProfile} 문항별 DOCX`,
      `성공 ${ok}건 / 실패 ${fail}건`,
    ],
    splitProgressSections,
  );
  console.log(`단계별 진행 로그(split): ${splitProgressPath}`);

  console.log(`완료: 성공 ${ok}, 실패 ${fail} → ${outDir}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
