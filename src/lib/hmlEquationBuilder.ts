/**
 * hmlEquationBuilder.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  LaTeX/KaTeX 수식 → 한컴 한글 HML 수식 스크립트 변환.
 *
 *  한컴 수식 문법은 LaTeX 와 의도적으로 비슷하게 설계됐다(`a over b`, `root x`).
 *  대부분 1:1 매핑 가능하므로 트리 walking 없이 토큰 치환 + 중괄호 보존 으로 충분.
 *
 *  생성된 스크립트는 HML 파일의 `<EQUATION><SCRIPT>...</SCRIPT></EQUATION>` 안에
 *  그대로 들어가며, 한컴 한글이 자동으로 렌더링한다.
 *
 *  지원 명령 (자주 쓰이는 것 중심):
 *    \frac{a}{b}              → {a} over {b}
 *    \dfrac, \tfrac           → over
 *    \sqrt{x}                 → root x
 *    \sqrt[n]{x}              → root n of x
 *    \int_a^b f               → int from a to b f
 *    \sum_{k=1}^n             → sum from k=1 to n
 *    \prod, \lim, \max, \min  → prod, lim, max, min
 *    \binom{n}{k}             → bin n,k
 *    \theta, \alpha, \pi 등   → theta, alpha, pi (그대로)
 *    \cdot, \times, \div      → cdot, times, div
 *    \leq, \geq, \neq, \approx → <=, >=, !=, ≈
 *    \mathbb{R}, \mathbf{x}   → R, bold {x}
 *    \overline{x}, \vec{v}    → bar x, vec v
 *    \begin{cases} ... \end   → cases { ... }
 *    \begin{pmatrix}…         → matrix { … }
 *    ^, _                     → 그대로 (한컴 수식이 인식)
 *
 *  단순화/한계:
 *   - 표현이 복잡하면 LaTeX 원문을 fallback 으로 그대로 노출 (수정 가능)
 *   - matrix 는 단순 케이스만 (행렬 교양서 수준)
 *   - 사용자가 더 정밀한 수식이 필요하면 한컴 한글 안에서 직접 편집
 * ────────────────────────────────────────────────────────────────────────────
 */

/** LaTeX 명령 → HML 토큰 직접 치환 표 (단어 경계 자동 처리). */
type Replacer = string | ((substring: string, ...args: string[]) => string);
const LATEX_TO_HML: Array<[RegExp, Replacer]> = [
  // 분수 — \frac{a}{b} → {a} over {b}
  [/\\d?frac\s*\{/g, "{frac{"],  // 임시 토큰으로 변환 (단계적 처리)
  [/\\tfrac\s*\{/g, "{frac{"],
  // 근호
  [/\\sqrt\s*\[\s*([^\]]+?)\s*\]\s*\{/g, "{root $1 of "],
  [/\\sqrt\s*\{/g, "{root "],
  // 적분/합/곱
  [/\\int(?:_(\{[^{}]*\}|[^\s_^]+))?(?:\^(\{[^{}]*\}|[^\s_^]+))?/g, (_m, lo, hi) => {
    const l = stripBraces(lo);
    const h = stripBraces(hi);
    if (l && h) return `int from ${l} to ${h} `;
    if (l) return `int from ${l} `;
    return "int ";
  }],
  [/\\sum(?:_(\{[^{}]*\}|[^\s_^]+))?(?:\^(\{[^{}]*\}|[^\s_^]+))?/g, (_m, lo, hi) => {
    const l = stripBraces(lo);
    const h = stripBraces(hi);
    if (l && h) return `sum from ${l} to ${h} `;
    if (l) return `sum from ${l} `;
    return "sum ";
  }],
  [/\\prod(?:_(\{[^{}]*\}|[^\s_^]+))?(?:\^(\{[^{}]*\}|[^\s_^]+))?/g, (_m, lo, hi) => {
    const l = stripBraces(lo);
    const h = stripBraces(hi);
    if (l && h) return `prod from ${l} to ${h} `;
    if (l) return `prod from ${l} `;
    return "prod ";
  }],
  [/\\lim_(\{[^{}]*\}|[^\s_^]+)/g, (_m, lo) => `lim from ${stripBraces(lo)} `],
  [/\\lim/g, "lim "],
  [/\\max_(\{[^{}]*\}|[^\s_^]+)/g, (_m, lo) => `max from ${stripBraces(lo)} `],
  [/\\min_(\{[^{}]*\}|[^\s_^]+)/g, (_m, lo) => `min from ${stripBraces(lo)} `],
  [/\\max\b/g, "max "],
  [/\\min\b/g, "min "],
  // 조합/순열
  [/\\binom\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "bin $1,$2"],
  // 위·아래 표시
  [/\\overline\s*\{([^{}]+)\}/g, "bar {$1}"],
  [/\\bar\s*\{([^{}]+)\}/g, "bar {$1}"],
  [/\\vec\s*\{([^{}]+)\}/g, "vec {$1}"],
  [/\\hat\s*\{([^{}]+)\}/g, "hat {$1}"],
  [/\\widetilde\s*\{([^{}]+)\}/g, "tilde {$1}"],
  [/\\tilde\s*\{([^{}]+)\}/g, "tilde {$1}"],
  // 굵게/특수 글꼴 — 한컴은 bold 만 명시
  [/\\mathbf\s*\{([^{}]+)\}/g, "bold {$1}"],
  [/\\boldsymbol\s*\{([^{}]+)\}/g, "bold {$1}"],
  [/\\mathbb\s*\{([^{}]+)\}/g, "$1"],   // 칠판 글꼴 — 한컴엔 직접 매핑 없음, plain
  [/\\mathcal\s*\{([^{}]+)\}/g, "$1"],
  [/\\mathrm\s*\{([^{}]+)\}/g, "$1"],
  // 그리스 (대소문자 모두 — 한컴이 그대로 인식)
  [/\\(alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|omicron|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega)\b/g, "$1 "],
  [/\\(Alpha|Beta|Gamma|Delta|Epsilon|Zeta|Eta|Theta|Iota|Kappa|Lambda|Mu|Nu|Xi|Omicron|Pi|Rho|Sigma|Tau|Upsilon|Phi|Chi|Psi|Omega)\b/g, "$1 "],
  // 기호
  [/\\cdot\b/g, " cdot "],
  [/\\times\b/g, " times "],
  [/\\div\b/g, " div "],
  [/\\pm\b/g, " pm "],
  [/\\mp\b/g, " mp "],
  [/\\neq\b/g, " != "],
  [/\\leq\b|\\le\b/g, " <= "],
  [/\\geq\b|\\ge\b/g, " >= "],
  [/\\approx\b/g, " ≈ "],
  [/\\equiv\b/g, " == "],
  [/\\sim\b/g, " ~ "],
  [/\\propto\b/g, " ∝ "],
  [/\\infty\b/g, " inf "],
  [/\\partial\b/g, " partial "],
  [/\\nabla\b/g, " nabla "],
  [/\\to\b|\\rightarrow\b/g, " -> "],
  [/\\leftarrow\b/g, " <- "],
  [/\\Rightarrow\b/g, " => "],
  [/\\Leftarrow\b/g, " <= "],
  [/\\Leftrightarrow\b|\\iff\b/g, " <=> "],
  [/\\in\b/g, " in "],
  [/\\notin\b/g, " notin "],
  [/\\subset\b/g, " subset "],
  [/\\supset\b/g, " supset "],
  [/\\cup\b/g, " cup "],
  [/\\cap\b/g, " cap "],
  [/\\emptyset\b/g, " empty "],
  [/\\forall\b/g, " forall "],
  [/\\exists\b/g, " exists "],
  // 함수
  [/\\(sin|cos|tan|cot|sec|csc|sinh|cosh|tanh|log|ln|exp|arg|deg|gcd|lcm|mod)\b/g, " $1 "],
  // 절댓값 — \lvert x \rvert / \left| x \right|
  [/\\lvert/g, "|"],
  [/\\rvert/g, "|"],
  [/\\left\|/g, "|"],
  [/\\right\|/g, "|"],
  [/\\left\(/g, "("],
  [/\\right\)/g, ")"],
  [/\\left\[/g, "["],
  [/\\right\]/g, "]"],
  [/\\left\\\{/g, "{"],
  [/\\right\\\}/g, "}"],
  [/\\left\./g, ""],
  [/\\right\./g, ""],
  // 공백/줄바꿈
  [/\\\\/g, " # "],   // 행렬·cases 줄바꿈 — 한컴은 # 사용
  [/\\quad\b/g, " ` "],
  [/\\qquad\b/g, " ` ` "],
  [/\\,/g, " "],
  [/\\;/g, " "],
  [/\\!/g, ""],
  [/\\text\s*\{([^{}]+)\}/g, '"$1"'],
  [/\\,/g, " "],
];

function stripBraces(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/^\{|\}$/g, "");
}

/**
 * 「frac{a}{b}」 패턴 → 「{a} over {b}」 변환.
 * 두 번째 중괄호 짝까지 추적해서 분모 추출.
 */
function applyFracOver(input: string): string {
  let s = input;
  // 임시 토큰 처리 — frac{a}{b}
  while (true) {
    const idx = s.indexOf("frac{");
    if (idx < 0) break;
    // 첫 번째 그룹 매칭
    const numStart = idx + "frac{".length;
    const numEnd = matchBrace(s, numStart - 1);
    if (numEnd < 0) break;
    const num = s.slice(numStart, numEnd);
    // 분모 — 다음 위치가 '{'여야 함
    if (s[numEnd + 1] !== "{") break;
    const denStart = numEnd + 2;
    const denEnd = matchBrace(s, numEnd + 1);
    if (denEnd < 0) break;
    const den = s.slice(denStart, denEnd);
    // 「{a} over {b}」 로 치환
    s = s.slice(0, idx) + `{${num}} over {${den}}` + s.slice(denEnd + 1);
  }
  return s;
}

/** s[openIdx]='{' 와 짝맞는 '}' 인덱스 — 중첩 처리. 못 찾으면 -1. */
function matchBrace(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i += 1) {
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** LaTeX 수식 본문 → HML 수식 스크립트 */
export function latexToHmlEquation(latex: string): string {
  if (!latex) return "";
  let s = latex.trim();

  // 인라인/디스플레이 wrapper 제거
  s = s.replace(/^\$\$|\$\$$/g, "");
  s = s.replace(/^\$|\$$/g, "");
  s = s.replace(/^\\\(|\\\)$/g, "");
  s = s.replace(/^\\\[|\\\]$/g, "");

  // 케이스 환경 — \begin{cases} ... \end{cases}
  s = s.replace(/\\begin\{cases\}([\s\S]+?)\\end\{cases\}/g, (_m, body) => {
    return `cases {${body.trim()}}`;
  });
  // 행렬 — pmatrix/bmatrix/matrix 모두 단순 matrix 로
  s = s.replace(/\\begin\{(?:pmatrix|bmatrix|matrix|vmatrix|Vmatrix)\}([\s\S]+?)\\end\{(?:pmatrix|bmatrix|matrix|vmatrix|Vmatrix)\}/g, (_m, body) => {
    return `matrix {${body.trim()}}`;
  });

  // 명령 직접 치환
  for (const [re, rep] of LATEX_TO_HML) {
    if (typeof rep === "string") {
      s = s.replace(re, rep);
    } else {
      s = s.replace(re, rep);
    }
  }

  // 분수 토큰 처리 (frac{a}{b} → {a} over {b})
  s = applyFracOver(s);

  // 미처리 \xxx 명령은 그대로 두되, 단어 사이 공백 정리
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

/**
 * 한컴 한글 HML XML 안에 들어갈 수식 블록 생성.
 *
 *  display=true   디스플레이 수식 (별도 줄)
 *  display=false  인라인 수식 (텍스트 흐름 안)
 *
 *  HML 의 EQUATION 태그는 단순 형태:
 *    <EQUATION ...>
 *      <SCRIPT>{본문}</SCRIPT>
 *    </EQUATION>
 */
export function buildHmlEquationXml(latex: string, opts?: { display?: boolean }): string {
  const script = latexToHmlEquation(latex);
  if (!script) return "";
  const safe = script
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const align = opts?.display ? "Center" : "Left";
  return `<EQUATION Align="${align}" Version="Equation"><SCRIPT>${safe}</SCRIPT></EQUATION>`;
}
