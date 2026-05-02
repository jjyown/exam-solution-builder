import {
  Math,
  MathComponent,
  MathCurlyBrackets,
  MathFraction,
  MathFunction,
  MathRadical,
  MathRoundBrackets,
  MathRun,
  MathSubScript,
  MathSuperScript,
  ParagraphChild,
  TextRun,
} from "docx";
import { explanationLatexToPlain } from "./latexToPlainText";

const DOC_BODY_FONT = {
  ascii: "Malgun Gothic",
  eastAsia: "Malgun Gothic",
  hAnsi: "Malgun Gothic",
} as const;

/** `\left`/`\right` 등은 단순 괄호로만 취급 */
function preprocessInlineMath(inner: string): string {
  return inner
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
  sum: "∑",
  prod: "∏",
  int: "∫",
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
  let r = afterCmd.trimStart();
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
  let afterCmd = s.slice(m[0].length);

  if (cmd === "frac") {
    const f = parseFrac(afterCmd);
    return f;
  }
  if (cmd === "sqrt") {
    const q = parseSqrt(afterCmd);
    return q;
  }
  if (cmd === "text" || cmd === "mathrm" || cmd === "textrm") {
    const t = parseTextArg(afterCmd);
    if (!t) return null;
    return [new MathRun(t[0]), t[1]];
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

function parseSuperscript(base: MathComponent, s: string): [MathComponent, string] | null {
  if (!s.startsWith("^")) return null;
  let r = s.slice(1).trimStart();
  let script: MathComponent[];
  if (r.startsWith("{")) {
    const tb = takeBalancedBrace(r);
    if (!tb) return null;
    script = parseConcat(tb[0]);
    r = tb[1];
  } else if (r.length) {
    script = [new MathRun(r[0]!)];
    r = r.slice(1);
  } else return null;
  return [new MathSuperScript({ children: [base], superScript: script }), r];
}

function parseSubscript(base: MathComponent, s: string): [MathComponent, string] | null {
  if (!s.startsWith("_")) return null;
  let r = s.slice(1).trimStart();
  let script: MathComponent[];
  if (r.startsWith("{")) {
    const tb = takeBalancedBrace(r);
    if (!tb) return null;
    script = parseConcat(tb[0]);
    r = tb[1];
  } else if (r.length) {
    script = [new MathRun(r[0]!)];
    r = r.slice(1);
  } else return null;
  return [new MathSubScript({ children: [base], subScript: script }), r];
}

function applyScripts(base: MathComponent, s: string): [MathComponent, string] {
  let cur = base;
  let r = s;
  for (;;) {
    r = r.trimStart();
    const sup = parseSuperscript(cur, r);
    if (sup) {
      [cur, r] = sup;
      continue;
    }
    const sub = parseSubscript(cur, r);
    if (sub) {
      [cur, r] = sub;
      continue;
    }
    break;
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
  if (!trimmed.length) return new TextRun({ text: "", font: DOC_BODY_FONT });
  try {
    const comps = mathFromInner(trimmed);
    if (comps.length) return new Math({ children: comps });
  } catch {
    /* fall through */
  }
  return new TextRun({ text: explanationLatexToPlain(`$${trimmed}$`), font: DOC_BODY_FONT });
}

type LineSeg = { kind: "text" | "math"; value: string };

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
  const segs = segmentLineByDollars(line);
  const hasMath = segs.some((s) => s.kind === "math" && s.value.trim().length > 0);
  if (!hasMath) {
    return [new TextRun({ text: explanationLatexToPlain(line), font: DOC_BODY_FONT })];
  }
  const children: ParagraphChild[] = [];
  for (const seg of segs) {
    if (seg.kind === "text") {
      if (seg.value.length) children.push(new TextRun({ text: seg.value, font: DOC_BODY_FONT }));
    } else if (seg.value.trim().length) {
      children.push(mathZoneToParagraphChild(seg.value));
    }
  }
  if (children.length === 0) children.push(new TextRun({ text: "", font: DOC_BODY_FONT }));
  return children;
}
