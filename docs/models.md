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
- **교차 검증(신뢰도 최우선, 옵션)**  
  - `EXPLANATION_CROSS_VERIFY=true` 이고 `OPENAI_API_KEY`가 있으면, **Gemini 1차 초안이 품질 게이트를 통과한 뒤** OpenAI vision으로 **2차 독립 검토**를 한 번 더 수행합니다.  
  - 검토 모델: `OPENAI_MODEL_CROSS_VERIFY` (기본 `gpt-4o`).  
  - 검증 결과가 내부 품질 검증을 통과하지 못하면 **1차 초안을 유지**하고 `qualityWarnings`에 사유를 남깁니다.  
  - 응답 JSON에 `crossVerified: true/false`가 포함될 수 있습니다.  
  - LLM은 절대적인 100% 정답을 보장하지 않으나, **서로 다른 계열(멀티모델) 검증**으로 실수를 줄이는 용도입니다.

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

### A-2. 교차 검증 전용 (`/api/generate-explanation`)
- 환경변수 키: `OPENAI_MODEL_CROSS_VERIFY`
- 기본값: `gpt-4o`
- 전제: `EXPLANATION_CROSS_VERIFY=true`

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

## 4) 최고 신뢰도(비용 감수) 권장 조합 — 전문가·MCP 토의 종합

MCP `gemini_chat`·`gpt_chat`로 1차=비전·2차=교차검증 구조를 재확인했고, **코드에서 제외되는 1.5 Pro/Flash는 사용하지 않습니다.**  
아래는 `pickModelCandidates` 매핑과 맞춘 **권장 모델 ID**입니다(계정/리전에서 404가 나면 한 단계 낮은 Flash 계열로 내리면 됨).

| generationMode | solverProfile | 1차(Gemini, env 키) | 2차(교차검증, OpenAI vision) |
|----------------|---------------|----------------------|--------------------------------|
| `final` | `easy` | `GEMINI_MODELS_GENERATE_FINAL` → `gemini-2.5-flash` | `OPENAI_MODEL_CROSS_VERIFY=gpt-4o` |
| `final` | `balanced` | `GEMINI_MODELS_GENERATE_BALANCED` → `gemini-2.5-pro` | 동일 |
| `final` | `killer` | `GEMINI_MODELS_GENERATE_KILLER` → `gemini-2.5-pro` | 동일 |
| `test` | `easy` | `GEMINI_MODELS_GENERATE_EASY` → `gemini-2.5-flash` | 동일 |
| `test` | `balanced` | `GEMINI_MODELS_GENERATE_TEST` → `gemini-2.5-flash` | 동일 |
| `test` | `killer` | `GEMINI_MODELS_GENERATE_TEST` → `gemini-2.5-pro` | 동일 |

필수 플래그:

```env
EXPLANATION_CROSS_VERIFY=true
OPENAI_API_KEY=...
OPENAI_MODEL_CROSS_VERIFY=gpt-4o
OPENAI_MODEL_GENERATE_FALLBACK=gpt-4o
```

**역할 분담:** Gemini로 이미지 중심 초안 생성 → 동일 이미지를 보낸 채 GPT가 논리·계산·보기 일치를 재점검해 초안을 수정 또는 동일 재출력.  
**한계:** 어떤 조합도 수학 정답을 법적으로 “100% 보증”하지는 않으며, 인간 검수가 최종 방어선입니다.
