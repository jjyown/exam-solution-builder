/**
 * geminiGenerationConfig.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  Gemini Vision/풀이 LLM 호출의 generationConfig 표준화 모듈.
 *
 *  ▶ 배경(2026-05-16, plan v25/v26):
 *    Gemini 2.5 시리즈는 기본적으로 thinking tokens 사용. maxOutputTokens 안에서
 *    thinking 이 토큰을 다 먹으면 본 응답이 중간에 끊김(`\tim` 잘림,
 *    `\begin{cases}` 미닫힘, JSON unterminated 등). 운영 로그에서 직접 확인.
 *
 *  ▶ 해결: thinkingBudget=0 + maxOutputTokens 명시.
 *
 *  ▶ 적용 대상 라우트:
 *    - src/app/api/auto-pipeline/vision/route.ts (풀이 LLM 직접)
 *    - src/app/api/auto-pipeline/docx/route.ts (DOCX 생성 시 문제 본문 OCR)
 *    - src/app/api/auto-pipeline/route.ts (일반 모드)
 *
 *  ▶ 호환: 2.0 모델은 thinkingConfig 무시하므로 같은 옵션 안전하게 공유.
 *    기존 photoEditGemini.ts 의 동명 함수 본문과 동일 패턴 — 표준화·중앙화 목적.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * Gemini 2.5 thinking 비활성화 + 표준 generation 옵션.
 *  - temperature: 0 (deterministic — 진단/측정에 유리)
 *  - maxOutputTokens: 인자로 명시
 *  - thinkingConfig.thinkingBudget: 0 (2.5 모델 thinking 사용 안 함)
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
 */
export function noThinkingConfig(
  maxOutputTokens: number,
  opts?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    temperature: 0,
    maxOutputTokens,
    thinkingConfig: { thinkingBudget: 0 },
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
