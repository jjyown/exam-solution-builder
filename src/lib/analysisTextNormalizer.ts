/**
 * analysisTextNormalizer.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  Mathpix / Gemini OCR 결과를 1:1 페어 매핑 단계 전에 표준화한다.
 *
 *  배경:
 *   - parseProblemSolutionPairs() 가 인식하는 마커는 `[문항 N]`, `[해설 N]`,
 *     `[정답 및 해설]`, `[해설]` 같은 "대괄호 표준 헤더" 다.
 *   - 그런데 시중교재 OCR 결과에는 보통 다음과 같이 비표준 형태로 나온다:
 *       "예제 7", "유형 12", "**3.**", "정답 및 해설" (대괄호 없음),
 *       "**[정답]** ②", "■ 해설", "▣ 풀이" 등.
 *   - 비표준 형태면 1단계 매핑이 깨지고 1500자 chunk 폴백으로 떨어진다.
 *
 *  이 모듈은:
 *   1) 강한 시작 신호(예제/유형/굵게+번호)를 발견하면 `[문항 N]` 으로 표준화
 *   2) 풀이 섹션 헤더(■ 해설, ▣ 풀이, 풀이 단독줄 등)를 `[정답 및 해설]` 로 표준화
 *   3) 풀이 본문 안의 정답 라인(`■ 정답 ② ` 같은) 을 `[정답] ②` 로 정규화
 *   4) 너무 짧은 문항(잘려 들어온 페이지 끝) 을 잘 알아볼 수 있게 표시 — 단,
 *      삭제는 하지 않음 (다음 처리 단계가 결정).
 *
 *  부작용 최소화 — 마커 표준화만 하고 본문은 그대로 둔다. 재 OCR 같은 비싼 작업 X.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type NormalizeResult = {
  text: string;
  /** 변환이 일어났을 때 어떤 패턴이 매칭됐는지 운영 디버깅용 */
  appliedRules: string[];
};

/**
 * OCR 텍스트를 표준 헤더로 변환. 이미 표준 형태면 그대로 둔다.
 * `[문항 N]`, `[해설 N]`, `[정답 및 해설]` 표준 헤더가 1개라도 이미 있으면 — 신뢰하고 변환 최소화.
 */
export function normalizeOcrTextForPairing(input: string): NormalizeResult {
  if (!input || !input.trim()) return { text: input, appliedRules: [] };
  const applied: string[] = [];
  let text = input;

  const hasStandardSolutionSection =
    /\[정답\s*및\s*해설\]|\[해설\]\s*\n/m.test(text);
  const hasStandardProblemMarker = /\[문항\s*\d+\]/.test(text);

  // ── 1) 풀이 섹션 헤더 표준화 ─────────────────────────────────────────────
  // 「■ 해설」, 「▣ 풀이」, 「◎ 정답과 해설」, 「풀이」 단독줄, 「정답·해설」 등.
  // 한 번만 — 이미 표준 헤더 있으면 건드리지 않음.
  if (!hasStandardSolutionSection) {
    const before = text;
    text = text.replace(
      /(^|\n)\s*[■▣◎●▶➤]?\s*(?:정답\s*[·및과]?\s*해설|풀이\s*및\s*정답|해설\s*및\s*정답|정답\s*해설)\s*\n/m,
      "$1[정답 및 해설]\n",
    );
    if (text === before) {
      // 「풀이」 단독줄 — 본문에 풀이 키워드가 단독으로 떨어진 경우만
      text = text.replace(
        /(^|\n)\s*(?:풀이|해설)\s*\n(?=[\s\S]{50,})/m,
        "$1[정답 및 해설]\n",
      );
    }
    if (text !== before) applied.push("solution-section-standardized");
  }

  // ── 2) 강한 문항 시작 신호 표준화 ─────────────────────────────────────────
  // 「예제 7」, 「유형 12」, 「**3.**」, 「**3)**」 → `[문항 N]`
  // 이미 [문항 N] 으로 시작하는 줄은 건드리지 않음.
  if (!hasStandardProblemMarker) {
    const before = text;
    // 굵게로 감싼 번호: **3.** / **3)** (Mathpix 가 자주 굵게 처리)
    text = text.replace(
      /(^|\n)\s*\*\*\s*(\d{1,3})\s*[\.)]\s*\*\*/g,
      "$1[문항 $2]",
    );
    // 「예제 N」 / 「유형 N」 / 「문제 N」 (단독 줄, 뒤에 콜론·점 가능)
    text = text.replace(
      /(^|\n)\s*(?:예제|유형|문제)\s*(\d{1,3})\s*[\.\:\)]?\s*(?=\n|\S)/g,
      "$1[문항 $2]\n",
    );
    if (text !== before) applied.push("problem-marker-standardized");
  }

  // ── 3) 풀이 안 정답 라인 표준화 ─────────────────────────────────────────
  // 「■ 정답 ②」, 「◎ 정답: 3」, 「**[정답]** ②」 → `[정답] ②`
  {
    const before = text;
    text = text.replace(
      /(^|\n)\s*[■▣◎●▶➤]?\s*\*?\*?\[?\s*정\s*답\s*\]?\*?\*?\s*[\:\.]?\s*([①-⑩\d\w\$\\\\]+(?:[^\n]{0,40}))/g,
      "$1[정답] $2",
    );
    if (text !== before) applied.push("answer-line-standardized");
  }

  // ── 4) 「[해설] N」 / 「[해설N]」 변형 → `[해설 N]` 로 통일 ─────────────
  {
    const before = text;
    text = text.replace(/\[해설\]\s*(\d{1,3})\s*\b/g, "[해설 $1]");
    text = text.replace(/\[해설\s*(\d{1,3})\s*\]/g, "[해설 $1]");
    if (text !== before) applied.push("solution-marker-standardized");
  }

  return { text, appliedRules: applied };
}
