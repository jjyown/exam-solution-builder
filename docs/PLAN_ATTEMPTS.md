# PLAN_ATTEMPTS — 해설제작 출력 깨짐 fix 작업 시도 누적

> 용도: plan과 별도. 검토 라운드 진행 시 plan과 함께 검토자에게 전달.
> 검토자가 "이미 시도된 X 또 제안" 헛질문 회피용.
> 메모리 룰: `feedback_review_iteration_workflow.md` (c)항.
>
> 갱신: 매 회차 종료 시 시도·결정·막다른 길 추가.

---

## 현 plan 회차: **v30 KaTeX fix 시리즈 종결** — 옵션 R rollback 완료 (HEAD = `b5b2957` Fix-W2c 안정). 5-시각-1/2 폐기. 후속 회차 보류.

### v30 회차 기록
- **단계 1** (`24bd4ca`): scale 1.3 — 수식 크기 200% → 130%
- **단계 2** (코드 변경 0건): 진단 grep — X1 (step.text raw push), X2 (explanationLatexToPlain 평문화 함수, 단 explanationLinesRaw 렌더에 미사용), X4 (page 4 텍스트는 정상 한국어 평문), X5 (page 2 questionImageDataUrl 미수신) 확정
- **단계 3 Fix-W1** (`f55aa03`): ImageRun width clamp (SINGLE_COLUMN 기준 비례 축소)
- **v30 라운드 2 회귀 발견**: 사용자 docx 검증 시 step.equation 멀티라인 → `$$..$$` wrapping이 line split으로 분리 → raw 텍스트 폴백 (`Wsqrt`/`Wfrac` 패턴). Fix-W1과 무관 — Fix-W2b 진입 예정
- **X5 폐기 결정 정정**: page 2 본문 평문화는 v29 F안의 회귀 (questionImageDataUrl 미수신). 신설 메모리 룰 `feedback_workaround_regression_no_rule` 정합 — 우회 후 회귀는 무조건 fix → Fix-X5 진단 진입 예정

이하 §3~§7은 v29 종결 시점 기록 — deprecated. v30 회차는 §1·§3에 추가.

## 1. 시도한 것 (완료)

| 회차 | 작업 | commit | 상태 |
|---|---|---|---|
| v18 | 단계 1: `geminiVisionExtract.ts` raw dump 추가 (`DEBUG_VISION_RAW_DUMP` ENV gate). textbook + /auto-pipeline 일반 모드 적용 | `83571de` | ✅ |
| v20 | 단계 1 보강: `vision/route.ts callGeminiVision` 응답 dump 추가 — 비전 모드 흐름 진단 | `df8c813` | ✅ |
| v21 | 단계 2-0a/2-0b: `KOREAN_EXAM_OCR_PROMPT_V2` + `KOREAN_TEXTBOOK_OCR_PROMPT_V2` + `VISION_PROMPT_V2` + `OCR_PROMPT_VERSION` ENV toggle + `resolveOcrPromptVersion()` helper | `80caf02` | ✅ |
| v26 | 단계 2.5: `src/lib/geminiGenerationConfig.ts` 신규 모듈 + `noThinkingConfig` + `isResponseTruncated`. vision/docx/auto-pipeline 3개 라우트 fetch body의 `generationConfig` 표준화. `[ocr_truncated]` 로그 + retrospective 자동 집계 | `de652ce` | ✅ |
| 안전 조치 | dev `.env.local`에 `TEXTBOOK_DRIVE_BUILD_INTERVAL_MS=0` + `DRIVE_ANALYSIS_AUTO_SYNC_MS=0` + `DEBUG_VISION_RAW_DUMP=true` + `OCR_PROMPT_VERSION=v2` 추가, 메모리 폭증 차단 | — | ✅ |
| v30 | **단계 1 scale 1.3** — `renderLatexToPng` 기본 scale 200% → 130% (수식 이미지 크기 균형) | `24bd4ca` | ✅ |
| v30 | **단계 2 진단 grep** — X1/X2/X4/X5 확정. step.text raw push, explanationLatexToPlain 렌더 미사용, page 4 텍스트는 정상 평문, page 2 questionImageDataUrl 미수신 | (코드 변경 0건) | ✅ |
| v30 | **Fix-W1 width clamp** — `latexAwareLineToParagraphChildren` ImageRun width SINGLE_COLUMN 기준 비례 축소 (큰 수식 양옆 잘림 방지) | `f55aa03` | ✅ |
| v30 라운드 3 | **Fix-W2b** — step.equation 멀티라인 `\n` → 공백 한 줄 join | `7eab984` | ⚠️ 부분 (raw 평문화 해소했으나 가로 잘림 회귀) |
| v30 라운드 4 | **Fix-W2c** — step.equation `\\` (LaTeX 줄바꿈) 기준 split → 라인별 별도 `$$..$$` PNG | `b5b2957` | ✅ — Railway docx 143759 검증 통과. **현 안정 HEAD** |
| v30 라운드 5 | **5-시각-1 minScale 0.6** + **5-시각-2 공백 텍스트 skip → CENTER alignment** — 시각 정리 시도 | `dcd3553` + `9a95c4b` | ❌ 화질 흐릿 회귀 (Railway docx 151035) → **옵션 R rollback 폐기** |
| v30 종결 | **옵션 R rollback** — `git reset --hard b5b2957` + `git push --force-with-lease`. 5-시각-1/2 origin/main 폐기. v30 KaTeX fix 시리즈 **종결** | (rollback) | ✅ |

## 2. 검증된 효과

- **V2 효과 정성 확인** (v22): /crop 비전 모드 시험지 1부(테스트.pdf, 10문항) 결과 DOCX의 LaTeX가 정상 출력됨. `\vec{AE}`, `g'(x) = f(x) = |\sin x|`, `\cos\left(\frac{\pi}{2}\right)`, `\frac{3\pi}{2}` 등 정상. 운영 로그의 `\tim` 잘림 / `\begin{cases}` 미닫힘 패턴이 해설 출력에서 보이지 않음
- **단계 1 textbook dump 5건 분석** (v19): 어절 중간 줄바꿈이 OCR raw에서 이미 발생 확인. raw vs cleaned 4/5 동일 → `stripMetaWrappers`는 줄바꿈 손상 안 함
- **단계 2.5 + V2 조합 정상 작동** (v27): commit `de652ce` 후 시험지 4문항 재실행. **JSON 파싱 실패 1건 사라짐 ✅** + 풀이 LLM의 LaTeX 완결성 정성 확인 (`\overline{AC}`, `\int_{-2}^x f(t) dt`, `\begin{cases}...\end{cases}`, `\vec{AE} = \vec{AD} - \frac{1}{2}\vec{AB}`). **v25 Critical 가설(maxOutputTokens 누락이 잘림 원인) 확정**

## 3. 미해결 (v30 KaTeX fix 종결 후)
- **"글자 크기 뒤죽박죽" 잔존** — 짧은 수식 원본 + 긴 수식 비례 축소로 페이지 내 글자 크기 2-3배 차이. **별도 회차 후보 (i)~(iv) 보류** — 사용자 가치 명시 후 결정 (검토자 추천 = (iv) 종결)
- **Fix-X5 진단** — page 2 questionImageDataUrl 미수신. `project_haeseol_workflow_intent` 룰 따라 우선순위 낮음
- **환경 깨짐 검증 deferred** — Fix-W2c 검증 시 표본 부족 (`\begin{cases}` 등 없음). 회귀 발견 시 안전망 1 rollback + Fix-W2d
- **단계 4·6·7·8·9 미진입** — 가시화 패널, 번호 충돌, 학년별 용어집

## 3-deprecated. 실패·미완료한 것 — **deprecated (v29 종결)**

| 항목 | 상태 | 원인 가설 |
|---|---|---|
| **dump 0개 회귀** (v22 → v27) | 미해결 | v27 진단으로 (a)/(c) 배제됨 — `.env.local DEBUG_VISION_RAW_DUMP=true` 정상 + `geminiVisionExtract.ts:334-335` ENV 판정 `/^(1\|true\|yes\|on)$/i` 정상. 남은 후보: (b) dev 재시작 미완 (Turbopack) / (d) `callGeminiVision` retry 분기 dump 누락. **진단 A+B 통합 1단계 사용자 측 실행 대기** |
| **DOCX 문제 본문 LaTeX 평문화** (v27 신규 발견) | 미해결 | 풀이 영역은 V2 정상 LaTeX인데 본문은 평문화 (`overlineAC`, `begincases`, `overrightarrowAE` 등). v27 초기 가설(Stage 2-0c docx/route.ts V2)이 prerequisite grep으로 **흔들림**: `ENABLE_DOCX_OCR` 미설정 → `OCR_ENABLED=false` → docx OCR 호출 안 됨. 평문화 출처가 (A) 풀이 LLM JSON 본문 필드 / (B) DOCX 빌더 별도 추출 / (C) 일반모드 OCR 중 어디인지 미확정. **진단 B 사용자 비전모드 ON/OFF 확인 후 grep 분기로 확정** |
| **시험지 v1 baseline dump 미확보** | 부분 해결 | v27 본문 4문항 V1 평문화 표가 baseline로 활용 가능. 별도 시험지 3회 수집 시간 절약 (v27 새 기회 #1) |
| **LaTeX 손상 패턴 카탈로그** | 미수집 | dump 정상화 후 단계 1.5에서 수집 |
| **thinkingBudget=0 풀이 품질 회귀 검증** | 미수행 | v26 주의 #2 A/B 비교 미진행. 운영 Railway 적용 결정 prerequisite |

## 4. v30 결정 이력
- **옵션 1-A (formatError throw 제거) 폐기** — `equationRenderer.ts:124-131` 이미 try/catch 후 `renderFallbackPng` 자동 호출. 사실관계 오류
- **Fix-W2 옵션 비교 → W2b → W2c** — W2a(줄마다 별도)는 환경 깨짐. W2b(한 줄 join)는 가로 잘림 회귀. W2c(`\\` split + Fix-W1 width clamp)가 검증 통과
- **v30 라운드 한도 초과** — 라운드 1~5 누적. 5-시각-1/2 회귀로 옵션 R rollback 결정 (검토자 명시 룰 예외 종료)
- **X5 폐기 → 무조건 fix 결정 정정** — v28 시점 "본문 평문화는 우선순위 아님"으로 X5 폐기했으나, v29 F안 도입 후에도 잔존 = 우회 회귀. 신설 메모리 룰 `feedback_workaround_regression_no_rule` 적용 → fix 정당화 (단 단계 5 후순위)
- **5-A (빠른정답 통합) 폐기** — 사용자 구조 의도 정정: "표지 → 문제 → break → 빠른정답 → break → 해설" 현 구조 유지
- **"글자 크기 뒤죽박죽" 후속 회차 후보** (즉시 진입 X, 사용자 가치 명시 후 결정):
  - (i) scale 통일 축소 (1.3 → 1.0) — 1줄 변경, 효과 명확
  - (ii) scale 동적 조정 — 복잡
  - (iii) MathJax linebreaks — extension 비추천
  - (iv) **KaTeX fix 종결** — 메모리 룰 정합 (검토자 추천)
- **검증 환경 = Railway production** — dev 거의 안 씀. git push 후 Railway 재빌드 → docx 재생성

## 4-deprecated. 결정 이력 (v29 종결 시점) — **deprecated**

| 결정 | 근거 |
|---|---|
| **C안 하이브리드 (프롬프트 V2 + 후처리 백업)** vs B/D안 | v21 확정. V2 효과로 raw baseline 끌어올림 + 잔여 패턴은 후처리. 회귀 시 ENV 빼면 즉시 V1 복귀 |
| **단일 ENV `OCR_PROMPT_VERSION=v2`로 양쪽(OCR+풀이 LLM) 토글** | 분기 단순화. helper `resolveOcrPromptVersion()` 공유 |
| **자동 재시도(단계 4) 보류** | 비용 폭증 리스크 (메모리 `project_gemini_fallback_cost_spike_20260509` 5만원 spike). 후처리(2-A/2-B)만으로 잡히면 4·4-0 둘 다 불필요 |
| **`noThinkingConfig` 헬퍼 재활용** (단계 2.5) | `photoEditGemini.ts:134`에 이미 구현. 새로 만들지 말 것 (메모리 `feedback_no_hallucination`). 단 grep 결과 export 안 됨 → v26에서 `geminiGenerationConfig.ts` 분리 권장 |
| **누적 비용 저장소: Supabase 채택** (KV/Upstash 비통합) | `@supabase/supabase-js@^2.105.1` + `pg@^8.20.0` 이미 통합, 신규 외부 서비스 도입 비용 회피 |
| **단계 1.5 sampling: 같은 시험지 1부 × 3회** (A안) | V1 baseline 분산 측정 우선, 데이터-드리븐 임계값(평균+2σ) 산정 |
| **mathmode 경계 안전 가드** (단계 2-A/2-B) | `(frac{` → `\frac{` 매핑이 mathmode 밖 텍스트 오작동 우려. `$...$` 경계 안에서만 적용 |

## 5. v30 막다른 길 (시도 누적)
- **옵션 1-A `formatError` throw 제거** — `equationRenderer.ts:124-131` 이미 fallback 존재. 작업 불필요
- **Fix-W2b 한 줄 join** (`7eab984`) — raw 평문화 해소했으나 가로 잘림 회귀 → Fix-W2c로 이행
- **5-A 빠른정답 통합** — 사용자 의도 = 현 구조 유지. 폐기
- **5-시각-1 minScale 0.6** (`dcd3553`) — 비트맵 다운샘플링 손실로 화질 흐릿. 옵션 R rollback
- **5-시각-2 가운데 정렬** (`9a95c4b`) — 효과 있었지만 5-시각-1 동반 폐기 (rollback 묶음)

## §6 신설 메모리 룰 (검토자 선처리, 2026-05-17~18)
- `feedback_prev_commit_rollback_safety_net.md` — Fix-W2c 안전망 첫 적용 사례
- `feedback_verify_env_explicit_local_vs_deploy.md` — Railway 검증 환경 명시
- `reference_academy_manager_live_url.md` (신설)
- `reference_haeseol_project.md` — 라이브 URL 추가

## 5-deprecated. 막다른 길 (v29 종결 시점) — **deprecated**

- **textbook dump로 LaTeX 손상 패턴 카탈로그** — textbook 페이지(중수학 2-2 이등변삼각형 등)에 LaTeX 거의 없음. 시험지 dump로만 가능
- **autoPipeline 자동 재시도 확대** — 메모리 `feedback_llm_fallback_order` 룰: 싼→비싼 자동 진급 금지. 단계 4는 같은 모델 같은 단가만, 1회 한도
- **MCP `apply_migration` 사용** — 글로벌 deny. `migrations/NNNN_*_YYYYMMDD.sql` 작성 후 사용자가 SQL Editor 직접 실행
- **textbook-build-auto 자동 빌더 dev 활성화** — 1차 메모리 폭증 회귀. `TEXTBOOK_DRIVE_BUILD_INTERVAL_MS=0` 필수
- **driveAnalysisAutoSync dev 활성화** — 2차 메모리 폭증(303s에 rss 2.4GB). `DRIVE_ANALYSIS_AUTO_SYNC_MS=0` 필수

## 6. v30 우선순위 표 (9단계 + 검토 진입 정책)

| 🔥 | 작업 | 작업량 | 검토 진입 |
|---|---|---|---|
| 🔴 1 | KaTeX fix 1.5순위 — 수식 이미지 크기 (scale 1.3) | 10분 ✅ | ❌ 생략 |
| 🔴 2 | KaTeX fix 진단 grep — X1/X2/X4/X5 | 1시간 ✅ | ✅ 필수 |
| 🔴 3 | KaTeX fix 원인 fix — Fix-W1 width clamp ✅ + Fix-W2b 멀티라인 join ⏳ | 1~2시간 | ✅ 필수 |
| 🔴 4 | 이슈 2 옵션 (a) — 피드백 가시화 패널 | 1~2시간 | 🟡 단순 UI |
| 🟠 5 | KaTeX fix 단계 4 — 페이지 활용 (cantSplit + 빠른정답 통합) | 1시간 | ✅ 진단 grep 필요 |
| 🟠 6 | KaTeX fix 단계 5 — 번호 충돌 (좌측 픽셀 자동 제외 A안) | 30분 | ❌ 사용자 합의 완료 |
| 🟡 7 | 이슈 1 Phase 1 — 학년별 용어집 추출 인프라 (중1 1교재 우선) | 4~5시간 | ✅ 비용 가드 + 학년 단계 |
| 🟡 8 | 이슈 1 Phase 2 — UI 통합 (기존 OCR 트리거 재사용) | 1~2시간 | 🟡 UI 재사용 |
| 🟡 9 | 이슈 1 Phase 3 — 옵션 (d) 검출 연동 | 1~2시간 | ✅ 검출 로직 |

→ 실제 검토 라운드 5회 (단계 2·3·5·7·9). 영역 분리로 누적 폭주 위험 낮음.

## 6-deprecated. 흐름 매핑 (v29 종결 시점) — **deprecated**

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
