import {
  BuilderElement,
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
  XmlComponent,
  createMathAccentCharacter,
  createMathBase,
} from "docx";
import { EXAM_DOCX_BODY_SIZE_HALF_PT, EXAM_DOCX_FONT } from "./examDocxTheme";
import { explanationLatexToPlain } from "./latexToPlainText";
import { normalizeLatexSourceText } from "./latexSourceNormalize";

/**
 * `2^{5/2}`, `4^{1/3}` 등 지수 안의 `숫자/숫자`를 OMML에서 **가로 분수**로 쌓이게 `\frac` 로 바꾼다.
 * (그대로 두면 윗첨자에 `5`, `/`, `2`가 따로 나와 LaTeX·플레인텍스트처럼 보인다.)
 */
function normalizeNumericFractionInScripts(s: string): string {
  let t = s;
  for (let guard = 0; guard < 12; guard += 1) {
    const next = t
      .replace(/\^\{(\d+)\s*\/\s*(\d+)\}/g, "^{\\frac{$1}{$2}}")
      .replace(/_\{(\d+)\s*\/\s*(\d+)\}/g, "_{\\frac{$1}{$2}}");
    if (next === t) break;
    t = next;
  }
  return t;
}

/** 수식 전용 줄·블록 끝의 마침표(소수점 오인 방지) — 문장 부호로 쓰이지 않게 제거 */
function stripTrailingEquationPeriodInMath(inner: string): string {
  const t = inner.trim();
  return t.replace(/(?<=[\d\)\]}])\.(?=\s*$)/u, "");
}

function preprocessInlineMath(inner: string): string {
  const stripped = stripTrailingEquationPeriodInMath(inner);
  return normalizeNumericFractionInScripts(
    stripped
      /** `\dfrac12`·`\tfrac12` 처럼 한 자리 분수(중괄호 생략) → `\frac{1}{2}` */
      .replace(/\\dfrac(?!\{)\s*(\d)\s*(\d)(?![0-9])/g, "\\frac{$1}{$2}")
      .replace(/\\tfrac(?!\{)\s*(\d)\s*(\d)(?![0-9])/g, "\\frac{$1}{$2}")
      .replace(/\\displaystyle\s*|\\textstyle\s*|\\scriptstyle\s*|\\scriptscriptstyle\s*/g, "")
      /** HWP·복사 붙여넣기에서 쓰이는 중점·곱점 → LaTeX (OMML 파서가 인식) */
      .replace(/\u00B7|\u2219|\u22C5|·/g, "\\cdot ")
      .replace(/\\dfrac\b|\\tfrac\b/g, "\\frac")
      /** 일부 편집기·복사 과정에서 `\frac` 앞 역슬래시만 `#`으로 깨지는 경우 */
      .replace(/#frac\b/g, "\\frac")
      .replace(/\\Biggl\s*/g, "")
      .replace(/\\biggl\s*/g, "")
      .replace(/\\Biggr\s*/g, "")
      .replace(/\\biggr\s*/g, "")
      .replace(/\\Bigl\s*/g, "")
      .replace(/\\Bigr\s*/g, "")
      .replace(/\\bigl\s*/g, "")
      .replace(/\\bigr\s*/g, "")
      .replace(/\\Bigm\s*/g, "")
      .replace(/\\bigm\s*/g, "")
      .replace(/\\Bigg[lrm]?\s*/g, "")
      .replace(/\\bigg[lrm]?\s*/g, "")
      .replace(/\\Big(?=\()/g, "")
      .replace(/\\big(?=\()/g, "")
      .replace(/\\Big\s+/g, "")
      .replace(/\\big\s+/g, "")
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
      .replace(/\\left|\\right/g, ""),
  );
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

/**
 * OMML `m:bar`(pos=top) — `\overline{…}`.
 * `m:acc`+가늠표는 일부 글꼴에서 P·Q 위에 빈 네모(토푸)가 뜨는 경우가 있어 Word 표준 막대로 처리한다.
 */
class MathOverline extends XmlComponent {
  constructor(children: readonly MathComponent[]) {
    super("m:bar");
    this.root.push(
      new BuilderElement({
        name: "m:barPr",
        children: [
          new BuilderElement({
            name: "m:pos",
            attributes: { value: { key: "m:val", value: "top" } },
          }),
        ],
      }),
    );
    this.root.push(createMathBase({ children }));
  }
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

/**
 * 삼각·로그·지수 등: Word OMML `m:func` 로 이름과 인자를 분리하면
 * `MathRoundBrackets`(묶음 m:d)에 비해 **가시 괄호·간격 왜곡**이 적고 교과서형 `\sin x` 에 가깝다.
 */
function buildStandardFunction(nameParts: MathComponent[], args: MathComponent[]): MathComponent {
  if (args.length === 0) {
    if (nameParts.length === 0) return new MathRun("");
    if (nameParts.length === 1) return nameParts[0]!;
    return new MathRoundBrackets({ children: nameParts });
  }
  return new MathFunction({
    name: nameParts,
    children: args,
  });
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
    buildStandardFunction(buildLogLikeFunctionName(cmd, sub, sup), children),
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
  Leftrightarrow: "⇔",
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

  if (cmd === "overline") {
    const r = afterCmd.trimStart();
    const tb = takeBalancedBrace(r);
    if (!tb) return null;
    const inner = parseConcat(tb[0].trim());
    return [new MathOverline(inner) as MathComponent, tb[1]];
  }
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
      buildStandardFunction([new MathRun(cmd === "Pr" ? "Pr" : cmd)], children),
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

/**
 * 한 줄이 **수식 블록만** 이고 끝에 마침표가 붙은 경우 제거(소수점 오인 방지).
 * `$$….$$` 처럼 블록 **안** 끝의 마침표는 `preprocessInlineMath` 의 strip 에서 처리.
 */
export function normalizeMathLineTrailingPeriod(line: string): string {
  const lead = line.match(/^(\s*)/)?.[1] ?? "";
  const t = line.trim();
  if (!t || t.startsWith("![")) return line;
  const m1 = t.match(/^(\$[^$\n]+\$)\s*\.\s*$/);
  if (m1) return `${lead}${m1[1]}`;
  const m2 = t.match(/^(\$\$[\s\S]*\$\$)\s*\.\s*$/);
  if (m2) return `${lead}${m2[1]}`;
  return line;
}

function normalizeExplanationPedagogyKorean(line: string): string {
  return line
    /** 백슬래시 유실·변환 실패로 남는 조각 */
    .replace(/\bLeftrightarrow\b/g, "⇔")
    .replace(/\bRightarrow\b/g, "⇒")
    .replace(/\bLeftarrow\b/g, "⇐")
    .replace(/\bLeftr\b/g, "⇔")
    /** 보기 소항: `**ㄱ.**` → `ㄱ) ` (HML·교재형), 줄 아무 곳에서나 */
    .replace(/\*\*ㄱ\.\*\*\s*/gu, "ㄱ) ")
    .replace(/\*\*ㄴ\.\*\*\s*/gu, "ㄴ) ")
    .replace(/\*\*ㄷ\.\*\*\s*/gu, "ㄷ) ")
    .replace(/\*\*ㄹ\.\*\*\s*/gu, "ㄹ) ")
    .replace(/와\s+동치이므로/g, "와 같으므로")
    .replace(/과\s+동치이므로/g, "과 같으므로")
    .replace(/와\s+동치이다/g, "와 같다")
    .replace(/과\s+동치이다/g, "과 같다")
    .replace(/와\s+동치다/g, "와 같다")
    .replace(/과\s+동치다/g, "과 같다")
    .replace(/으로\s+동치이다/g, "으로 같다")
    .replace(/으로\s+동치다/g, "으로 같다");
}

function lineLooksLikeBareLatexCommand(line: string): boolean {
  return /\\(?:frac|dfrac|tfrac|sqrt|binom|sum|prod|int|oint|cdot|times|leq|geq|neq|approx|equiv|pi|sin|cos|tan|log|ln|alpha|beta|gamma|theta|infty|partial|lim|to|rightarrow|Rightarrow|Leftarrow|ldots|cdots|vec|overline|underline|text|left|right|bigl|bigr|Bigl|Bigr|begin|end|displaystyle)\b/i.test(
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
export type ExplanationLineDocxOptions = {
  /** 문제·해설 본문 가독성: 한글·평문 구간만 굵게(OMML 수식 블록은 Word 기본 두께 유지). */
  bold?: boolean;
};

export function explanationLineToParagraphChildren(
  line: string,
  opts?: ExplanationLineDocxOptions,
): ParagraphChild[] {
  const bold = Boolean(opts?.bold);
  const normalizedLine = normalizeMathLineTrailingPeriod(
    normalizeDisplayMathDelimitersForDocx(
      normalizeExplanationPedagogyKorean(normalizeLatexSourceText(line)),
    ),
  );
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
        bold,
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
            bold,
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
        bold,
        font: EXAM_DOCX_FONT,
        size: EXAM_DOCX_BODY_SIZE_HALF_PT,
      }),
    );
  }
  return children;
}
