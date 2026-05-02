/** Google Generative AI SDK / REST 오류 메시지에서 할당량·혼잡 여부 추출 */
export function isGeminiRateLimitedMessage(message: string) {
  return /429|Too Many Requests|Resource exhausted/i.test(message);
}
