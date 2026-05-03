/**
 * API/메모장 초안(UTF-8) → DOCX 파이프라인에서 LaTeX가 먹히도록
 * 백슬래시·달러 문자를 ASCII로 통일한다.
 *
 * - U+20A9 (₩): 일부 한국어 환경에서 백슬래시가 원화로 **저장**된 경우(글리프만이 아님)
 * - U+FF3C (＼): 전각 역슬래시
 * - U+FF04 (＄): 전각 달러 → 인라인 $ 인식
 */
export function normalizeLatexSourceText(s: string): string {
  return s.replace(/\u20A9/g, "\\").replace(/\uFF3C/g, "\\").replace(/\uFF04/g, "$");
}
