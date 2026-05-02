# 모델·환경변수 (로컬 API 전제)

- 문서 기준일: 2026-05-02

해설 파이프라인은 **로컬 `npm run dev`** 와 `.env.local` 로 동작합니다. (선택) **Google Drive**는 Railway 크롭 묶음 **읽기**만 하며, **최종 DOCX는 로컬 `해설지 최종본`에만** 저장됩니다.

## Gemini

- **사전검증** `/api/precheck-extraction`: `GEMINI_MODELS_PRECHECK` (기본 `gemini-2.0-flash`)
- **해설 생성** `/api/generate-explanation`: `GEMINI_MODELS_GENERATE_*` 계열 (UI 생성 모드·프로필별로 키가 다름 — 코드의 `resolveGeminiGenerateEnvKey` 와 동일)
- **내보내기 보정** `/api/repair-explanations`: `GEMINI_MODELS_REPAIR`
- `gemini-1.5-pro`, `gemini-1.5-flash` 는 코드에서 후보에서 제외됩니다.

## OpenAI

- **폴백** (Gemini 실패 시): `OPENAI_MODEL_GENERATE_FALLBACK` (기본 `gpt-4o-mini`), `OPENAI_EXPLANATION_FORMAT_RETRY`
- **교차 검증**(옵션): `EXPLANATION_CROSS_VERIFY=true`, `OPENAI_MODEL_CROSS_VERIFY`

## 예시 `.env.local`

```env
GEMINI_API_KEY=...
OPENAI_API_KEY=...

GEMINI_MODELS_PRECHECK=gemini-2.0-flash
GEMINI_MODELS_GENERATE_FINAL=gemini-2.0-flash
GEMINI_MODELS_GENERATE_TEST=gemini-2.0-flash
GEMINI_MODELS_GENERATE_EASY=gemini-2.0-flash
GEMINI_MODELS_GENERATE_BALANCED=gemini-2.0-flash
GEMINI_MODELS_GENERATE_KILLER=gemini-2.0-flash
GEMINI_MODELS_REPAIR=gemini-2.0-flash
```

프롬프트·스타일 규칙은 **저장소 코드**와 **Cursor**에서 관리합니다 (`getRuntimePromptRules` 는 현재 항상 `null`).

**Google Drive**(시험지 묶음 읽기 전용) 환경변수는 [PIPELINE.md](./PIPELINE.md) 와 `.env.local.example` 을 참고하세요.
