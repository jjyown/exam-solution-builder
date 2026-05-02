/**
 * `/api/generate-explanation` 의 pickModelCandidates 와 동일한 규칙으로
 * 어떤 GEMINI_MODELS_GENERATE_* 키를 쓰는지 노출한다 (UI·문서와 코드 일치).
 */
export type ExplanationGenerationMode = "test" | "final";
export type SolverModelProfile = "easy" | "balanced" | "killer";

export function resolveGeminiGenerateEnvKey(params: {
  generationMode: ExplanationGenerationMode;
  solverModelProfile: SolverModelProfile;
}): string {
  const { generationMode, solverModelProfile } = params;
  if (solverModelProfile === "easy") {
    return generationMode === "test"
      ? "GEMINI_MODELS_GENERATE_EASY"
      : "GEMINI_MODELS_GENERATE_FINAL";
  }
  if (solverModelProfile === "killer") {
    return "GEMINI_MODELS_GENERATE_KILLER";
  }
  if (solverModelProfile === "balanced") {
    return generationMode === "test"
      ? "GEMINI_MODELS_GENERATE_TEST"
      : "GEMINI_MODELS_GENERATE_BALANCED";
  }
  return generationMode === "test"
    ? "GEMINI_MODELS_GENERATE_TEST"
    : "GEMINI_MODELS_GENERATE_FINAL";
}
