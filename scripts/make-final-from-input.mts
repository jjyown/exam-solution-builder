import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const DRAFT_WORK_ROOT = "해설 작업중";
const MERGED_NAME = "합본_편집용.md";
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

type Cli = {
  inputDir: string;
  examName: string;
  baseUrl: string;
  solverProfile: "easy" | "balanced" | "killer";
  generationMode: "test" | "final";
  delayMs: number;
  mathpix: boolean;
  mathpixMinConfidence: number | null;
  mathpixStrict: boolean;
  mathpixNoCache: boolean;
  strictGate: boolean;
  fastMode: boolean;
  disableMathpix: boolean;
};

type DraftItem = {
  questionNo: number;
  answer: string;
  explanation: string;
  problemImageRel?: string;
  problemDiagramRels?: string[];
};

type ContentIssue = {
  questionNo: number;
  severity: "fatal" | "warn";
  code: string;
  message: string;
};

type QuestionImage = {
  sourceLabel: string;
  ext: string;
  buffer: Buffer;
};

type QuestionVisuals = {
  byQuestion: Map<number, { main?: QuestionImage; diagrams: QuestionImage[] }>;
  fallbackMain: QuestionImage[];
};

type GateHooks = {
  runContentGate: (drafts: Array<{ questionNo: number; answer: string; explanation: string }>) => ContentIssue[];
  runCompletenessGate: (
    drafts: Array<{ questionNo: number; answer: string; explanation: string }>,
    questionVisuals: QuestionVisuals,
  ) => ContentIssue[];
  decideExplanationImagePolicy: (
    drafts: Array<{ questionNo: number; answer: string; explanation: string }>,
    questionVisuals: QuestionVisuals,
  ) => Array<{ needExtraExplanationImage: boolean }>;
};

type PythonMathGateResult = {
  ok: boolean;
  sympyAvailable: boolean;
  issues: ContentIssue[];
  error?: string;
};

function normalizeMathDelimiters(input: string): string {
  let out = input;
  // \[ ... \] -> $$ ... $$ (multiline)
  out = out.replace(/\\\[((?:.|\r|\n)*?)\\\]/g, (_m, inner: string) => {
    const cleaned = inner.trim().replace(/\.\s*$/g, "");
    return `$$${cleaned}$$`;
  });
  // \( ... \) -> $ ... $
  out = out.replace(/\\\((.+?)\\\)/g, (_m, inner: string) => `$${String(inner).trim()}$`);
  // 수식만 있는 줄 뒤의 마침표는 게이트 오탐을 줄이기 위해 제거
  out = out.replace(/^\s*(\$\$[^$]+?\$\$|\$[^$]+?\$)\.\s*$/gm, "$1");
  // 닫는 수식 구분자 직전 마침표 제거 (예: ... 1.$$ / ... x.$)
  out = out.replace(/\.(\s*\$\$)/g, "$1");
  out = out.replace(/\.(\s*\$)(?=\s|$)/g, "$1");
  // 인라인 수식 뒤 문장 끝 마침표 제거 (예: "... $\frac12$." -> "... $\frac12$")
  out = out.replace(/(\$[^$\n]+\$)\s*\.(?=\s|$)/g, "$1");
  return out;
}

function compactLongMathEqualityLine(line: string): string {
  const trimmed = line.trim();
  const blockMath = trimmed.match(/^\$\$([\s\S]+)\$\$$/);
  if (!blockMath?.[1]) return line;
  const inner = blockMath[1].trim();
  const eqCount = (inner.match(/=/g) ?? []).length;
  if (inner.length < 150 || eqCount < 6) return line;
  const parts = inner.split("=").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 7) return line;
  const head = parts.slice(0, 2).join(" = ");
  const tail = parts.slice(-2).join(" = ");
  return `$$${head} = \\cdots = ${tail}$$`;
}

function pruneVerboseExplanation(explanation: string): string {
  const lines = explanation
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x, idx, arr) => !(x === "" && arr[idx - 1] === ""));

  const narrationOnly = /^(먼저|정리하면|따라서|이제|각 경우에 대해|문제에서 주어진 범위는|다른 방법으로|마찬가지로)[,:\s]*$/;
  const reduced = lines
    .filter((line) => !narrationOnly.test(line))
    .map((line) => compactLongMathEqualityLine(line));

  return reduced.join("\n").trim();
}

function parseArgs(argv: string[]): Cli {
  let inputDir = "./크롭된 시험지";
  let examName = "";
  let baseUrl = "http://localhost:3000";
  let solverProfile: Cli["solverProfile"] = "balanced";
  let generationMode: Cli["generationMode"] = "final";
  let delayMs = 800;
  let mathpix = true;
  let mathpixMinConfidence: number | null = null;
  let mathpixStrict = false;
  let mathpixNoCache = false;
  let strictGate = true;
  let fastMode = false;
  let disableMathpix = false;

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input" && argv[i + 1]) {
      inputDir = argv[i + 1];
      i += 1;
    } else if (a === "--exam-name" && argv[i + 1]) {
      examName = argv[i + 1];
      i += 1;
    } else if (a === "--base-url" && argv[i + 1]) {
      baseUrl = argv[i + 1];
      i += 1;
    } else if (a === "--solver-profile" && argv[i + 1]) {
      const v = argv[i + 1].toLowerCase();
      if (v === "easy" || v === "balanced" || v === "killer") solverProfile = v;
      i += 1;
    } else if (a === "--generation-mode" && argv[i + 1]) {
      const v = argv[i + 1].toLowerCase();
      if (v === "test" || v === "final") generationMode = v;
      i += 1;
    } else if (a === "--delay-ms" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      delayMs = Number.isFinite(n) && n >= 0 ? n : 800;
      i += 1;
    } else if (a === "--mathpix") {
      mathpix = true;
    } else if (a === "--mathpix-min-confidence" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      mathpixMinConfidence = Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
      i += 1;
    } else if (a === "--mathpix-strict") {
      mathpixStrict = true;
    } else if (a === "--mathpix-no-cache") {
      mathpixNoCache = true;
    } else if (a === "--no-mathpix") {
      disableMathpix = true;
      mathpix = false;
    } else if (a === "--strict-gate") {
      strictGate = true;
    } else if (a === "--fast") {
      fastMode = true;
      strictGate = false;
    }
  }

  return {
    inputDir,
    examName,
    baseUrl,
    solverProfile,
    generationMode,
    delayMs,
    mathpix,
    mathpixMinConfidence,
    mathpixStrict,
    mathpixNoCache,
    strictGate,
    fastMode,
    disableMathpix,
  };
}

function extractDraftOrder(fileName: string): number | null {
  const m = fileName.match(/^문항(\d+)_API초안\.md$/i);
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function parseDraftBody(raw: string): { answer: string; explanation: string } {
  const text = raw.replace(/^\uFEFF/, "").trim();
  const lines = text.split(/\r?\n/);

  let answer = "-";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const m = line.match(/^\[정답\]\s*(.*)$/i);
    if (!m) continue;
    const inline = (m[1] ?? "").trim();
    if (inline) {
      answer = inline;
      break;
    }
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = (lines[j] ?? "").trim();
      if (!candidate) continue;
      if (/^\[해설\]/i.test(candidate)) break;
      answer = candidate;
      break;
    }
    break;
  }

  let explanation = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const m = line.match(/^\[해설\]\s*(.*)$/i);
    if (!m) continue;
    const first = (m[1] ?? "").trim();
    const tail = lines.slice(i + 1).join("\n").trim();
    explanation = [first, tail].filter(Boolean).join("\n");
    break;
  }
  if (!explanation) explanation = text;
  explanation = normalizeMathDelimiters(explanation);
  explanation = pruneVerboseExplanation(explanation);

  return { answer, explanation };
}

async function cleanupGeneratedQuestionAssets(workdirAbs: string): Promise<void> {
  const entries = await fs.readdir(workdirAbs, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/^문항\d+_(문제원본|관련그림)\d*/.test(e.name)) continue;
    const full = path.join(workdirAbs, e.name);
    await fs.unlink(full).catch(() => {});
  }
}


function runPythonMathGate(drafts: DraftItem[]): PythonMathGateResult {
  const scriptPath = path.join(process.cwd(), "tools", "math_expression_gate.py");
  const input = JSON.stringify({
    drafts: drafts.map((d) => ({
      questionNo: d.questionNo,
      explanation: d.explanation,
    })),
  });

  const py = spawnSync("python", [scriptPath], {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });

  if (py.error) {
    return {
      ok: false,
      sympyAvailable: false,
      issues: [],
      error: py.error.message,
    };
  }
  if (py.status !== 0) {
    return {
      ok: false,
      sympyAvailable: false,
      issues: [],
      error: (py.stderr || py.stdout || "").trim() || `python_exit_${py.status}`,
    };
  }

  try {
    const parsed = JSON.parse((py.stdout || "").trim()) as {
      ok?: boolean;
      sympyAvailable?: boolean;
      issues?: ContentIssue[];
      error?: string;
    };
    return {
      ok: Boolean(parsed.ok),
      sympyAvailable: Boolean(parsed.sympyAvailable),
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      error: parsed.error,
    };
  } catch (e) {
    return {
      ok: false,
      sympyAvailable: false,
      issues: [],
      error: `python_output_parse_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function rewriteMergedForExport(
  workdirAbs: string,
  enableContentGate: boolean,
  questionVisuals: QuestionVisuals,
  hooks: GateHooks,
): Promise<void> {
  const entries = await fs.readdir(workdirAbs, { withFileTypes: true });
  const drafts: DraftItem[] = [];

  for (const e of entries) {
    if (!e.isFile()) continue;
    const n = extractDraftOrder(e.name);
    if (n == null) continue;
    const full = path.join(workdirAbs, e.name);
    const raw = await fs.readFile(full, "utf8");
    const parsed = parseDraftBody(raw);
    drafts.push({
      questionNo: n,
      answer: parsed.answer,
      explanation: parsed.explanation,
    });
  }

  if (drafts.length === 0) return;
  drafts.sort((a, b) => a.questionNo - b.questionNo);
  if (questionVisuals.byQuestion.size > 0) {
    const allowed = new Set(questionVisuals.byQuestion.keys());
    const filtered = drafts.filter((d) => allowed.has(d.questionNo));
    if (filtered.length > 0 && filtered.length !== drafts.length) {
      const removed = drafts.filter((d) => !allowed.has(d.questionNo)).map((d) => d.questionNo);
      console.warn(`[입력 매핑] manifest에 없는 문항 초안 제외: ${removed.join(", ")}`);
      drafts.length = 0;
      drafts.push(...filtered);
    }
  }
  await cleanupGeneratedQuestionAssets(workdirAbs);

  if (enableContentGate) {
    const issues = hooks.runContentGate(drafts);
    issues.push(...hooks.runCompletenessGate(drafts, questionVisuals));
    const pyGate = runPythonMathGate(drafts);
    if (pyGate.ok && pyGate.sympyAvailable && pyGate.issues.length > 0) {
      issues.push(...pyGate.issues);
    } else if (pyGate.ok && !pyGate.sympyAvailable) {
      console.warn("[content gate] Python/sympy 미설치로 고급 검산 게이트를 건너뜁니다.");
    } else if (!pyGate.ok) {
      console.warn(
        `[content gate] Python 검산 게이트 실행 실패(기존 규칙 게이트는 계속 진행): ${pyGate.error ?? "unknown"}`,
      );
    }

    const fatals = issues.filter((x) => x.severity === "fatal");
    if (issues.length > 0) {
      console.error("══ content gate 결과 ══");
      for (const it of issues) {
        const badge = it.severity === "fatal" ? "오류" : "경고";
        console.error(`- [${badge}] 문항 ${it.questionNo} ${it.code}: ${it.message}`);
      }
    }
    if (fatals.length > 0) {
      console.error("content gate 치명 오류로 중단합니다.");
      process.exit(42);
    }
  }
  const imagePolicy = hooks.decideExplanationImagePolicy(drafts, questionVisuals);
  const policyNeeded = imagePolicy.filter((x) => x.needExtraExplanationImage).length;
  console.log(`[이미지 정책] 해설 보조 이미지 권장 문항: ${policyNeeded}/${imagePolicy.length}`);

  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i]!;
    const fromManifest = questionVisuals.byQuestion.get(d.questionNo);
    const img = fromManifest?.main ?? questionVisuals.fallbackMain[i];
    const diagrams = fromManifest?.diagrams ?? [];
    if (!img && diagrams.length === 0) continue;
    const qNo = String(d.questionNo).padStart(2, "0");
    if (img) {
      const ext = img.ext.match(IMAGE_EXT)?.[0] ?? ".png";
      const fileName = `문항${qNo}_문제원본${ext}`;
      const abs = path.join(workdirAbs, fileName);
      await fs.writeFile(abs, img.buffer);
      d.problemImageRel = `./${fileName}`;
    }
    if (diagrams.length > 0) {
      d.problemDiagramRels = [];
      for (let k = 0; k < diagrams.length; k += 1) {
        const dg = diagrams[k]!;
        const ext = dg.ext.match(IMAGE_EXT)?.[0] ?? ".png";
        const fileName = `문항${qNo}_관련그림${String(k + 1).padStart(2, "0")}${ext}`;
        const abs = path.join(workdirAbs, fileName);
        await fs.writeFile(abs, dg.buffer);
        d.problemDiagramRels.push(`./${fileName}`);
      }
    }
  }

  const merged = drafts
    .map(
      (d) => {
        const problemLines = [
          `[문항 ${d.questionNo}]`,
          `[문제]`,
          d.problemImageRel ? `![문제 원본](${d.problemImageRel})` : `문제 원본 이미지를 참고하세요.`,
          ...(d.problemDiagramRels ?? []).map((rel, idx) => `![관련 그림 ${idx + 1}](${rel})`),
          ``,
          `[빠른 정답] ${d.answer}`,
          ``,
          `[해설]`,
          d.explanation.trim(),
        ];
        return problemLines.join("\n");
      },
    )
    .join("\n\n");

  await fs.writeFile(path.join(workdirAbs, MERGED_NAME), `${merged}\n`, "utf8");
  const quickSummary = drafts.map((d) => `${d.questionNo}:${d.answer}`).join(" ");
  await fs.writeFile(path.join(workdirAbs, "빠른정답_요약.txt"), `${quickSummary}\n`, "utf8");
}

async function findLatestWorkdir(cwd: string, startedAtMs: number): Promise<string | null> {
  const root = path.join(cwd, DRAFT_WORK_ROOT);
  let topLevel;
  try {
    topLevel = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates: { dir: string; mtimeMs: number }[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name === MERGED_NAME) {
        const st = await fs.stat(full);
        candidates.push({ dir: path.dirname(full), mtimeMs: st.mtimeMs });
      }
    }
  }

  for (const e of topLevel) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    await walk(path.join(root, e.name));
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const fresh = candidates.find((x) => x.mtimeMs >= startedAtMs - 2000);
  return (fresh ?? candidates[0])?.dir ?? null;
}

function runOrExit(command: string, args: string[], cwd: string, label: string) {
  console.log(`\n[단계] ${label}`);
  const r = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (r.error) {
    console.error(`[실패] ${label}: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

async function main() {
  const cli = parseArgs(process.argv);
  const cwd = process.cwd();
  const startedAtMs = Date.now();
  const inputAbs = path.isAbsolute(cli.inputDir) ? cli.inputDir : path.join(cwd, cli.inputDir);
  console.log(
    `[설정] input=${cli.inputDir} mode=${cli.generationMode} profile=${cli.solverProfile} gate=${cli.strictGate ? "strict" : "fast"} mathpix=${cli.mathpix ? "on" : "off"}`,
  );
  try {
    const st = await fs.stat(inputAbs);
    if (!st.isDirectory()) {
      console.error(`[입력 오류] 폴더가 아닙니다: ${inputAbs}`);
      process.exit(1);
    }
  } catch {
    console.error(`[입력 오류] 폴더를 찾을 수 없습니다: ${inputAbs}`);
    process.exit(1);
  }

  const batchArgs = [
    "tsx",
    "scripts/batch-crops-to-docx.mts",
    "--input",
    cli.inputDir,
    "--drafts-only",
    "--base-url",
    cli.baseUrl,
    "--generation-mode",
    cli.generationMode,
    "--solver-profile",
    cli.solverProfile,
    "--delay-ms",
    String(cli.delayMs),
  ];
  if (cli.examName.trim()) batchArgs.push("--exam-name", cli.examName.trim());
  if (cli.mathpix) batchArgs.push("--mathpix");
  if (cli.mathpixMinConfidence != null) {
    batchArgs.push("--mathpix-min-confidence", String(cli.mathpixMinConfidence));
  }
  if (cli.mathpixStrict) batchArgs.push("--mathpix-strict");
  if (cli.mathpixNoCache) batchArgs.push("--mathpix-no-cache");

  const tsxCli = path.join(cwd, "node_modules", "tsx", "dist", "cli.mjs");

  runOrExit(
    process.execPath,
    [tsxCli, ...batchArgs.slice(1)],
    cwd,
    "초안 생성 (batch-crops-to-docx --drafts-only)",
  );

  const latestWorkdir = await findLatestWorkdir(cwd, startedAtMs);
  if (!latestWorkdir) {
    console.error(`초안 작업 폴더를 찾지 못했습니다. (${DRAFT_WORK_ROOT} 이하 ${MERGED_NAME})`);
    process.exit(1);
  }
  console.log(`[선택] workdir=${path.relative(cwd, latestWorkdir) || latestWorkdir}`);
  const questionVisualsMod = await import("../src/lib/recognition/questionVisuals.ts");
  const questionVisuals = await questionVisualsMod.collectQuestionVisuals(inputAbs);
  if (questionVisuals.fallbackMain.length > 0 || questionVisuals.byQuestion.size > 0) {
    const fallbackCount = questionVisuals.fallbackMain.length;
    const manifestCount = questionVisuals.byQuestion.size;
    console.log(
      `[입력 매핑] 문제 이미지 연결: manifest 문항 ${manifestCount}건, fallback 이미지 ${fallbackCount}건`,
    );
  } else {
    console.warn("[입력 매핑] 문제 이미지를 찾지 못해 [문제]에는 텍스트 안내만 들어갑니다.");
  }

  const contentGateMod = await import("../src/lib/quality/contentGate.ts");
  const completenessGateMod = await import("../src/lib/quality/completenessGate.ts");
  const explanationImagePolicyMod = await import("../src/lib/assembly/explanationImagePolicy.ts");
  const hooks: GateHooks = {
    runContentGate: contentGateMod.runContentGate,
    runCompletenessGate: completenessGateMod.runCompletenessGate,
    decideExplanationImagePolicy: explanationImagePolicyMod.decideExplanationImagePolicy,
  };
  await rewriteMergedForExport(latestWorkdir, cli.strictGate, questionVisuals, hooks);

  const relWorkdir = path.relative(cwd, latestWorkdir) || latestWorkdir;
  const finalArgs = [tsxCli, "write-final-docx.mts", "--workdir", relWorkdir];
  if (!cli.strictGate) {
    finalArgs.push("--skip-structure-check");
  }
  if (cli.fastMode) {
    console.warn("[주의] fast 모드: 구조 검사를 생략하고 즉시 산출합니다.");
  }
  runOrExit(process.execPath, finalArgs, cwd, `최종 DOCX 생성 (workdir: ${relWorkdir})`);

  console.log(`\n완료: 입력 -> 초안 -> 최종 DOCX까지 자동 실행되었습니다.`);
}

void main();

