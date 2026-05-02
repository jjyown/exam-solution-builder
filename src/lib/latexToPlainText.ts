/**
 * KaTeX/LaTeX 스타일 수식을 DOCX·검증용 한 줄 평문으로 변환한다.
 * (save-result / exportDocQuality / 내보내기 게이트 공용)
 */
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
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
