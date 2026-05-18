/**
 * geminiGenerationConfig.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  Gemini Vision/풀이 LLM 호출의 generationConfig 표준화 모듈.
 *
 *  ▶ 적용 대상 라우트:
 *    - src/app/api/auto-pipeline/vision/route.ts (풀이 LLM 직접)
 *    - src/app/api/auto-pipeline/docx/route.ts (DOCX 생성 시 문제 본문 OCR)
 *    - src/app/api/auto-pipeline/route.ts (일반 모드)
 *
 *  ▶ Gemini 2.5 thinking: dynamic 자동. thinkingBudget 명시 안 함.
 *    과거 thinkingBudget=0 강제(de652ce, 2026-05-16) 는 2026-05-19 API 정책으로
 *    "Budget 0 is invalid. This model only works in thinking mode." 거부 회귀 → 제거.
 *    응답 잘림 방어는 maxOutputTokens cap 으로 갈음 (isResponseTruncated 감지 유지).
 *
 *  ▶ 호환: 2.0 모델은 thinkingConfig 무관, 같은 옵션 안전 공유.
 *    photoEditGemini.ts 의 동명 로컬 함수는 별 PR 정리 대상 (/edit 경로, /auto 와 무관).
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Gemini 풀이 LLM 표준 generation 옵션.
 *  - temperature: 0 (deterministic — 진단/측정에 유리)
 *  - maxOutputTokens: 인자로 명시 (응답 잘림 cap)
 *  - opts 로 호출처별 추가 옵션 덮어쓰기 가능 (responseMimeType, temperature 등)
 *
 * 예:
 *  ```ts
 *  // 풀이 LLM (vision/route.ts): JSON 응답 + 약간의 자유도 유지
 *  generationConfig: noThinkingConfig(8192, {
 *    responseMimeType: 'application/json',
 *    temperature: 0.2,
 *  }),
 *  ```
 *
 * 함수명 noThinkingConfig 은 과거 의도 잔재 — 현재 thinking 활성. rename 은 별 PR (호출처 3곳).
 */
export function noThinkingConfig(
  maxOutputTokens: number,
  opts?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    temperature: 0,
    maxOutputTokens,
    ...(opts ?? {}),
  };
}

/**
 * 응답이 maxOutputTokens 한도에서 잘렸는지 감지.
 *  - Gemini API 응답의 `candidates[0].finishReason === 'MAX_TOKENS'` 가 강한 신호
 *  - 또는 `usageMetadata.candidatesTokenCount >= maxOutputTokens - 8` 같은 근사
 *
 * 호출처에서 `[ocr_truncated]` 로그 + auto_pipeline_runs.errors 누적용으로 사용.
 * retrospective.ts 의 failureCategories 가 자동 집계 → cautionNotes 자동 주입.
 */
export function isResponseTruncated(geminiResponse: unknown): boolean {
  if (!geminiResponse || typeof geminiResponse !== "object") return false;
  const data = geminiResponse as {
    candidates?: Array<{ finishReason?: string }>;
  };
  const finish = data.candidates?.[0]?.finishReason;
  return finish === "MAX_TOKENS";
}
