import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";

const DRAFT_WORK_ROOT = "해설 작업중";
const MERGED_NAME = "합본_편집용.md";
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const MAX_ZIP_NEST = 5;

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
};

type ContentIssue = {
  questionNo: number;
  severity: "fatal" | "warn";
  code: string;
  message: string;
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
  return out;
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

  return { answer, explanation };
}

function normalizeChoiceToken(text: string): string {
  const t = text.trim();
  const circled = t.match(/[①②③④⑤]/)?.[0];
  if (circled) return circled;
  const num = t.match(/\b([1-5])\b/)?.[1];
  if (num) return ["", "①", "②", "③", "④", "⑤"][Number(num)] ?? t;
  return t;
}

function evaluateNumericExpression(raw: string): number | null {
  const expr = raw
    .replace(/[×x]/g, "*")
    .replace(/÷/g, "/")
    .replace(/\s+/g, "")
    .trim();
  if (!expr) return null;
  if (!/^[0-9+\-*/().]+$/.test(expr)) return null;
  try {
    const v = Function(`"use strict"; return (${expr});`)();
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

type QuestionImage = {
  sourceLabel: string;
  ext: string;
  buffer: Buffer;
};

async function extractImagesFromZipBuffer(
  zipBuf: Buffer,
  sourceLabel: string,
  depth: number,
): Promise<QuestionImage[]> {
  if (depth > MAX_ZIP_NEST) return [];
  const zip = await JSZip.loadAsync(zipBuf);
  const allNames = Object.keys(zip.files)
    .filter((n) => !zip.files[n]?.dir)
    .sort((a, b) => a.localeCompare(b, "ko"));

  let manifestMainFiles: Set<string> | null = null;
  const manifestEntry = zip.file("manifest.json");
  if (manifestEntry) {
    try {
      const raw = await manifestEntry.async("string");
      const obj = JSON.parse(raw) as { items?: Array<{ file?: string }> };
      const files = (obj.items ?? [])
        .map((x) => String(x.file ?? "").trim())
        .filter(Boolean);
      if (files.length > 0) manifestMainFiles = new Set(files);
    } catch {
      // ignore manifest parse errors
    }
  }

  const out: QuestionImage[] = [];
  for (const name of allNames) {
    const base = path.basename(name);
    if (IMAGE_EXT.test(base)) {
      if (manifestMainFiles && !manifestMainFiles.has(base)) continue;
      const f = zip.file(name);
      if (!f) continue;
      const buffer = Buffer.from(await f.async("uint8array"));
      out.push({
        sourceLabel: `${sourceLabel}::${name}`,
        ext: path.extname(base).toLowerCase() || ".png",
        buffer,
      });
      continue;
    }
    if (/\.zip$/i.test(base)) {
      const f = zip.file(name);
      if (!f) continue;
      const nestedBuf = Buffer.from(await f.async("uint8array"));
      const nested = await extractImagesFromZipBuffer(
        nestedBuf,
        `${sourceLabel}>${name}`,
        depth + 1,
      );
      out.push(...nested);
    }
  }
  return out;
}

async function collectQuestionImages(inputAbs: string): Promise<QuestionImage[]> {
  const out: QuestionImage[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (IMAGE_EXT.test(e.name)) {
        const buffer = await fs.readFile(full);
        out.push({
          sourceLabel: path.relative(process.cwd(), full),
          ext: path.extname(e.name).toLowerCase() || ".png",
          buffer,
        });
        continue;
      }
      if (/\.zip$/i.test(e.name)) {
        try {
          const buf = await fs.readFile(full);
          const nested = await extractImagesFromZipBuffer(buf, path.relative(process.cwd(), full), 0);
          out.push(...nested);
        } catch {
          // ignore broken zips
        }
      }
    }
  }
  await walk(inputAbs);
  return out;
}

function checkArithmeticEqualities(questionNo: number, explanation: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const lines = explanation.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.replace(/\$/g, "").trim();
    if (!cleaned.includes("=")) continue;
    if ((cleaned.match(/=/g) ?? []).length !== 1) continue;
    if (/[A-Za-z가-힣\\_^]/.test(cleaned)) continue;
    const [lhsRaw, rhsRaw] = cleaned.split("=");
    if (!lhsRaw || !rhsRaw) continue;
    const lhs = evaluateNumericExpression(lhsRaw);
    const rhs = evaluateNumericExpression(rhsRaw);
    if (lhs == null || rhs == null) continue;
    if (Math.abs(lhs - rhs) > 1e-9) {
      issues.push({
        questionNo,
        severity: "fatal",
        code: "E_ARITH_MISMATCH",
        message: `산술 등식 불일치 감지: ${cleaned} (계산값 ${lhs} != ${rhs})`,
      });
    }
  }
  return issues;
}

function checkChainEqualities(questionNo: number, explanation: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const lines = explanation.split(/\r?\n/);
  for (const line of lines) {
    const cleaned = line.replace(/\$/g, "").trim();
    const eqCount = (cleaned.match(/=/g) ?? []).length;
    if (eqCount < 2) continue;
    if (/[A-Za-z가-힣\\_^]/.test(cleaned)) continue;
    const parts = cleaned.split("=").map((x) => x.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    const values = parts.map((p) => evaluateNumericExpression(p));
    if (values.some((v) => v == null)) continue;
    for (let i = 1; i < values.length; i += 1) {
      const prev = values[i - 1]!;
      const cur = values[i]!;
      if (Math.abs(prev - cur) > 1e-9) {
        issues.push({
          questionNo,
          severity: "fatal",
          code: "E_CHAIN_EQ_MISMATCH",
          message: `체인 등식 불일치 감지: ${cleaned} (항 ${i}와 ${i + 1} 불일치)`,
        });
        break;
      }
    }
  }
  return issues;
}

function checkInequalityChains(questionNo: number, explanation: string): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const lines = explanation.split(/\r?\n/);
  const opRe = /(<=|>=|<|>)/g;
  for (const line of lines) {
    const cleaned = line.replace(/\$/g, "").trim();
    const ops = cleaned.match(opRe) ?? [];
    if (ops.length < 2) continue;
    if (/[A-Za-z가-힣\\_^]/.test(cleaned)) continue;

    const parts = cleaned.split(opRe).map((x) => x.trim()).filter(Boolean);
    // parts = [expr0, op0, expr1, op1, expr2, ...]
    if (parts.length < 5 || parts.length % 2 === 0) continue;

    let failed = false;
    for (let i = 0; i + 2 < parts.length; i += 2) {
      const lhsExpr = parts[i]!;
      const op = parts[i + 1]!;
      const rhsExpr = parts[i + 2]!;
      const lhs = evaluateNumericExpression(lhsExpr);
      const rhs = evaluateNumericExpression(rhsExpr);
      if (lhs == null || rhs == null) {
        failed = false;
        break;
      }
      const ok =
        op === "<" ? lhs < rhs
        : op === "<=" ? lhs <= rhs
        : op === ">" ? lhs > rhs
        : op === ">=" ? lhs >= rhs
        : true;
      if (!ok) {
        issues.push({
          questionNo,
          severity: "fatal",
          code: "E_INEQ_CHAIN_MISMATCH",
          message: `부등식 체인 불일치 감지: ${cleaned} (비교 ${lhs} ${op} ${rhs} 실패)`,
        });
        failed = true;
        break;
      }
    }
    if (failed) continue;
  }
  return issues;
}

function runContentGate(drafts: DraftItem[]): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const banned = /(풀 수 없|알 수 없|판독 불가|모르겠|추정됩니다|화질)/i;
  const conclusionRe = /정답은?\s*([①②③④⑤1-5])/g;
  for (const d of drafts) {
    const exp = d.explanation.trim();
    if (exp.length < 40) {
      issues.push({
        questionNo: d.questionNo,
        severity: "fatal",
        code: "E_CONTENT_SHORT",
        message: "해설 길이가 너무 짧아 내용 검증이 불충분합니다.",
      });
    }
    if (banned.test(exp)) {
      issues.push({
        questionNo: d.questionNo,
        severity: "fatal",
        code: "E_CONTENT_BANNED_PHRASE",
        message: "포기/회피 문구가 감지되었습니다.",
      });
    }
    const answerNorm = normalizeChoiceToken(d.answer);
    let m: RegExpExecArray | null = null;
    const conclusionTokens: string[] = [];
    while ((m = conclusionRe.exec(exp)) !== null) {
      if (m[1]) conclusionTokens.push(normalizeChoiceToken(m[1]));
    }
    if (conclusionTokens.length > 0) {
      const last = conclusionTokens[conclusionTokens.length - 1]!;
      if (answerNorm && last && answerNorm !== last) {
        issues.push({
          questionNo: d.questionNo,
          severity: "fatal",
          code: "E_ANSWER_MISMATCH",
          message: `해설 결론(${last})과 빠른 정답(${answerNorm})이 불일치합니다.`,
        });
      }
    }
    issues.push(...checkArithmeticEqualities(d.questionNo, exp));
    issues.push(...checkChainEqualities(d.questionNo, exp));
    issues.push(...checkInequalityChains(d.questionNo, exp));
  }
  return issues;
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
  questionImages: QuestionImage[],
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

  if (enableContentGate) {
    const issues = runContentGate(drafts);
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

  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i]!;
    const img = questionImages[i];
    if (!img) continue;
    const qNo = String(d.questionNo).padStart(2, "0");
    const ext = img.ext.match(IMAGE_EXT)?.[0] ?? ".png";
    const fileName = `문항${qNo}_문제원본${ext}`;
    const abs = path.join(workdirAbs, fileName);
    await fs.writeFile(abs, img.buffer);
    d.problemImageRel = `./${fileName}`;
  }

  const merged = drafts
    .map(
      (d) =>
        [
          `[문항 ${d.questionNo}]`,
          `[문제]`,
          d.problemImageRel ? `![문제 원본](${d.problemImageRel})` : `문제 원본 이미지를 참고하세요.`,
          ``,
          `[빠른 정답] ${d.answer}`,
          ``,
          `[해설]`,
          d.explanation.trim(),
        ].join("\n"),
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
  const questionImages = await collectQuestionImages(inputAbs);
  if (questionImages.length > 0) {
    console.log(`[입력 매핑] 문제 이미지 ${questionImages.length}개를 문항 순서로 연결합니다.`);
  } else {
    console.warn("[입력 매핑] 문제 이미지를 찾지 못해 [문제]에는 텍스트 안내만 들어갑니다.");
  }

  await rewriteMergedForExport(latestWorkdir, cli.strictGate, questionImages);

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

