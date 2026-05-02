/**
 * KaTeX/LaTeX 스타일 수식을 DOCX·검증용 한 줄 평문으로 변환한다.
 * (save-result / exportDocQuality / 내보내기 게이트 공용)
 */

const UNICODE_SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const UNICODE_SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

function mapAsciiDigitsToScript(s: string, table: string): string {
  return [...s]
    .map((ch) => {
      const d = ch.codePointAt(0)! - 0x30;
      return d >= 0 && d <= 9 ? table[d]! : ch;
    })
    .join("");
}

/** 정수 지수·밑 등을 유니코드 위·아래첨자로 바꿔 문서에서 수학 기호가 분명히 보이게 한다. */
function normalizeIntegerScripts(text: string): string {
  let t = text;
  t = t.replace(/\b(sin|cos|tan)\^(\d+)/gi, (_, fn: string, exp: string) => {
    return `${fn.toLowerCase()}${mapAsciiDigitsToScript(exp, UNICODE_SUPERSCRIPT_DIGITS)}`;
  });
  t = t.replace(/\b(log|ln)_(\d+)/gi, (_, fn: string, sub: string) => {
    return `${fn.toLowerCase()}${mapAsciiDigitsToScript(sub, UNICODE_SUBSCRIPT_DIGITS)}`;
  });
  t = t.replace(/(\d+)\^(\d+)/g, (_, base: string, exp: string) => {
    return `${base}${mapAsciiDigitsToScript(exp, UNICODE_SUPERSCRIPT_DIGITS)}`;
  });
  t = t.replace(/([A-Za-zα-ωθπ])\^(\d+)/g, (_, base: string, exp: string) => {
    return `${base}${mapAsciiDigitsToScript(exp, UNICODE_SUPERSCRIPT_DIGITS)}`;
  });
  t = t.replace(/([A-Za-zα-ωθπ])_(\d+)/g, (_, base: string, sub: string) => {
    return `${base}${mapAsciiDigitsToScript(sub, UNICODE_SUBSCRIPT_DIGITS)}`;
  });
  t = t.replace(/\^\((\d+)\)/g, (_, exp: string) => mapAsciiDigitsToScript(exp, UNICODE_SUPERSCRIPT_DIGITS));
  return t;
}

export function simplifyLatexContent(value: string): string {
  return value
    .replace(/\$\$?/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\binom\{([^}]+)\}\{([^}]+)\}/g, "$1C$2")
    .replace(/\\sqrt\[3\]\{([^}]+)\}/g, "∛$1")
    .replace(/\\sqrt\[4\]\{([^}]+)\}/g, "∜$1")
    .replace(/\\sqrt\{([^}]+)\}/g, "√$1")
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "$1/$2")
    .replace(/\\times|\\cdot/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\pi/g, "π")
    .replace(/\\geq|\\ge/g, "≥")
    .replace(/\\leq|\\le/g, "≤")
    .replace(/\\neq/g, "≠")
    .replace(/\\pm/g, "±")
    .replace(/\\sin/g, "sin")
    .replace(/\\cos/g, "cos")
    .replace(/\\tan/g, "tan")
    .replace(/\\log/g, "log")
    .replace(/\\ln/g, "ln")
    .replace(/\\alpha/g, "α")
    .replace(/\\beta/g, "β")
    .replace(/\\gamma/g, "γ")
    .replace(/\\theta/g, "θ")
    .replace(/\\cdots|\\dots/g, "...")
    .replace(/\\,/g, " ")
    .replace(/\{([^{}]+)\}/g, "$1")
    .replace(/\\([A-Za-z]+)/g, "$1")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \f\v]+/g, " ")
    .trim();
}

/** $...$ / $$...$$ 구간을 먼저 풀어쓴 뒤, 남은 LaTeX 명령을 정리한다. */
export function explanationLatexToPlain(value: string): string {
  let s = value.replace(/\r\n/g, "\n");
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => simplifyLatexContent(inner));
  s = s.replace(/\$([^$\n]+)\$/g, (_, inner) => simplifyLatexContent(inner));
  s = simplifyLatexContent(s);
  s = normalizeIntegerScripts(s);
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
