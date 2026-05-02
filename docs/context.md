# 하이로드 수학 해설지 제작기 — 컨텍스트 노트

- 문서 기준일: 2026-05-02

## 제품·운영 컨텍스트

- **대상 사용자**: 시험지 PDF/이미지에서 문항 영역을 나누고, LLM으로 해설을 생성한 뒤 DOCX로 내보내는 교육·출판 워크플로우
- **핵심 데이터**: 크롭 이미지(대기열), 생성된 해설 텍스트, 최종 DOCX 파일
- **운영 제약**: Gemini/OpenAI 키 필요; Drive는 **입력 폴더 읽기만**(최종 DOCX는 API로 Drive에 올리지 않음)

## 현재 구조 요약

- **프론트**: Next.js App Router, 메인 UI `src/app/page.tsx` (시험지·크롭·해설·내보내기)
- **API**: `generate-explanation`, `precheck-extraction`, `repair-explanations`, `save-result`, `exams`(+file), 등 — `src/app/api/`
- **로컬 산출**: 프로젝트 루트 `해설지 최종본/` (`src/lib/outputPaths.ts` 의 `FINAL_EXPLANATION_DIR_NAME`)
- **UI 모드**: `src/lib/uiMode.ts` — `NEXT_PUBLIC_UI_MODE=crop` 시 Railway 등에서 **크롭 전용**(해설·DOCX UI 숨김)

## 최근 의사결정 로그

| 날짜 | 결정 | 이유 | 영향 범위 |
|------|------|------|-----------|
| 2026-05-02 | Gemini 기본 모델을 **Flash-Lite 체인**으로 통일 | 크롭·배치 위주로 고가 Flash 불필요, 비용·지연 우선 | `geminiDefaultModels.ts`, generate/precheck/repair 라우트 |
| 2026-05-02 | 크롭 대기열 → **ZIP** → Drive **작업완료** (`POST /api/upload-crop-bundle`) | Railway/브라우저에서 자른 문항을 한 파일로 넘기는 운영 요구 | `googleDrive.ts`, `upload-crop-bundle/route.ts`, `page.tsx`, `.env.local.example` |
| 2026-05-02 | ZIP은 **클라이언트에서 생성**(jszip)·서버는 multipart 수신 | 대량 base64 JSON 본문 제한(413) 회피 | `page.tsx`, `jszip` |
| 2026-05-02 | `docs/` 에 `enterprise_workflow`, `context`, `plan`, `checklist` 도입 | academy_manager와 동일한 **기록 습관**으로 추적 가능하게 | `docs/*`, `PIPELINE.md` |
| 2026-05-02 | Railway 배포에 `NEXT_PUBLIC_UI_MODE=crop` 옵션 | 크롭만 하는 환경에서 해설 UI 노이즈 제거 | `src/lib/uiMode.ts`, `src/app/page.tsx`, `.env.local.example` |
| 2026-05-02 | 크롭 전용에서 필수 페이지 완료 시 **3단계로 자동 이동하지 않음** | 로컬 해설기와 역할 분리 | `page.tsx` `savePendingAsQueuedProblem` |
| 2026-05-02 | 크롭 모드 우측 패널에 **전체 페이지 대형 미리보기** | 좌측 스크롤 영역과 역할 분리해 가독성 확보 | `page.tsx` |
| (이전 합의) | 로컬 최종 DOCX 폴더명 **`해설지 최종본`** | `작업 완료`와 혼동 방지·이름 통일 | `outputPaths.ts`, `save-result`, `.gitignore`, 문서 |
| (이전 합의) | **DOCX는 Drive 업로드하지 않음** | Gemini API가 Drive에 쓰지 않음; 최종물은 로컬 책임 | `googleDrive.ts`, 파이프라인 문서 |

## 범위 밖·보류 (기록용)

- 크롭 대기열의 **서버 영속화** 또는 **ZIP 자동 생성·Drive 업로드**는 본 앱 UI에 아직 없음 — 필요 시 별도 작업 단위로 Gate A에서 범위 확정
- academy_manager 수준의 **pre-commit 문서 자동화**는 미도입
