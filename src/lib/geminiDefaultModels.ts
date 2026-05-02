/**
 * env에 모델을 지정하지 않을 때 쓰는 기본 후보(앞에서부터 순차 시도).
 * Flash-Lite 계열: 일반 Flash 대비 비용·지연이 낮고, 크롭·해설 자동화에 충분한 경우가 많음.
 * 품질을 올리려면 각 GEMINI_MODELS_* env에 쉼표로 모델 목록을 직접 적으면 됨.
 */
export const DEFAULT_GEMINI_COST_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
] as const;
