# Railway 배포 가이드

이미 GitHub repo `exam-solution-builder`가 연결되어 있어, Railway에 한 번만 연결하면 그 후 push 마다 자동 재배포됩니다.

## 1회만 — 초기 셋업

### 1. 변경사항 commit + push (로컬에서)

```bash
cd highroad-math-solution

git add .
git commit -m "feat: Cursor 잔재 정리 + 자동 파이프라인 + 다중 문항 지원"
git push origin main
```

### 2. Supabase 테이블 생성 (Dashboard → SQL Editor)

다음 파일 내용을 SQL Editor에 붙여넣고 Run:
- `supabase/auto_pipeline_runs.sql` — 자동 파이프라인 실행 이력 (필수)
- `supabase/explanation_reviews.sql` — 검수본 저장 (선택)
- `supabase/exam_solutions.sql` — 솔루션 업로드 (선택, 기존 워크플로 사용 시)

확인:
```bash
npx tsx scripts/smoke-supabase-check.mts
# → ✓ auto_pipeline_runs 테이블 사용 가능 (probe id …)
```

### 3. Railway 프로젝트 생성

[railway.com](https://railway.com) 로그인 → **New Project** → **Deploy from GitHub repo** → `jjyown/exam-solution-builder` 선택.

Railway가 자동 감지:
- Nixpacks 빌더로 Next.js 인식
- `railway.json` 의 빌드/시작/헬스체크 설정 적용
- `output: 'standalone'` (`next.config.ts`)으로 컨테이너 가벼움

### 4. Variables 등록 (Railway 프로젝트 → Variables 탭)

| 키 | 값 |
|---|---|
| `GEMINI_API_KEY` | `.env.local`의 값 그대로 |
| `OPENAI_API_KEY` | `.env.local`의 값 그대로 |
| `NEXT_PUBLIC_SUPABASE_URL` | `.env.local`의 값 그대로 |
| `SUPABASE_SERVICE_ROLE_KEY` | `.env.local`의 값 그대로 |
| `EXPLANATION_CROSS_VERIFY` | `true` |
| `MATHPIX_APP_ID` (선택) | 이미지 OCR 쓸 거면 |
| `MATHPIX_APP_KEY` (선택) | 〃 |

전체 환경변수 옵션은 [.env.local.example](.env.local.example) 참고.

### 5. Generate Domain

Railway 프로젝트 → **Settings** → **Networking** → **Generate Domain** → `<my-app>.up.railway.app` 발급.

## 검증

### 헬스체크

```bash
curl https://<my-app>.up.railway.app/api/auto-pipeline
# → {"ok":true,"kb_size":53}
```

### 메인 페이지

브라우저로 `https://<my-app>.up.railway.app/` 접속 → `/auto`로 자동 리다이렉트 → 문제 입력 + 「실행」 → 결과·trace·체크리스트 확인.

### Supabase 영속화 확인

`/auto` 페이지에서 「최근 이력 열기」 → 방금 실행한 row 표시되면 성공.

## 일상 운영

- **코드 수정 후 배포**: `git push origin main` — Railway가 자동 빌드·재배포 (1~3분)
- **롤백**: Railway Deployments 탭 → 이전 deployment에서 **Redeploy**
- **로그**: Railway 프로젝트 → Deployments → 해당 deployment 클릭 → 실시간 로그
- **환경변수 변경**: Variables 탭에서 수정 후 Railway가 자동 재시작

## 트러블슈팅

| 증상 | 원인 / 조치 |
|---|---|
| 헬스체크 실패 (`kb_size: 0`) | `reference/kb.jsonl`이 git에 안 올라간 경우 — `.gitignore` 확인 |
| `runId: null` + `persistError: schema cache` | Supabase 테이블 미생성 — 위 2단계 SQL 실행 |
| `GEMINI_API_KEY 미설정` | Variables 탭 확인 + Redeploy |
| 빌드는 되는데 `/auto` 빈 화면 | 브라우저 콘솔 확인 — 보통 Hydration error. 로컬 `npm run build && npm run start`로 재현 |
| 큰 PDF 업로드 시 413 | 현재 1MB 한도 — 묶음 3에서 multipart 전환 예정 |

## 빌드 산출물

- `/api/auto-pipeline` (POST/GET) — 메인 파이프라인 + 헬스체크
- `/api/auto-pipeline/feedback` (POST/GET) — 별점·메모·이력
- `/auto` — 메인 UI
- `/legacy` — 구 풀 UI (보조)
- `/` → `/auto` 리다이렉트
- 그 외 17개 API/페이지 (build 출력 참고)
