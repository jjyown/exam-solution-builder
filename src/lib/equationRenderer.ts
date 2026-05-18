/**
 * LaTeX → SVG → PNG 렌더러.
 *
 * MathJax-full(TeX → SVG) + @resvg/resvg-js(SVG → PNG)로 모든 LaTeX 명령어를
 * 한 번에 그래픽으로 임베드한다. OMML 기반 SYMBOL_CMD 수동 큐레이션 종결.
 *
 * 호출처: `examExplanationDocx.ts` 의 `$...$` / `$$...$$` 토큰 분리 시.
 * 결과는 `ImageRun` 으로 DOCX 본문에 삽입한다 (transformation: pixels).
 */
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { Resvg } from "@resvg/resvg-js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const tex = new TeX({
  packages: AllPackages,
  // 정의되지 않은 매크로도 throw 하지 않고 plain text 로 폴백
  formatError: (_jax: unknown, err: { message?: string }) => {
    throw new Error(err?.message || "TeX parse error");
  },
});
const svgJax = new SVG({ fontCache: "none" });
const mjDoc = mathjax.document("", { InputJax: tex, OutputJax: svgJax });

export type RenderResult = {
  /** PNG 바이너리. docx `ImageRun.data` 에 그대로 전달. */
  buffer: Buffer;
  /** 픽셀 단위 너비/높이. docx `transformation.width/height` 에 전달. */
  widthPx: number;
  heightPx: number;
};

/**
 * DOCX 수식 렌더 모드.
 *  - `png`: 본 모듈의 `renderLatexToPng` (현행, MathJax → SVG → resvg PNG)
 *  - `omml`: `latexToOmml.ts` 변환기 + docx Math 클래스 네이티브 (Commit 3 도입)
 *
 * default `png` — v30 KaTeX cool-down 안전. 의뢰인 viewer 검증 통과 후
 * Railway env 수동 `omml` 전환. 회귀 시 env 1줄 원상 복귀.
 */
export type ExamDocxMathMode = "png" | "omml";
export const EXAM_DOCX_MATH_MODE: ExamDocxMathMode =
  process.env.EXAM_DOCX_MATH_MODE === "omml" ? "omml" : "png";

const cache = new Map<string, RenderResult>();

/** SVG width="Xex" / height="Yex" 또는 "Xpt" 등 단위 + 숫자 추출. */
function parseSvgLength(svg: string, attr: "width" | "height"): { value: number; unit: string } | null {
  const m = svg.match(new RegExp(`${attr}="([\\d.]+)(ex|em|pt|px)"`));
  if (!m) return null;
  return { value: parseFloat(m[1]), unit: m[2] };
}

/** ex/em/pt → px 환산 (대략적). 1ex ≈ 8px (16px font 기준 0.5배). */
function toPx(value: number, unit: string, fontPx = 16): number {
  switch (unit) {
    case "px":
      return value;
    case "pt":
      return value * (96 / 72);
    case "em":
      return value * fontPx;
    case "ex":
      return value * fontPx * 0.5;
    default:
      return value;
  }
}

/** invalid LaTeX 시 빨간 글자로 fallback PNG 생성. */
function renderFallbackPng(latex: string): RenderResult {
  const text = latex.slice(0, 60).replace(/[<>&"']/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === '"' ? "&quot;" : "&apos;",
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="20">` +
    `<text x="0" y="14" font-family="monospace" font-size="12" fill="#cc0000">⚠ ${text}</text>` +
    `</svg>`;
  const png = new Resvg(svg, { fitTo: { mode: "zoom", value: 2 } }).render();
  return {
    buffer: Buffer.from(png.asPng()),
    widthPx: 200,
    heightPx: 14,
  };
}

/**
 * LaTeX 1개를 PNG 로 렌더.
 * @param latex - `$` / `$$` 없이 본문만 (예: `\frac{1}{2}` 또는 `x^2 + y^2 = r^2`)
 * @param opts.displayMode - true 면 디스플레이 수식 (큰 글자), false 면 인라인
 * @param opts.scale - resvg zoom 배율(기본 1.3 → 130% 해상도)
 */
export function renderLatexToPng(
  latex: string,
  opts: { displayMode?: boolean; scale?: number } = {},
): RenderResult {
  const trimmed = (latex ?? "").trim();
  if (!trimmed) throw new Error("empty latex");
  if (trimmed.length > 5000) throw new Error("latex too long (>5000 chars)");

  // 기본 1.3 — 사용자 docx 검증에서 200% 확대가 텍스트 줄간격 대비 비대하다는 보고.
  // 130%로 줄여 균형. displayMode/inline 차등은 호출처가 opts.scale 명시로 처리.
  const scale = opts.scale ?? 1.3;
  const displayMode = opts.displayMode ?? false;
  const cacheKey = `${displayMode ? "d" : "i"}:${scale}:${trimmed}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  try {
    const node = mjDoc.convert(trimmed, { display: displayMode });
    const rawHtml = adaptor.outerHTML(node);
    // MathJax는 결과를 <mjx-container>로 감싸므로 내부 <svg ...>...</svg> 만 추출.
    const svgMatch = rawHtml.match(/<svg[\s\S]*?<\/svg>/);
    if (!svgMatch) throw new Error("MathJax output에 SVG 루트 없음");
    let svgStr = svgMatch[0];
    // xmlns 누락 시 추가 (resvg가 namespace 요구).
    if (!/xmlns=/.test(svgStr)) {
      svgStr = svgStr.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    const png = new Resvg(svgStr, { fitTo: { mode: "zoom", value: scale } }).render();
    const wLen = parseSvgLength(svgStr, "width");
    const hLen = parseSvgLength(svgStr, "height");
    const widthPx = wLen ? Math.round(toPx(wLen.value, wLen.unit) * scale) : 100;
    const heightPx = hLen ? Math.round(toPx(hLen.value, hLen.unit) * scale) : 20;
    const out: RenderResult = {
      buffer: Buffer.from(png.asPng()),
      widthPx,
      heightPx,
    };
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    console.warn(
      "[equationRenderer] LaTeX 변환 실패:",
      trimmed.slice(0, 100),
      (e as Error).message,
    );
    return renderFallbackPng(trimmed);
  }
}

/** 캐시 통계(디버그 / 모니터링용). */
export function getEquationCacheStats(): { size: number } {
  return { size: cache.size };
}
