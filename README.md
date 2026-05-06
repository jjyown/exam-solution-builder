# 하이로드 수학 해설지 제작기

문제 입력 → **자동 검색 · 생성 · 검증 · 재시도** → 해설 산출. Railway 배포로 어디서든 동작.

## 두 가지 동선

| 동선 | 진입점 | 용도 |
|---|---|---|
| **자동 파이프라인** (메인) | `/auto` | 문제 텍스트/이미지 → 즉시 해설 + 수동 검수 체크리스트 + 별점 피드백 |
| 크롭 풀 UI (보조) | `/legacy` | PDF 영역 지정·크롭, 묶음 생성, DOCX 일괄 출력 |

루트 `/`는 `/auto`로 자동 리다이렉트됩니다.

## 빠른 시작 (로컬)

```bash
npm install
cp .env.local.example .env.local
# 키 채우기 (GEMINI_API_KEY, OPENAI_API_KEY, Supabase URL/키)
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 접속.

## Railway 배포

1. **Repo 연결** — GitHub repo 연결 또는 `railway up`
2. **Variables** — `.env.example`의 값 복사:
   - `GEMINI_API_KEY`, `OPENAI_API_KEY` (필수)
   - `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (영속화 권장)
   - `EXPLANATION_CROSS_VERIFY=true` (자동 2차 검증)
3. **Supabase 테이블 생성** — Supabase SQL Editor에서:
   - `supabase/auto_pipeline_runs.sql` (자동 파이프라인 실행 이력)
   - `supabase/explanation_reviews.sql` (검수본 저장)
4. **빌드** — Railway가 `next build` → `next start` 자동 감지. `next.config.ts`의 `output: 'standalone'`으로 컨테이너 가벼움.
5. **헬스체크** — `https://<your-app>.railway.app/api/auto-pipeline` (GET) → `{ ok: true, kb_size: 53 }`

## 자동 파이프라인이 하는 일

```
입력 → ① 참고 예시 검색 (TF-IDF, KB 53개)
     → ② 프롬프트 조립 (few-shot)
     → ③ Gemini/OpenAI 호출
     → ④ 검증 (JSON·필드·LaTeX·단계 수)
     → ⑤ 실패 시 retryHint와 함께 자동 재시도 (최대 N회)
     → ⑥ Supabase 영속화 + 수동 검수 체크리스트 산출
     → ⑦ 사용자 별점·코멘트 → 다음 호출에 반영
```

이전 워크플로(Cursor 채팅에서 사람이 한 벌로 합치고 검수)를 코드 안의 자동 검증 + UI의 별점 피드백 루프로 대체했습니다. 자세한 설계는 [INTEGRATION.md](INTEGRATION.md).

## 환경변수 핵심

| 변수 | 용도 | 기본 |
|---|---|---|
| `GEMINI_API_KEY` | 1차 비전 풀이 | 필수 |
| `OPENAI_API_KEY` | 2차 교차검증·폴백 | 필수 |
| `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | 실행 이력·피드백 영속화 | 권장 |
| `EXPLANATION_CROSS_VERIFY` | 자동 2차 검증 활성화 | `true` |
| `NEXT_PUBLIC_UI_MODE=crop` | 크롭 전용 인스턴스로 띄울 때 | 빈값 |

전체 목록은 [.env.local.example](.env.local.example).

## 코드 위치

- 자동 파이프라인 코어: [src/lib/autoPipeline.ts](src/lib/autoPipeline.ts)
- 검증 + 재시도 힌트: [src/lib/explanationValidator.ts](src/lib/explanationValidator.ts)
- 검수 체크리스트 (Cursor 검수 대체): [src/lib/autoPipelineChecklist.ts](src/lib/autoPipelineChecklist.ts)
- Supabase 영속화: [src/lib/autoPipelineLog.ts](src/lib/autoPipelineLog.ts)
- 메인 UI: [src/app/auto/page.tsx](src/app/auto/page.tsx)
- API: [src/app/api/auto-pipeline/route.ts](src/app/api/auto-pipeline/route.ts), [src/app/api/auto-pipeline/feedback/route.ts](src/app/api/auto-pipeline/feedback/route.ts)
- DOCX 생성: [src/lib/examExplanationDocx.ts](src/lib/examExplanationDocx.ts)
- 레거시 풀 UI: [src/app/legacy/page.tsx](src/app/legacy/page.tsx)

## CLI 배치 (선택)

```bash
# 크롭 폴더 → 해설 DOCX 일괄
npm run batch:crops-to-docx -- --exam-name "2026 모의고사 1회"

# 초안만 (수동 검수 후 write-final-docx)
npm run batch:crops-drafts

# 검수 끝난 .md → 최종 DOCX
npm run write-final-docx -- --exam-name "..." --quick-answer "..." --body-file ./path.txt

# Supabase 키 점검
npm run check-supabase
```

## Cursor 잔재

이전 Cursor IDE + MCP 동선 파일은 [_archive/cursor-legacy/](_archive/cursor-legacy/) 에 보관 중입니다. 새 라인이 안정되면 통째로 삭제 가능.
