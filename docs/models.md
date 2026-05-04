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
- **보내기 보정** `/api/repair-explanations`: `GEMINI_MODELS_REPAIR`
- `gemini-1.5-pro`, `gemini-1.5-flash` 는 generate/precheck 후보에서 제외됩니다.

## OpenAI

- **MCP** (`mcp/gemini-explanation.mts` 도구 `generate_math_explanation_openai`): `OPENAI_API_KEY` 필수, 모델은 인자 `model` 또는 **`OPENAI_MODEL_GENERATE_FALLBACK`**(없으면 `gpt-4o-mini`).
- **폴백** (Gemini 실패 시, 비전 Chat Completions): 프로필별로 분기 (`generate-explanation/route.ts`).
  - **easy:** `OPENAI_MODEL_GENERATE_FALLBACK_EASY` → `OPENAI_MODEL_GENERATE_FALLBACK` → `gpt-4o-mini`
  - **balanced:** `OPENAI_MODEL_GENERATE_FALLBACK_BALANCED` → `OPENAI_MODEL_GENERATE_FALLBACK` → `gpt-4o-mini`
  - **killer:** `OPENAI_MODEL_GENERATE_FALLBACK_KILLER` → `OPENAI_MODEL_GENERATE_FALLBACK` → `gpt-4o`
- **교차 검증**(옵션, **Gemini 1차 초안 → OpenAI가 이미지·초안 대조 후 수정**): `EXPLANATION_CROSS_VERIFY=true`, `OPENAI_API_KEY` 필수. 모델은 **`solver-profile`(easy / balanced / killer)** 에 따라 자동 선택된다.

### OpenAI 종량제·감 잡기 (월정액 아님)

- 요금은 **입력 토큰·출력 토큰** 합이며, 시점·모델마다 단가가 바뀐다. **항상 [OpenAI 요금 페이지](https://openai.com/api/pricing/)** 를 기준으로 한다.
- 참고용 **과거 구간**(예: GPT-4o 계열이 널리 쓰이던 시기): 대략 **입력 $5 / 1M 토큰**, **출력 $15 / 1M 토큰** 수준이 자주 인용된다. 지금 단가는 위 공식 페이지가 정답이다.
- 한글은 글자당 토큰이 영어보다 커지는 편이라, “짧은 프롬프트 + 긴 해설”이면 **출력 비중**이 비용을 좌우한다.
- **체감 시뮬레이션(교육용 대략값, 법적 견적 아님):** 입력·출력을 각각 약 1k 토큰이라 가정하면, 위 구간 단가 기준으로 대략 **수 센트/문항** 안팎이 될 수 있다. 문항 수·이미지·시스템 프롬프트 길이에 비례해 증가한다.

### 하이브리드 라우팅 (비용 vs 품질, 코드 반영)

| 용도 | 프로필 / 단계 | 기본 모델( env 미설정 시 ) | 덮어쓰기 env |
|------|----------------|---------------------------|--------------|
| 교차 검증 | **easy** | `gpt-4o-mini` | `OPENAI_MODEL_CROSS_VERIFY_EASY` |
| 교차 검증 | **balanced** | `gpt-4o` | `OPENAI_MODEL_CROSS_VERIFY_BALANCED` → `OPENAI_MODEL_CROSS_VERIFY` |
| 교차 검증 | **killer** | `gpt-4o` | `OPENAI_MODEL_CROSS_VERIFY_KILLER` → `OPENAI_MODEL_CROSS_VERIFY` |
| Gemini 실패 시 OpenAI 비전 폴백 | **easy** | `gpt-4o-mini` | `OPENAI_MODEL_GENERATE_FALLBACK_EASY` → `OPENAI_MODEL_GENERATE_FALLBACK` |
| Gemini 실패 시 OpenAI 비전 폴백 | **balanced** | `gpt-4o-mini` | `OPENAI_MODEL_GENERATE_FALLBACK_BALANCED` → `OPENAI_MODEL_GENERATE_FALLBACK` |
| Gemini 실패 시 OpenAI 비전 폴백 | **killer** | `gpt-4o` | `OPENAI_MODEL_GENERATE_FALLBACK_KILLER` → `OPENAI_MODEL_GENERATE_FALLBACK` |
| 합본 preflight (`build:md --preflight-openai`) | — | `gpt-4o-mini` | `OPENAI_MODEL_PREFLIGHT` 만 (교차검증 모델과 분리) |
| 보정 `/api/repair-explanations` | — | `gpt-4o-mini` | `OPENAI_MODEL_REPAIR_FALLBACK` |

- **easy 교차검증**은 `OPENAI_MODEL_CROSS_VERIFY`만 `gpt-4o`로 두어도 **기본은 mini**로 유지한다(쉬운 세트에서 검증 비용 누적 방지). easy만 4o를 쓰려면 `OPENAI_MODEL_CROSS_VERIFY_EASY=gpt-4o` 를 명시한다.
- **킬러에 최상위 추론 모델**이 필요하면 `OPENAI_MODEL_CROSS_VERIFY_KILLER=gpt-5.2` 등으로만 올린다(비용·지연 증가).

### 프롬프트 다이어트

- 배치·MCP·교차검증 모두 **불필요한 장문·중복 예시**를 줄이면 입력 토큰이 줄어든다.
- 시스템 지시는 코드(`buildSystemInstruction`, 교차검증용 `buildCrossVerifyUserPrompt` 등)에 고정된 만큼, **유저가 붙이는 task·초안**만 짧게 유지하는 것이 효과가 크다.

## 예시 `.env.local`

```env
GEMINI_API_KEY=...
OPENAI_API_KEY=...

# (선택) Gemini 초안 후 OpenAI 비전으로 2차 검증 — 원장님 확정 동선(PIPELINE.md)
# EXPLANATION_CROSS_VERIFY=true
# OPENAI_MODEL_CROSS_VERIFY=gpt-4o
# OPENAI_MODEL_CROSS_VERIFY_KILLER=gpt-4o
# OPENAI_MODEL_CROSS_VERIFY_BALANCED=gpt-4o
# OPENAI_MODEL_CROSS_VERIFY_EASY=gpt-4o-mini

# (선택) 미설정 시 Flash-Lite 기본 체인 사용
# (gemini-2.5-flash-lite → gemini-2.5-flash; 구 2.0-flash-lite는 신규 키 404로 비권장).
# 해설 품질 우선 예시 — 위 「해설 품질 최우선」 참고
# GEMINI_MODELS_GENERATE_FINAL=gemini-2.0-flash,gemini-2.5-pro
# GEMINI_MODELS_GENERATE_KILLER=gemini-2.5-pro,gemini-2.0-flash
# GEMINI_MODELS_PRECHECK=gemini-2.0-flash
# GEMINI_MODELS_GENERATE_TEST=...
# GEMINI_MODELS_GENERATE_FINAL=...
# GEMINI_MODELS_GENERATE_EASY=...
# GEMINI_MODELS_GENERATE_BALANCED=...
# GEMINI_MODELS_GENERATE_KILLER=...
# GEMINI_MODELS_REPAIR=...
```

프롬프트·스타일 규칙은 **저장소 코드**와 **Cursor**에서 관리합니다 (`getRuntimePromptRules` 는 현재 항상 `null`).

**Google Drive**(시험지 묶음 읽기 전용) 환경변수는 [PIPELINE.md](./PIPELINE.md) 와 `.env.local.example` 을 참고하세요.
