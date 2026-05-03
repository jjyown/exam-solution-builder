/**
 * env에 모델을 지정하지 않을 때 쓰는 기본 후보(앞에서부터 순차 시도).
 *
 * 1순위 `gemini-2.5-flash-lite`: 비용·지연 우선.
 * 2순위 `gemini-2.5-flash`: Google이 **신규 API 키·프로젝트에서 `gemini-2.0-flash-lite` 접근을 막는**
 * (404 “no longer available to new users”) 경우가 있어, Lite 폴백으로 예전에 쓰던 2.0-flash-lite 대신
 * 표준 Flash를 둔다.
 *
 * 품질·모델명을 직접 고정하려면 각 `GEMINI_MODELS_*` env에 쉼표 구분 목록을 적으면 됨.
 */
export const DEFAULT_GEMINI_COST_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
] as const;
