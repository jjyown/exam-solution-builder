# 모델·환경변수 (로컬 API 전제)

- 문서 기준일: 2026-05-02

해설 파이프라인은 **로컬 `npm run dev`** 와 `.env.local` 로 동작합니다. (선택) **Google Drive**는 Railway 크롭 묶음 **읽기**만 하며, **최종 DOCX는 로컬 `해설지 최종본`에만** 저장됩니다.

## Gemini

- **기본 후보**(env 비움): `src/lib/geminiDefaultModels.ts` — **`gemini-2.5-flash-lite` → `gemini-2.0-flash-lite`** 순으로 시도(비용·지연 우선). 영역 크롭·대량 배치에 맞춘 설정이며, 품질을 우선하면 env에 `gemini-2.0-flash` 등을 직접 적으면 됨.
- **사전검증** `/api/precheck-extraction`: `GEMINI_MODELS_PRECHECK`
- **해설 생성** `/api/generate-explanation`: `GEMINI_MODELS_GENERATE_*` 계열 (UI 생성 모드·프로필별로 키가 다름 — `resolveGeminiGenerateEnvKey` 와 동일)
- **내보내기 보정** `/api/repair-explanations`: `GEMINI_MODELS_REPAIR`
- `gemini-1.5-pro`, `gemini-1.5-flash` 는 generate/precheck 후보에서 제외됩니다.

## OpenAI

- **MCP** (`mcp/gemini-explanation.mts` 도구 `generate_math_explanation_openai`): `OPENAI_API_KEY` 필수, 모델은 인자 `model` 또는 **`OPENAI_MODEL_GENERATE_FALLBACK`**(없으면 `gpt-4o-mini`).
- **폴백** (Gemini 실패 시): `OPENAI_MODEL_GENERATE_FALLBACK` (기본 `gpt-4o-mini`), `OPENAI_EXPLANATION_FORMAT_RETRY`
- **교차 검증**(옵션): `EXPLANATION_CROSS_VERIFY=true`, `OPENAI_MODEL_CROSS_VERIFY`

## 예시 `.env.local`

```env
GEMINI_API_KEY=...
OPENAI_API_KEY=...

# (선택) 미설정 시 Flash-Lite 기본 체인 사용
# GEMINI_MODELS_PRECHECK=gemini-2.5-flash-lite,gemini-2.0-flash-lite
# GEMINI_MODELS_GENERATE_FINAL=gemini-2.0-flash
```

프롬프트·스타일 규칙은 **저장소 코드**와 **Cursor**에서 관리합니다 (`getRuntimePromptRules` 는 현재 항상 `null`).

**Google Drive**(시험지 묶음 읽기 전용) 환경변수는 [PIPELINE.md](./PIPELINE.md) 와 `.env.local.example` 을 참고하세요.
