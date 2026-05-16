# PLAN_ATTEMPTS — 해설제작 출력 깨짐 fix 작업 시도 누적

> 용도: plan과 별도. 검토 라운드 진행 시 plan과 함께 검토자에게 전달.
> 검토자가 "이미 시도된 X 또 제안" 헛질문 회피용.
> 메모리 룰: `feedback_review_iteration_workflow.md` (c)항.
>
> 갱신: 매 회차 종료 시 시도·결정·막다른 길 추가.

---

## 현 plan 회차: **v29 종결** — F안 (본문 이미지화). 사용자 가치 미확인으로 평문화 fix 전 항목 폐기. commit `d48d5c7`. 이하 §3~§7은 git history 보존용 deprecated.

## 1. 시도한 것 (완료)

| 회차 | 작업 | commit | 상태 |
|---|---|---|---|
| v18 | 단계 1: `geminiVisionExtract.ts` raw dump 추가 (`DEBUG_VISION_RAW_DUMP` ENV gate). textbook + /auto-pipeline 일반 모드 적용 | `83571de` | ✅ |
| v20 | 단계 1 보강: `vision/route.ts callGeminiVision` 응답 dump 추가 — 비전 모드 흐름 진단 | `df8c813` | ✅ |
| v21 | 단계 2-0a/2-0b: `KOREAN_EXAM_OCR_PROMPT_V2` + `KOREAN_TEXTBOOK_OCR_PROMPT_V2` + `VISION_PROMPT_V2` + `OCR_PROMPT_VERSION` ENV toggle + `resolveOcrPromptVersion()` helper | `80caf02` | ✅ |
| v26 | 단계 2.5: `src/lib/geminiGenerationConfig.ts` 신규 모듈 + `noThinkingConfig` + `isResponseTruncated`. vision/docx/auto-pipeline 3개 라우트 fetch body의 `generationConfig` 표준화. `[ocr_truncated]` 로그 + retrospective 자동 집계 | `de652ce` | ✅ |
| 안전 조치 | dev `.env.local`에 `TEXTBOOK_DRIVE_BUILD_INTERVAL_MS=0` + `DRIVE_ANALYSIS_AUTO_SYNC_MS=0` + `DEBUG_VISION_RAW_DUMP=true` + `OCR_PROMPT_VERSION=v2` 추가, 메모리 폭증 차단 | — | ✅ |

## 2. 검증된 효과

- **V2 효과 정성 확인** (v22): /crop 비전 모드 시험지 1부(테스트.pdf, 10문항) 결과 DOCX의 LaTeX가 정상 출력됨. `\vec{AE}`, `g'(x) = f(x) = |\sin x|`, `\cos\left(\frac{\pi}{2}\right)`, `\frac{3\pi}{2}` 등 정상. 운영 로그의 `\tim` 잘림 / `\begin{cases}` 미닫힘 패턴이 해설 출력에서 보이지 않음
- **단계 1 textbook dump 5건 분석** (v19): 어절 중간 줄바꿈이 OCR raw에서 이미 발생 확인. raw vs cleaned 4/5 동일 → `stripMetaWrappers`는 줄바꿈 손상 안 함
- **단계 2.5 + V2 조합 정상 작동** (v27): commit `de652ce` 후 시험지 4문항 재실행. **JSON 파싱 실패 1건 사라짐 ✅** + 풀이 LLM의 LaTeX 완결성 정성 확인 (`\overline{AC}`, `\int_{-2}^x f(t) dt`, `\begin{cases}...\end{cases}`, `\vec{AE} = \vec{AD} - \frac{1}{2}\vec{AB}`). **v25 Critical 가설(maxOutputTokens 누락이 잘림 원인) 확정**

## 3. 실패·미완료한 것 — **deprecated (v29 종결)**

| 항목 | 상태 | 원인 가설 |
|---|---|---|
| **dump 0개 회귀** (v22 → v27) | 미해결 | v27 진단으로 (a)/(c) 배제됨 — `.env.local DEBUG_VISION_RAW_DUMP=true` 정상 + `geminiVisionExtract.ts:334-335` ENV 판정 `/^(1\|true\|yes\|on)$/i` 정상. 남은 후보: (b) dev 재시작 미완 (Turbopack) / (d) `callGeminiVision` retry 분기 dump 누락. **진단 A+B 통합 1단계 사용자 측 실행 대기** |
| **DOCX 문제 본문 LaTeX 평문화** (v27 신규 발견) | 미해결 | 풀이 영역은 V2 정상 LaTeX인데 본문은 평문화 (`overlineAC`, `begincases`, `overrightarrowAE` 등). v27 초기 가설(Stage 2-0c docx/route.ts V2)이 prerequisite grep으로 **흔들림**: `ENABLE_DOCX_OCR` 미설정 → `OCR_ENABLED=false` → docx OCR 호출 안 됨. 평문화 출처가 (A) 풀이 LLM JSON 본문 필드 / (B) DOCX 빌더 별도 추출 / (C) 일반모드 OCR 중 어디인지 미확정. **진단 B 사용자 비전모드 ON/OFF 확인 후 grep 분기로 확정** |
| **시험지 v1 baseline dump 미확보** | 부분 해결 | v27 본문 4문항 V1 평문화 표가 baseline로 활용 가능. 별도 시험지 3회 수집 시간 절약 (v27 새 기회 #1) |
| **LaTeX 손상 패턴 카탈로그** | 미수집 | dump 정상화 후 단계 1.5에서 수집 |
| **thinkingBudget=0 풀이 품질 회귀 검증** | 미수행 | v26 주의 #2 A/B 비교 미진행. 운영 Railway 적용 결정 prerequisite |

## 4. 결정 이력 (왜 이렇게 정했는지) — **deprecated (v29 종결)**

| 결정 | 근거 |
|---|---|
| **C안 하이브리드 (프롬프트 V2 + 후처리 백업)** vs B/D안 | v21 확정. V2 효과로 raw baseline 끌어올림 + 잔여 패턴은 후처리. 회귀 시 ENV 빼면 즉시 V1 복귀 |
| **단일 ENV `OCR_PROMPT_VERSION=v2`로 양쪽(OCR+풀이 LLM) 토글** | 분기 단순화. helper `resolveOcrPromptVersion()` 공유 |
| **자동 재시도(단계 4) 보류** | 비용 폭증 리스크 (메모리 `project_gemini_fallback_cost_spike_20260509` 5만원 spike). 후처리(2-A/2-B)만으로 잡히면 4·4-0 둘 다 불필요 |
| **`noThinkingConfig` 헬퍼 재활용** (단계 2.5) | `photoEditGemini.ts:134`에 이미 구현. 새로 만들지 말 것 (메모리 `feedback_no_hallucination`). 단 grep 결과 export 안 됨 → v26에서 `geminiGenerationConfig.ts` 분리 권장 |
| **누적 비용 저장소: Supabase 채택** (KV/Upstash 비통합) | `@supabase/supabase-js@^2.105.1` + `pg@^8.20.0` 이미 통합, 신규 외부 서비스 도입 비용 회피 |
| **단계 1.5 sampling: 같은 시험지 1부 × 3회** (A안) | V1 baseline 분산 측정 우선, 데이터-드리븐 임계값(평균+2σ) 산정 |
| **mathmode 경계 안전 가드** (단계 2-A/2-B) | `(frac{` → `\frac{` 매핑이 mathmode 밖 텍스트 오작동 우려. `$...$` 경계 안에서만 적용 |

## 5. 막다른 길 (안 됨 확정) — **deprecated (v29 종결)**

- **textbook dump로 LaTeX 손상 패턴 카탈로그** — textbook 페이지(중수학 2-2 이등변삼각형 등)에 LaTeX 거의 없음. 시험지 dump로만 가능
- **autoPipeline 자동 재시도 확대** — 메모리 `feedback_llm_fallback_order` 룰: 싼→비싼 자동 진급 금지. 단계 4는 같은 모델 같은 단가만, 1회 한도
- **MCP `apply_migration` 사용** — 글로벌 deny. `migrations/NNNN_*_YYYYMMDD.sql` 작성 후 사용자가 SQL Editor 직접 실행
- **textbook-build-auto 자동 빌더 dev 활성화** — 1차 메모리 폭증 회귀. `TEXTBOOK_DRIVE_BUILD_INTERVAL_MS=0` 필수
- **driveAnalysisAutoSync dev 활성화** — 2차 메모리 폭증(303s에 rss 2.4GB). `DRIVE_ANALYSIS_AUTO_SYNC_MS=0` 필수

## 6. 흐름 매핑 (확정) — **deprecated (v29 종결)**

| # | 흐름 | 라우트 | V2 적용 |
|---|---|---|---|
| 1 | textbook 자동 빌더 | startup hook → `geminiVisionExtract.ts` | ✅ |
| 2 | /crop 일반 모드 | `/api/auto-pipeline` → `fileExtraction` → `geminiVisionExtract.ts` | ✅ |
| 3 | /crop 비전 모드 (풀이 LLM) | `/api/auto-pipeline/vision` (fetch 직접) | ✅ (`80caf02`) |
| 4 | DOCX 문제 본문 OCR | `/api/auto-pipeline/docx` (fetch 직접) | ❌ `OCR_EXTRACT_PROMPT` V1 잔존. **단 `ENABLE_DOCX_OCR=true`일 때만 실행** — 현재 .env.local에 미설정 → 호출 안 됨. v27 진단 B로 평문화 출처 확정 후 분기 |
| 5 | (의심) auto-pipeline 본체 | `/api/auto-pipeline/route.ts:146` generationConfig 발견 | ❓ — 진단 B에서 prompt 정체 확인 필요 |

## 7. v25→v26→v27 검토 진행 (적용·결정 누적) — **deprecated (v29 종결)**

### v25 발견 (v26에서 적용 완료)
- 🔴 **maxOutputTokens 누락 → 단계 2.5로 격상** — commit `de652ce`로 해결 ✅
- 🔴 **retrospective 자동피드백 모듈 이미 존재** — v26에서 단계 3·6.5·7 폐기 결정. 단계 10 (retrospective 카테고리 추가)으로 통합
- 🟠 plan 본문 line stale — v26 후 진입 시 grep으로 재확인 룰 채택
- 🟠 5번째 흐름 (`auto-pipeline/route.ts:146`) — 진단 B에서 확인

### v27 검토에서 신규 발견
- 🟠 **v27 초기 가설 정정** — Stage 2-0c (docx/route.ts V2)가 평문화 직접 원인이라는 가설이 prerequisite grep으로 흔들림. `ENABLE_DOCX_OCR=false` 확인. **검토자 권고 prerequisite 실행이 자기 가설 흔들림으로 이어진 사례** (`feedback_verify_user_claims_vs_system_state` 정합)
- 🟠 **진단 A+B 통합** — 사용자 1회 실행으로 dump 0개 + 평문화 출처 동시 진척 (검토자 v27 권고)
- 🟢 **v27 본문 4문항 baseline 활용** — 별도 단계 1.5 수집 시간 절약
- 🟢 **그림/그래프 능력 보유** — 사용자 메시지로 확인. 본 plan 범위 외, 단계 5/별도 plan에서 활용

## 8. 검토 라운드 종결 조건 체크 (메모리 `feedback_review_iteration_workflow` (b))

- v27 압축본 사용자 승인 완료 (2026-05-16)
- Critical 0건 (단계 2.5 commit으로 해소) + High 0건 (가설 정정 + 진단 통합으로 해소)
- 검토 라운드 timebox 도달 (v22~v27 5회) — **종결 → 진단 진입**

**판단**: 구현 검증 사이클 1회전 — 진단 A+B 통합 결과 보고 후 Stage 2-0c 분기 결정.
