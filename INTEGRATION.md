# 자동 해설 라인 — 설계 메모

이 문서는 "Cursor 채팅이 사람을 거쳐 검수하던 동선"을 어떻게 코드 안으로 흡수했는지 정리한 것이다.
운영 시작점은 [README.md](README.md), 환경 변수는 [.env.local.example](.env.local.example).

## 이전 동선 vs 현재 동선

| 단계 | 이전 (Cursor) | 현재 (Railway 자동 라인) |
|---|---|---|
| 1차 풀이 | MCP `generate_math_explanation` (Gemini) | `/api/auto-pipeline` POST → autoPipeline.ts |
| 형식·정답 검증 | Cursor 채팅에서 사람이 확인 | `explanationValidator.ts` (V1~V6 자동) |
| 2차 교차검증 | Cursor가 OpenAI 도구를 다시 호출 | `EXPLANATION_CROSS_VERIFY=true` 자동 |
| 재시도 | 사람이 다시 호출 | autoPipeline 루프가 retryHint로 자동 재시도 |
| 검수 체크리스트 | postToolUse 훅이 채팅에 주입 | 응답의 `manualReviewChecklist[]` (UI 표시) |
| 결과 저장 | 사람이 .md 파일로 저장 | Supabase `auto_pipeline_runs` 테이블 |
| 피드백 | 채팅 메모 (휘발성) | 별점 + 코멘트, runId에 영속 |

## 구성 요소

```
src/
├── lib/
│   ├── autoPipeline.ts            ← retrieve → generate → validate → retry 루프
│   ├── autoPipelineChecklist.ts   ← Cursor 「중재 검수 체크리스트」를 코드로
│   ├── autoPipelineLog.ts         ← Supabase insert/update/list
│   ├── explanationValidator.ts    ← V1~V6 자동 검증 + retryHint 생성
│   ├── promptBuilder.ts           ← few-shot 프롬프트 조립
│   ├── referenceRetriever.ts      ← TF-IDF 검색 (KB 53개)
│   └── supabaseServiceClient.ts   ← service role 클라이언트
└── app/
    ├── auto/page.tsx              ← 메인 UI (Railway 진입점)
    ├── api/auto-pipeline/route.ts ← POST 자동 실행, GET 헬스체크
    └── api/auto-pipeline/feedback/route.ts ← POST 별점·메모 저장, GET 이력 조회
```

## "Cursor가 하던 일" 흡수 매핑

### 1. 근사·회피 표현 거르기 (`autoPipelineChecklist.ts`)

이전: 사람이 채팅에서 "≈, 어림, 가장 가까운" 같은 표현을 발견하면 재요청.

현재: `APPROX_PATTERNS` 정규식이 자동 검사 → `manualReviewChecklist`에 항목으로 추가 → UI에 노란 박스로 노출. 사용자는 「재시도」 버튼 한 번으로 재호출.

### 2. 객관식 보기 번호 일치 (`autoPipelineChecklist.ts`)

이전: 사람이 풀이의 ①~⑤와 정답란이 일치하는지 확인.

현재: 풀이 텍스트에 보기 마커가 있는데 `answer` 필드엔 숫자/식만 있으면 체크리스트에 자동 추가.

### 3. raw LaTeX 잔재 (`explanationValidator.ts` V6)

이전: Cursor에서 `\frac`, `\theta` 같은 평문 노출을 발견하면 재호출.

현재: 검증기 V6가 `RAW_LATEX_PATTERNS`로 평문/equation 분리 위반을 잡고, retryHint에 "수식은 equation 필드로 분리하라"를 포함해 자동 재시도.

### 4. 자동 2차 교차검증 (`/api/generate-explanation` `EXPLANATION_CROSS_VERIFY`)

이전: 사람이 Gemini 결과 받고 OpenAI 도구를 다시 호출.

현재: 환경변수 `true`면 1차 통과 후 OpenAI 모델로 자동 검산. 결과 불일치 시 `progressReport.phases.phase2_crossVerify.detail`에 사유 기록.

### 5. 영속 피드백 루프 (`auto_pipeline_runs` 테이블 + Feedback API)

이전: Cursor 채팅 종료 시 휘발. 어떤 문제에 어떤 풀이가 통했는지 추적 불가.

현재: 모든 실행이 Supabase에 저장. 별점 1~5 + 자유 메모를 `user_rating`/`user_feedback` 컬럼에 업데이트. 시간이 지나면 어떤 프롬프트/모델 조합이 좋았는지 SQL로 조회 가능.

## 운영 팁

- **Supabase 미설정 환경**도 동작 — 모든 영속화 호출이 조용히 무시되고 메모리만 사용.
- **Crop 전용 인스턴스**(시험 입력만 받는 페이지)를 띄우려면 `NEXT_PUBLIC_UI_MODE=crop`. 이 경우 `/legacy`로 직접 가야 풀 UI가 보임.
- **로컬 DOCX 생성**은 여전히 `npm run write-final-docx` CLI로 가능 — Railway 인스턴스에서는 `auto_pipeline_runs.final_body`를 가져와 같은 빌더로 변환 가능.

## 다음 단단계 (필요 시)

1. **`/auto`에서 PDF/이미지 업로드** — 현재는 텍스트 입력만. `/api/mathpix-text` 어댑터 붙이면 즉시 가능.
2. **DOCX 한 번에** — `/auto` 우측에 "DOCX 다운로드" 버튼 (`/api/save-result`로 라우팅).
3. **별점 통계** — `auto_pipeline_runs` 집계로 모델·프로필별 만족도 그래프.
4. **임베딩 검색** — KB가 1,000개 넘기면 TF-IDF → OpenAI embedding.
