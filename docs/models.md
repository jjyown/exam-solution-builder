# 현재 사용 모델 목록 (Gemini / GPT)

이 문서는 최신 코드 기준으로, 해설 제작 파이프라인에서 사용하는 모델과 환경변수 키를 정리합니다.

## 1) Gemini 모델

### A. 문제 영역 사전검증 (`/api/precheck-extraction`)
- 환경변수 키: `GEMINI_MODELS_PRECHECK`
- 기본 후보: `gemini-2.0-flash`
- 참고:
  - 코드에서 `gemini-1.5-pro`, `gemini-1.5-flash`는 자동 필터링됩니다.
  - precheck 429(`Too Many Requests`/`Resource exhausted`)는 UI에서 생성 강행하지 않도록 차단됩니다.

### B. 해설 생성 (`/api/generate-explanation`)
- 환경변수 키:
  - `GEMINI_MODELS_GENERATE_FINAL`
  - `GEMINI_MODELS_GENERATE_TEST`
  - `GEMINI_MODELS_GENERATE_EASY`
  - `GEMINI_MODELS_GENERATE_BALANCED`
  - `GEMINI_MODELS_GENERATE_KILLER`
- 기본 후보: 각 프로필 모두 `gemini-2.0-flash`
- 참고:
  - 코드에서 `gemini-1.5-pro`, `gemini-1.5-flash`는 자동 필터링됩니다.
  - Gemini 실패 시 OpenAI fallback 경로를 사용합니다.

### C. DOCX 내보내기 직전 자동 보정 (`/api/repair-explanations`)
- 환경변수 키: `GEMINI_MODELS_REPAIR`
- 운영 권장: `gemini-2.0-flash` 우선

## 2) GPT(OpenAI) 모델

### A. 일반 해설 파이프라인 fallback (`/api/generate-explanation`)
- 환경변수 키: `OPENAI_MODEL_GENERATE_FALLBACK`
- 기본값: `gpt-4o-mini`
- 동작:
  - Gemini 후보가 모두 실패하거나 검증을 통과하지 못하면 OpenAI fallback을 시도합니다.
  - 수업기준 이슈는 치명/경고로 분리해 처리합니다.

### B. HML 붙이기 백업 경로 (`/api/hml/append-solution`)
- 코드 경로에서 GPT를 보조로 사용할 수 있습니다.
- 모델 가용성은 계정/리전/정책에 따라 달라질 수 있습니다.

## 3) 운영 권장 환경변수 예시

```env
GEMINI_MODELS_PRECHECK=gemini-2.0-flash
GEMINI_MODELS_GENERATE_FINAL=gemini-2.0-flash
GEMINI_MODELS_GENERATE_TEST=gemini-2.0-flash
GEMINI_MODELS_GENERATE_EASY=gemini-2.0-flash
GEMINI_MODELS_GENERATE_BALANCED=gemini-2.0-flash
GEMINI_MODELS_GENERATE_KILLER=gemini-2.0-flash
GEMINI_MODELS_REPAIR=gemini-2.0-flash
OPENAI_MODEL_GENERATE_FALLBACK=gpt-4o
```
