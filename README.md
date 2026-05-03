# 하이로드 수학 해설지 제작기

로컬 Next.js 앱으로 **Gemini / OpenAI** 해설을 만들고 **`해설지 최종본` 폴더에 DOCX**를 저장합니다.

**해설집 품질을 최우선으로 할 때:** 먼저 [docs/BEST_QUALITY_WORKFLOW.md](docs/BEST_QUALITY_WORKFLOW.md)만 읽고 동선을 잡는 것을 권장합니다. (자동화·배치는 그 다음입니다.)

## 전체 동선(권장)

1. **Railway** — PDF에서 영역 지정·**크롭** → 묶음 생성 (`NEXT_PUBLIC_UI_MODE=crop` 이면 **크롭 전용 UI**)  
2. **Google Drive** — 그 묶음을 **입력용 폴더**에 저장(Railway 연동)  
3. **Cursor + 본 앱** — Cursor는 보조(프롬프트·검수), 앱에서 생성·배치·편집  
4. **로컬 `해설지 최종본`** — 최종 DOCX 저장. **이 폴더를 다른 PC로 복사**해도 같은 구조로 사용 가능  

자세한 동선·Drive(입력만): [docs/PIPELINE.md](docs/PIPELINE.md) — **DOCX는 Drive에 올리지 않고 로컬 `해설지 최종본`만 사용합니다.**

## 문서·기록 (academy_manager `docs` 패턴)

변경 작업 후에는 [docs/PIPELINE.md](docs/PIPELINE.md) 상단에 안내된 **문서 4종**(`enterprise_workflow`, `context`, `plan`, `checklist`)을 함께 갱신하는 것을 권장합니다.

## 기능 요약

- 시험지: 로컬 `시험지` / `exams` 또는 **Drive 입력 폴더** 연동(`.env.local`)
- PDF · 이미지 · 크롭 대기열 · 배치 해설
- 내보내기: 빠른 정답 + 2단 해설 DOCX
- 모델: [docs/models.md](docs/models.md)

## 실행

```bash
npm install
npm run dev
```

Windows: `실행.bat` · 브라우저 [http://localhost:3000](http://localhost:3000)  
`.env.local` 템플릿: `.env.local.example`

## 앱 안에서의 작업 순서(로컬)

1. `시험지`에 파일 두기(또는 Drive 연동 시 목록에서 선택)  
2. 파일 선택 → PDF면 페이지 이동  
3. 문항별 영역 저장 → 해설 대기열  
4. 배치/단건 생성 → 「해설 제작 (DOCX)」→ **`해설지 최종본`**

## 코드 위치

- UI: `src/app/page.tsx`
- 해설: `src/app/api/generate-explanation/route.ts`
- DOCX: `src/lib/examExplanationDocx.ts`
