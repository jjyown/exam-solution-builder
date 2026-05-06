/**
 * 초기 단계: 외부 DB 없이 동작. 프롬프트 규칙은 코드(`generate-explanation` prompts)에서 관리.
 */
export type RuntimePromptRules = {
  extraConstraints?: string;
  examplesEasy?: string;
  examplesBalanced?: string;
  examplesKiller?: string;
};

export async function getRuntimePromptRules(): Promise<RuntimePromptRules | null> {
  return null;
}
