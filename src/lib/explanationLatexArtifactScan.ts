/**
 * DOCX보내기 직전 **LaTeX 잔존 정밀 검사**.
 * - 마크다운 ``` 펜스 ``` · `$…$` · `$$…$$` 구간은 검사에서 제외(수식·코드로 간주).
 * - 그 밖에 `\frac`, `\begin{`, `\[`, 미닫힌 `$` 등이 남으면 OMML 변환 전에 잡아낸다.
 */

/** `explanationExportGate` 의 StrayLatexHit 와 동일 형태 */
export type LatexArtifactHit = { section: string; lineOffset: number; line: string; match: string };

function linesOf(s: string): string[] {
  return s.replace(/\r\n/g, "\n").split("\n");
}

function lineNumberAtIndex(source: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index && k < source.length; k += 1) {
    if (source[k] === "\n") line += 1;
  }
  return line;
}

function snippetAtLine(source: string, lineNo: number): string {
  const ls = linesOf(source);
  return (ls[lineNo - 1] ?? "").trim().slice(0, 120);
}

/** `$` 직전에 연속된 `\` 개수(짝수면 `$`는 이스케이프되지 않음, 홀수면 리터럴 `$`) */
function trailingBackslashCountBefore(source: string, dollarIndex: number): number {
  let c = 0;
  for (let k = dollarIndex - 1; k >= 0 && source[k] === "\\"; k -= 1) c += 1;
  return c;
}

function isEscapedDollar(source: string, dollarIndex: number): boolean {
  return trailingBackslashCountBefore(source, dollarIndex) % 2 === 1;
}

export type OutsideMaskResult = {
  /** true = 수식·코드 펜스 밖 → LaTeX 명령이 있으면 안 됨 */
  outsideMask: boolean[];
  delimiterIssues: Array<{ index: number; message: string }>;
};

/**
 * `source` 와 동일 길이 마스크를 만든다. false 구간은 `$…$`, `$$…$$`, ```…``` 내부.
 */
export function buildOutsideMathAndCodeFenceMask(source: string): OutsideMaskResult {
  const n = source.length;
  const outside = new Array<boolean>(n).fill(true);
  const delimiterIssues: Array<{ index: number; message: string }> = [];

  let i = 0;
  while (i < n) {
    if (source.startsWith("```", i)) {
      const close = source.indexOf("```", i + 3);
      if (close === -1) {
        delimiterIssues.push({ index: i, message: "닫히지 않은 마크다운 코드 펜스(```)" });
        for (let k = i; k < n; k += 1) outside[k] = false;
        break;
      }
      for (let k = i; k < close + 3; k += 1) outside[k] = false;
      i = close + 3;
      continue;
    }

    if (source[i] === "$" && source[i + 1] === "$" && !isEscapedDollar(source, i)) {
      const start = i;
      i += 2;
      const close = source.indexOf("$$", i);
      if (close === -1) {
        delimiterIssues.push({ index: start, message: "닫히지 않은 $$ (표시 수식)" });
        for (let k = start; k < n; k += 1) outside[k] = false;
        break;
      }
      for (let k = start; k < close + 2; k += 1) outside[k] = false;
      i = close + 2;
      continue;
    }

    if (source[i] === "$" && !isEscapedDollar(source, i)) {
      const start = i;
      i += 1;
      const close = source.indexOf("$", i);
      if (close === -1) {
        delimiterIssues.push({ index: start, message: "닫히지 않은 $ (인라인 수식)" });
        for (let k = start; k < n; k += 1) outside[k] = false;
        break;
      }
      for (let k = start; k <= close; k += 1) outside[k] = false;
      i = close + 1;
      continue;
    }

    i += 1;
  }

  return { outsideMask: outside, delimiterIssues };
}

function matchFullyOutside(mask: boolean[], start: number, endExclusive: number): boolean {
  for (let k = start; k < endExclusive; k += 1) {
    if (!mask[k]) return false;
  }
  return true;
}

/** `\[ \]` `\( \)` `\begin{...}` `\end{...}` 및 일반 LaTeX 명령(OMML 파이프라인과 정합) */
const RE_ENV = /\\(?:begin|end)\s*\{\s*[^}\s]+\s*\}/gi;
/** `\[ \]` `\( \)` 등 표시 구분자 */
const RE_BRACKET_DELIMS = /\\(?:\[|\]|\(|\))/g;
const RE_CMD =
  /\\(?:frac|dfrac|tfrac|sqrt|binom|sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|log|ln|lg|exp|lim|sum|int|oint|prod|cdot|times|div|pm|mp|leq|geq|le|ge|ne|neq|approx|equiv|iff|implies|to|rightarrow|Rightarrow|Leftarrow|Leftrightarrow|leftrightarrow|mapsto|arcsin|arccos|arctan|left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|middle|overline|underline|overbrace|underbrace|displaystyle|text|mathrm|textrm|mathbf|mathbb|mathcal|mathit|vec|hat|bar|dot|ddot|tilde|widehat|widetilde|theta|pi|alpha|beta|gamma|delta|phi|varphi|sigma|Sigma|omega|varepsilon|Delta|Gamma|cdots|ldots|dots|vdots|ddots|infty|partial|subset|supset|subseteq|supseteq|cup|cap|setminus|emptyset|varnothing|sim|simeq|propto|angle|perp|parallel|circ|deg|triangle|nabla|hline|vline)(?![a-zA-Z])/gi;

/** `\,` `\;` `\!` 등(수식 밖이면 잔존으로 간주) */
const RE_SPACING_CMD = /\\(?:quad|qquad|,|;|:|!)(?![a-zA-Z])/g;

const RE_SUBSUP_ESC = /\\[_^]/g;

/**
 * 수식·코드 펜스 밖에 남은 LaTeX 흔적 + 달러/펜스 미닫힘.
 * `section` 은 오류 메시지용 라벨(예: `문항 3 [해설] 본문`).
 */
export function findPreciseLatexArtifactsOutsideMath(text: string, section: string): LatexArtifactHit[] {
  const hits: LatexArtifactHit[] = [];
  const { outsideMask, delimiterIssues } = buildOutsideMathAndCodeFenceMask(text);

  for (const d of delimiterIssues) {
    const ln = lineNumberAtIndex(text, d.index);
    hits.push({
      section,
      lineOffset: ln,
      line: snippetAtLine(text, ln),
      match: d.message,
    });
  }

  const tryPattern = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    while ((m = r.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (!matchFullyOutside(outsideMask, start, end)) continue;
      const trimmed = text.split("\n")[lineNumberAtIndex(text, start) - 1]?.trim() ?? "";
      if (trimmed.startsWith("![")) continue;
      const ln = lineNumberAtIndex(text, start);
      hits.push({
        section,
        lineOffset: ln,
        line: snippetAtLine(text, ln),
        match: m[0].slice(0, 80),
      });
    }
  };

  tryPattern(RE_ENV);
  tryPattern(RE_BRACKET_DELIMS);
  tryPattern(RE_CMD);
  tryPattern(RE_SPACING_CMD);
  tryPattern(RE_SUBSUP_ESC);

  // 중복(같은 줄·같은 match) 제거
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.lineOffset}|${h.match}|${h.line.slice(0, 40)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 구버전 호환: 단순히 `$$`·`$` 블록만 제거한 평문(외부 도구용). */
export function stripTexMathZonesLegacy(s: string): string {
  let t = s;
  for (let guard = 0; guard < 20; guard += 1) {
    const next = t.replace(/\$\$[\s\S]*?\$\$/g, " ");
    if (next === t) break;
    t = next;
  }
  for (let guard = 0; guard < 200; guard += 1) {
    const next = t.replace(/\$[^$\n]+\$/g, " ");
    if (next === t) break;
    t = next;
  }
  return t;
}
