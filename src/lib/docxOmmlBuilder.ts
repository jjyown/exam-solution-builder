import {
  Math,
  MathComponent,
  MathCurlyBrackets,
  MathFraction,
  MathFunction,
  MathIntegral,
  MathPreSubSuperScript,
  MathRadical,
  MathRoundBrackets,
  MathRun,
  MathSubScript,
  MathSum,
  MathSuperScript,
  ParagraphChild,
  TextRun,
} from "docx";
import { EXAM_DOCX_BODY_SIZE_HALF_PT, EXAM_DOCX_FONT } from "./examDocxTheme";
import { explanationLatexToPlain } from "./latexToPlainText";
import { normalizeLatexSourceText } from "./latexSourceNormalize";

/** `\left`/`\right` 등은 단순 괄호로만 취급 */
function preprocessInlineMath(inner: string): string {
  return inner
    .replace(/\\dfrac\b|\\tfrac\b/g, "\\frac")
    .replace(/\\left\s*\\\{/g, "{")
    .replace(/\\right\s*\\\}/g, "}")
    .replace(/\\left\s*\(/g, "(")
    .replace(/\\right\s*\)/g, ")")
    .replace(/\\left\s*\[/g, "[")
    .replace(/\\right\s*\]/g, "]")
    .replace(/\\left\s*\|/g, "|")
    .replace(/\\right\s*\|/g, "|")
    .replace(/\\left\s*\./g, "")
    .replace(/\\right\s*\./g, "")
    .replace(/\\left|\\right/g, "");
}

function takeBalancedBrace(s: string): [string, string] | null {
  if (!s.startsWith("{")) return null;
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return [s.slice(1, i), s.slice(i + 1)];
    }
  }
  return null;
}

function takeParenContent(s: string): [string, string] | null {
  if (!s.startsWith("(")) return null;
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return [s.slice(1, i), s.slice(i + 1)];
    }
  }
  return null;
}

/** `_` 또는 `^` 직후 `{…}` / 한 글자 스크립트 본문만 추출한다 */
function extractScriptAfterMarker(
  s: string,
  marker: "^" | "_",
): [MathComponent[], string] | null {
  if (!s.startsWith(marker)) return null;
  const r = s.slice(1).trimStart();
  if (r.startsWith("{")) {
    const tb = takeBalancedBrace(r);
    if (!tb) return null;
    return [parseConcat(tb[0]), tb[1]];
  }
  if (r.length) {
    return [[new MathRun(r[0]!)], r.slice(1)];
  }
  return null;
}

/**
 * `\\sum` / `\\int` 뒤에 오는 (선택) 밑·윗첨자를 읽고, 남은 문자열을 본문(적분·급수 식)으로 쓴다.
 */
function parseNaryOperator(
  kind: "sum" | "int",
  afterCmd: string,
): [MathComponent, string] {
  let rest = afterCmd.trimStart();
  let sub: MathComponent[] | undefined;
  let sup: MathComponent[] | undefined;
  for (let pass = 0; pass < 2; pass += 1) {
    rest = rest.trimStart();
    if (!sub) {
      const e = extractScriptAfterMarker(rest, "_");
      if (e) {
        [sub, rest] = e;
        rest = rest.trimStart();
      }
    }
    if (!sup) {
      const e2 = extractScriptAfterMarker(rest, "^");
      if (e2) {
        [sup, rest] = e2;
        rest = rest.trimStart();
      }
    }
  }
  const children = parseConcat(rest.trimStart());
  if (kind === "sum") {
    return [new MathSum({ children, subScript: sub, superScript: sup }), ""];
  }
  return [new MathIntegral({ children, subScript: sub, superScript: sup }), ""];
}

function parseBinom(afterCmd: string): [MathComponent, string] | null {
  const r = afterCmd.trimStart();
  const a = takeBalancedBrace(r);
  if (!a) return null;
  const b = takeBalancedBrace(a[1].trimStart());
  if (!b) return null;
  const top = [new MathRoundBrackets({ children: parseConcat(a[0].trim()) })];
  const bot = [new MathRoundBrackets({ children: parseConcat(b[0].trim()) })];
  return [
    new MathFraction({
      numerator: top,
      denominator: bot,
    }),
    b[1],
  ];
}

/** `\\log_2 x`, `\\ln x`, `\\lg_{10} x` — 밑·윗첨자는 함수 이름에만 붙이고 인자는 m:func 본문에 둔다. */
function buildLogLikeFunctionName(
  cmd: string,
  sub?: MathComponent[],
  sup?: MathComponent[],
): MathComponent[] {
  const baseName = new MathRun(cmd === "Pr" ? "Pr" : cmd);
  if (sub?.length && sup?.length) {
    return [
      new MathPreSubSuperScript({
        children: [baseName],
        subScript: sub,
        superScript: sup,
      }),
    ];
  }
  if (sub?.length) {
    return [new MathSubScript({ children: [baseName], subScript: sub })];
  }
  if (sup?.length) {
    return [new MathSuperScript({ children: [baseName], superScript: sup })];
  }
  return [baseName];
}

function parseLogLike(cmd: "log" | "ln" | "lg", afterCmd: string): [MathComponent, string] {
  let rest = afterCmd.trimStart();
  let sub: MathComponent[] | undefined;
  let sup: MathComponent[] | undefined;
  for (let pass = 0; pass < 2; pass += 1) {
    rest = rest.trimStart();
    if (!sub) {
      const e = extractScriptAfterMarker(rest, "_");
      if (e) {
        [sub, rest] = e;
      }
    }
    rest = rest.trimStart();
    if (!sup) {
      const e2 = extractScriptAfterMarker(rest, "^");
      if (e2) {
        [sup, rest] = e2;
      }
    }
  }
  rest = rest.trimStart();
  const children: MathComponent[] = [];
  if (rest && !/^[\^_]/.test(rest)) {
    const pair = parseOneWithScripts(rest);
    if (pair[0]) {
      children.push(pair[0]);
      rest = pair[1];
    }
  }
  return [
    new MathFunction({
      name: buildLogLikeFunctionName(cmd, sub, sup),
      children,
    }),
    rest,
  ];
}

const SYMBOL_CMD: Record<string, string> = {
  cdot: "\u22C5",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  pi: "π",
  theta: "θ",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  phi: "φ",
  omega: "ω",
  infty: "∞",
  in: "∈",
  notin: "∉",
  subseteq: "⊆",
  supseteq: "⊇",
  cap: "∩",
  cup: "∪",
  emptyset: "∅",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  equiv: "≡",
  to: "→",
  rightarrow: "→",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  leftrightarrow: "↔",
  mapsto: "↦",
  parallel: "∥",
  perp: "⊥",
  angle: "∠",
  triangle: "△",
  cdots: "⋯",
  ldots: "…",
  dots: "…",
  vert: "|",
  mid: "|",
  nabla: "∇",
  partial: "∂",
  /** ∑ ∫ ∏ 는 OMML n·각 요소로 처리(SYMBOL_CMD 에 두면 위·아래 첨자 결합이 깨짐) */
  otimes: "⊗",
  oplus: "⊕",
};

const TRIG_LIKE = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "sinh",
  "cosh",
  "tanh",
  "log",
  "ln",
  "lg",
  "exp",
  "lim",
  "max",
  "min",
  "sup",
  "inf",
  "det",
  "dim",
  "ker",
  "deg",
  "hom",
  "Pr",
  "arg",
]);

function wrapCurlyGroup(children: MathComponent[]): MathComponent {
  if (children.length === 0) return new MathRun("");
  if (children.length === 1) return children[0]!;
  return new MathCurlyBrackets({ children });
}

function parseFrac(afterCmd: string): [MathFraction, string] | null {
  const r = afterCmd.trimStart();
  const num = takeBalancedBrace(r);
  if (!num) return null;
  const den = takeBalancedBrace(num[1].trimStart());
  if (!den) return null;
  return [
    new MathFraction({
      numerator: parseConcat(num[0]),
      denominator: parseConcat(den[0]),
    }),
    den[1],
  ];
}

function parseSqrt(afterCmd: string): [MathRadical, string] | null {
  let r = afterCmd.trimStart();
  let degree: MathComponent[] | undefined;
  if (r.startsWith("[")) {
    const end = r.indexOf("]");
    if (end === -1) return null;
    degree = parseConcat(r.slice(1, end));
    r = r.slice(end + 1).trimStart();
  }
  const tb = takeBalancedBrace(r);
  if (!tb) return null;
  const [inner, rest] = tb;
  const children = parseConcat(inner);
  return [new MathRadical(degree ? { children, degree } : { children }), rest];
}

function parseTextArg(afterCmd: string): [string, string] | null {
  const r = afterCmd.trimStart();
  const tb = takeBalancedBrace(r);
  if (!tb) return null;
  return [tb[0].replace(/\s+/g, " ").trim(), tb[1]];
}

function parseBackslashCommand(s: string): [MathComponent, string] | null {
  if (!s.startsWith("\\")) return null;
  const m = s.match(/^\\([A-Za-z]+)/);
  if (!m) {
    if (s.startsWith("\\{")) return [new MathRun("{"), s.slice(2)];
    if (s.startsWith("\\}")) return [new MathRun("}"), s.slice(2)];
    if (s.startsWith("\\%")) return [new MathRun("%"), s.slice(2)];
    if (s.startsWith("\\_")) return [new MathRun("_"), s.slice(2)];
    if (s.startsWith("\\ ")) return [new MathRun(" "), s.slice(2)];
    if (s.startsWith("\\,")) return [new MathRun(" "), s.slice(2)];
    if (s.startsWith("\\;")) return [new MathRun(" "), s.slice(2)];
    if (s.startsWith("\\quad")) return [new MathRun("  "), s.slice(5)];
    if (s.startsWith("\\qquad")) return [new MathRun("    "), s.slice(6)];
    return null;
  }
  const cmd = m[1];
  const afterCmd = s.slice(m[0].length);

  if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac") {
    const f = parseFrac(afterCmd);
    return f;
  }
  if (cmd === "binom") {
    const b = parseBinom(afterCmd);
    return b;
  }
  if (cmd === "sqrt") {
    const q = parseSqrt(afterCmd);
    return q;
  }
  if (cmd === "sum") {
    return parseNaryOperator("sum", afterCmd);
  }
  if (cmd === "int") {
    return parseNaryOperator("int", afterCmd);
  }
  if (cmd === "oint") {
    return [new MathRun("∮"), afterCmd];
  }
  if (cmd === "prod") {
    return [new MathRun("∏"), afterCmd];
  }
  if (cmd === "text" || cmd === "mathrm" || cmd === "textrm") {
    const t = parseTextArg(afterCmd);
    if (!t) return null;
    return [new MathRun(t[0]), t[1]];
  }

  if (cmd === "log" || cmd === "ln" || cmd === "lg") {
    return parseLogLike(cmd, afterCmd);
  }

  if (TRIG_LIKE.has(cmd)) {
    let rest = afterCmd.trimStart();
    const children: MathComponent[] = [];
    if (rest && !/^[\^_]/.test(rest)) {
      const pair = parseOneWithScripts(rest);
      if (pair[0]) {
        children.push(pair[0]);
        rest = pair[1];
      }
    }
    return [
      new MathFunction({
        name: [new MathRun(cmd === "Pr" ? "Pr" : cmd)],
        children,
      }),
      rest,
    ];
  }

  const sym = SYMBOL_CMD[cmd];
  if (sym !== undefined) return [new MathRun(sym), afterCmd];

  return [new MathRun(cmd), afterCmd];
}

function parseBase(s: string): [MathComponent, string] | null {
  const t = s.trimStart();
  if (!t.length) return null;

  if (t.startsWith("}")) return null;

  if (t.startsWith("{")) {
    const tb = takeBalancedBrace(t);
    if (!tb) return null;
    const inner = parseConcat(tb[0]);
    return [wrapCurlyGroup(inner), tb[1]];
  }

  if (t.startsWith("(")) {
    const pc = takeParenContent(t);
    if (!pc) return null;
    return [new MathRoundBrackets({ children: parseConcat(pc[0]) }), pc[1]];
  }

  if (t.startsWith("\\")) {
    return parseBackslashCommand(t);
  }

  let i = 0;
  while (i < t.length) {
    const c = t[i]!;
    if (c === "\\" || c === "{" || c === "}" || c === "^" || c === "_" || c === "(") break;
    i += 1;
  }
  if (i === 0) return null;
  return [new MathRun(t.slice(0, i)), t.slice(i)];
}

/**
 * 밑·윗첨자를 한 턴에 읽는다(위를 먼저 붙이면 `\\prod_{a}^{b}` 가 잘못 겹쳐지는 docx-js OMML 이슈 방지).
 * `^` / `_` 가 모두 있으면 `MathPreSubSuperScript` 를 쓴다.
 */
function applyScripts(base: MathComponent, s: string): [MathComponent, string] {
  let r = s.trimStart();
  let sub: MathComponent[] | undefined;
  let sup: MathComponent[] | undefined;
  for (let pass = 0; pass < 2; pass += 1) {
    r = r.trimStart();
    if (!sub) {
      const e = extractScriptAfterMarker(r, "_");
      if (e) {
        [sub, r] = e;
      }
    }
    r = r.trimStart();
    if (!sup) {
      const e2 = extractScriptAfterMarker(r, "^");
      if (e2) {
        [sup, r] = e2;
      }
    }
  }
  let cur = base;
  if (sub && sup) {
    cur = new MathPreSubSuperScript({ children: [base], subScript: sub, superScript: sup });
  } else if (sub) {
    cur = new MathSubScript({ children: [base], subScript: sub });
  } else if (sup) {
    cur = new MathSuperScript({ children: [base], superScript: sup });
  }
  return [cur, r];
}

function parseOneWithScripts(s: string): [MathComponent | null, string] {
  const b = parseBase(s);
  if (!b) return [null, s];
  return applyScripts(b[0], b[1]);
}

function parseConcat(s: string): MathComponent[] {
  const out: MathComponent[] = [];
  let rest = s;
  while (rest.length) {
    rest = rest.trimStart();
    if (!rest.length) break;
    if (rest[0] === "}") break;
    const [node, r2] = parseOneWithScripts(rest);
    if (!node) {
      if (rest[0] === "}") break;
      out.push(new MathRun(rest[0]!));
      rest = rest.slice(1);
      continue;
    }
    out.push(node);
    rest = r2;
  }
  return out;
}

function mathFromInner(inner: string): MathComponent[] {
  const cleaned = preprocessInlineMath(inner.trim());
  if (!cleaned.length) return [];
  return parseConcat(cleaned);
}

function mathZoneToParagraphChild(inner: string): ParagraphChild {
  const trimmed = inner.trim();
  if (!trimmed.length)
    return new TextRun({ text: "", font: EXAM_DOCX_FONT, size: EXAM_DOCX_BODY_SIZE_HALF_PT });
  try {
    const comps = mathFromInner(trimmed);
    if (comps.length) return new Math({ children: comps });
  } catch {
    /* fall through */
  }
  return new TextRun({
    text: explanationLatexToPlain(`$${trimmed}$`),
    font: EXAM_DOCX_FONT,
    size: EXAM_DOCX_BODY_SIZE_HALF_PT,
  });
}

type LineSeg = { kind: "text" | "math"; value: string };

/** Word OMML용: `\\(...\\)`·`\\[...\\]` 를 `$...$` / `$$...$$` 로 바꾼 뒤 분할한다. */
export function normalizeDisplayMathDelimitersForDocx(line: string): string {
  let s = line;
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner: string) => `$${inner}$`);
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner: string) => `$$${inner}$$`);
  return s;
}

function lineLooksLikeBareLatexCommand(line: string): boolean {
  return /\\(?:frac|dfrac|tfrac|sqrt|binom|sum|prod|int|oint|cdot|times|leq|geq|neq|approx|equiv|pi|sin|cos|tan|log|ln|alpha|beta|gamma|theta|infty|partial|lim|to|rightarrow|Rightarrow|Leftarrow|ldots|cdots|vec|overline|underline|text|left|right|bigl|bigr|Bigl|Bigr|begin|end)\b/i.test(
    line,
  );
}

function segmentLineByDollars(line: string): LineSeg[] {
  const out: LineSeg[] = [];
  let i = 0;
  while (i < line.length) {
    if (line.startsWith("$$", i)) {
      const j = line.indexOf("$$", i + 2);
      if (j === -1) {
        out.push({ kind: "text", value: line.slice(i) });
        break;
      }
      out.push({ kind: "math", value: line.slice(i + 2, j) });
      i = j + 2;
      continue;
    }
    const j = line.indexOf("$", i);
    if (j === -1) {
      out.push({ kind: "text", value: line.slice(i) });
      break;
    }
    if (j > i) out.push({ kind: "text", value: line.slice(i, j) });
    const k = line.indexOf("$", j + 1);
    if (k === -1) {
      out.push({ kind: "text", value: line.slice(j) });
      break;
    }
    out.push({ kind: "math", value: line.slice(j + 1, k) });
    i = k + 1;
  }
  return out;
}

/**
 * 해설 한 줄을 DOCX 단락 자식으로 변환한다.
 * `$...$` / `$$...$$` 는 OMML(Math), 그 외는 본문 텍스트(수식 없는 줄은 평문화).
 */
export function explanationLineToParagraphChildren(line: string): ParagraphChild[] {
  const normalizedLine = normalizeDisplayMathDelimitersForDocx(normalizeLatexSourceText(line));
  const segs = segmentLineByDollars(normalizedLine);
  const hasMath = segs.some((s) => s.kind === "math" && s.value.trim().length > 0);
  if (!hasMath) {
    const t = normalizedLine.trim();
    if (t && lineLooksLikeBareLatexCommand(t)) {
      try {
        const child = mathZoneToParagraphChild(t);
        if (child instanceof Math) return [child];
      } catch {
        /* OMML 실패 시 아래 평문 폴백 */
      }
    }
    return [
      new TextRun({
        text: explanationLatexToPlain(normalizedLine),
        font: EXAM_DOCX_FONT,
        size: EXAM_DOCX_BODY_SIZE_HALF_PT,
      }),
    ];
  }
  const children: ParagraphChild[] = [];
  for (const seg of segs) {
    if (seg.kind === "text") {
      if (seg.value.length)
        children.push(
          new TextRun({
            text: seg.value,
            font: EXAM_DOCX_FONT,
            size: EXAM_DOCX_BODY_SIZE_HALF_PT,
          }),
        );
    } else if (seg.value.trim().length) {
      children.push(mathZoneToParagraphChild(seg.value));
    }
  }
  if (children.length === 0) {
    const plain =
      explanationLatexToPlain(normalizedLine).trim() ||
      "〔이 줄은 수식 변환에 실패했습니다. 원본 텍스트 또는 에디터에서 확인하세요.〕";
    children.push(
      new TextRun({
        text: plain,
        font: EXAM_DOCX_FONT,
        size: EXAM_DOCX_BODY_SIZE_HALF_PT,
      }),
    );
  }
  return children;
}
