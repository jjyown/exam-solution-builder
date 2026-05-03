# 모델·환경변수 (로컬 API 전제)

- 문서 기준일: 2026-05-04

해설 파이프라인은 **로컬 `npm run dev`** 와 `.env.local` 로 동작합니다. (선택) **Google Drive**는 Railway 크롭 묶음 **읽기**만 하며, **최종 DOCX는 로컬 `해설지 최종본`에만** 저장됩니다.

## 해설 품질 최우선 (비용·속도보다 정확도·서술)

**합의:** 모델을 올려도 된다면 Flash-Lite 기본 체인 대신 **상위 Gemini**를 쓰고, 필요하면 **교차 검증**을 켠다. (지연·API 비용은 늘 수 있음 — [HISTORY_SPEED_ANALYSIS.md](./HISTORY_SPEED_ANALYSIS.md))

**예시 `.env.local` 조각** (계정·시점에 따라 쓸 수 있는 모델 ID는 Google 문서를 확인):

```env
# 최종 제작·일반 난이도 — 앞에서부터 순차 시도
GEMINI_MODELS_GENERATE_FINAL=gemini-2.0-flash,gemini-2.5-pro
GEMINI_MODELS_GENERATE_BALANCED=gemini-2.0-flash
GEMINI_MODELS_GENERATE_KILLER=gemini-2.5-pro,gemini-2.0-flash
GEMINI_MODELS_PRECHECK=gemini-2.0-flash

# (선택) Gemini 초안 → OpenAI 비전 검토
EXPLANATION_CROSS_VERIFY=true
OPENAI_MODEL_CROSS_VERIFY=gpt-4o
OPENAI_MODEL_CROSS_VERIFY_KILLER=gpt-4o
```

- **MCP** (`generate_math_explanation`): 도구 인자 **`model`** 에 예: `gemini-2.0-flash` 를 넣으면 서버 기본 Flash-Lite 순회를 덮어쓸 수 있다 (도구 구현상).

## Gemini

- **기본 후보**(env 비움): `src/lib/geminiDefaultModels.ts` — **`gemini-2.5-flash-lite` → `gemini-2.5-flash`** 순으로 시도. (구 `gemini-2.0-flash-lite`는 Google이 신규 키에서 단계적으로 비활성해 **404**가 나므로 폴백에서 제외됨.) 품질을 우선하면 env에 `gemini-2.0-flash` 등을 직접 적으면 됨.
- **사전검증** `/api/precheck-extraction`: `GEMINI_MODELS_PRECHECK`
- **해설 생성** `/api/generate-explanation`: `GEMINI_MODELS_GENERATE_*` 계열 (UI 생성 모드·프로필별로 키가 다름 — `resolveGeminiGenerateEnvKey` 와 동일)
- **내보내기 보정** `/api/repair-explanations`: `GEMINI_MODELS_REPAIR`
- `gemini-1.5-pro`, `gemini-1.5-flash` 는 generate/precheck 후보에서 제외됩니다.

## OpenAI

- **MCP** (`mcp/gemini-explanation.mts` 도구 `generate_math_explanation_openai`): `OPENAI_API_KEY` 필수, 모델은 인자 `model` 또는 **`OPENAI_MODEL_GENERATE_FALLBACK`**(없으면 `gpt-4o-mini`).
- **폴백** (Gemini 실패 시): `OPENAI_MODEL_GENERATE_FALLBACK` (기본 `gpt-4o-mini`), `OPENAI_EXPLANATION_FORMAT_RETRY`
- **교차 검증**(옵션, **Gemini 1차 초안 → OpenAI가 이미지·초안 대조 후 수정**): `EXPLANATION_CROSS_VERIFY=true`, `OPENAI_API_KEY` 필수. 일반 검증 모델: `OPENAI_MODEL_CROSS_VERIFY`(기본 `gpt-4o`). **killer 프로필**일 때는 `OPENAI_MODEL_CROSS_VERIFY_KILLER` → 없으면 `OPENAI_MODEL_CROSS_VERIFY` → 기본 `gpt-5.2` 순 (`generate-explanation/route.ts` 의 `resolveCrossVerifyModel`).

## 예시 `.env.local`

```env
GEMINI_API_KEY=...
OPENAI_API_KEY=...

# (선택) Gemini 초안 후 OpenAI 비전으로 2차 검증 — 원장님 확정 동선(PIPELINE.md)
# EXPLANATION_CROSS_VERIFY=true
# OPENAI_MODEL_CROSS_VERIFY=gpt-4o
# OPENAI_MODEL_CROSS_VERIFY_KILLER=gpt-5.2

# (선택) 미설정 시 Flash-Lite 기본 체인 사용
# GEMINI_MODELS_PRECHECK=gemini-2.5-flash-lite,gemini-2.5-flash
# GEMINI_MODELS_GENERATE_FINAL=gemini-2.0-flash
```

프롬프트·스타일 규칙은 **저장소 코드**와 **Cursor**에서 관리합니다 (`getRuntimePromptRules` 는 현재 항상 `null`).

**Google Drive**(시험지 묶음 읽기 전용) 환경변수는 [PIPELINE.md](./PIPELINE.md) 와 `.env.local.example` 을 참고하세요.
