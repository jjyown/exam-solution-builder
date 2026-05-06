/**
 * API/메모장 초안(UTF-8) → DOCX 파이프라인에서 LaTeX가 먹히도록
 * 백슬래시·달러 문자를 ASCII로 통일한다.
 *
 * - U+20A9 (₩): 일부 한국어 환경에서 백슬래시가 원화로 **저장**된 경우(글리프만이 아님)
 * - U+FF3C (＼): 전각 역슬래시
 * - U+FF04 (＄): 전각 달러 → 인라인 $ 인식
 * - 스칼라 곱: `\cdot` → `\times` (**`\cdots`·`\ldots`는 보존**)
 */
const CDOTS_PLACEHOLDER = "\uE000__TMP_CDOTS__\uE001";
const LDOTS_PLACEHOLDER = "\uE000__TMP_LDOTS__\uE001";

export function normalizeScalarCdotToTimes(s: string): string {
  let t = s
    .replace(/\\cdots/g, CDOTS_PLACEHOLDER)
    .replace(/\\ldots/g, LDOTS_PLACEHOLDER)
    .replace(/\\cdot/g, "\\times");
  t = t.split(CDOTS_PLACEHOLDER).join("\\cdots");
  t = t.split(LDOTS_PLACEHOLDER).join("\\ldots");
  return t;
}

export function normalizeLatexSourceText(s: string): string {
  const ascii = s
    .replace(/\u20A9/g, "\\")
    .replace(/\uFFE6/g, "\\")
    .replace(/\uFF3C/g, "\\")
    .replace(/\uFF04/g, "$")
    // 일부 OCR/복붙 손상 토큰: LaTeX 명령 앞 역슬래시가 # / #w 로 깨짐
    .replace(/#wsqrt\b/gi, "\\sqrt")
    .replace(/#sqrt\b/gi, "\\sqrt")
    .replace(/#wfrac\b/gi, "\\frac")
    .replace(/#frac\b/gi, "\\frac")
    .replace(/#wlog\b/gi, "\\log")
    .replace(/#log\b/gi, "\\log");
  return normalizeScalarCdotToTimes(ascii);
}
