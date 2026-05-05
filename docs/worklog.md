# 하이로드 수학 해설지 제작기 — 작업 로그

- 문서 기준일: 2026-05-05
- 목적: 작업 이력을 **무엇/언제/영향 범위** 중심으로 남겨, 누락 없이 추적한다.

## 최근 작업 요약 (역정리)

| 일시(로컬) | 작업 | 핵심 변경 | 영향 파일 |
|---|---|---|---|
| 2026-05-05 | 수식 볼드 + HML 양식 반영 보강 | OMML 수식 런을 bold 옵션으로 생성하도록 `docxOmmlBuilder`를 패치해 수식 박스 내 볼드 적용을 강화. 추가로 HML 양식(`Downloads.Zip`) 분석 후 문서 제목에서 선행 학생명 태그(`[홍길동]`) 자동 제거 로직 반영 | `src/lib/docxOmmlBuilder.ts`, `src/lib/examExplanationDocx.ts`, `tools/downloads_zip_extracted/*`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md` |
| 2026-05-05 | [문제] 원본 이미지 자동 삽입 복구 | `final:from-input`에서 입력 이미지(파일/ZIP+manifest)를 문항 순서로 수집해 workdir에 `문항XX_문제원본.*`으로 저장하고, 합본 `[문제]`에 `![문제 원본](...)`를 자동 주입. placeholder-only 문제를 완화 | `scripts/make-final-from-input.mts`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md` |
| 2026-05-05 | content gate 4차(부등식 체인 검증) | strict content gate에 `A<B<C`, `A<=B<=C` 등 체인 부등식 인접항 비교 검증 추가. 변수/한글/LaTeX 포함 줄 제외로 오탐 최소화. strict 스모크 통과 및 DOCX 생성 확인 | `scripts/make-final-from-input.mts`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md` |
| 2026-05-05 | content gate 3차(체인 등식 검증) | `A=B=C` 형태를 인접 항 비교로 검증하는 규칙 추가. 변수/한글/LaTeX 포함 줄 제외로 오탐 최소화. strict 스모크 재통과 및 DOCX 생성 확인 | `scripts/make-final-from-input.mts`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md` |
| 2026-05-05 | content gate 2차(단순 산술 등식 검증) | strict content gate에 숫자식 `lhs=rhs` 자동 계산 검증 추가(`+-*/`, 괄호, 소수). 변수/한글/LaTeX 포함 줄은 제외해 오탐을 줄임. strict 스모크 재통과 및 DOCX 생성 확인 | `scripts/make-final-from-input.mts`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md` |
| 2026-05-05 | 원클릭 content gate 추가(내용검수) | strict 모드에서 해설 길이/포기문구/해설 결론-정답 불일치를 치명 규칙으로 검사 후 실패 시 중단(exit 42). strict 스모크에서 통과 + DOCX 생성 확인 | `scripts/make-final-from-input.mts`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md` |
| 2026-05-05 | strict 모드 통과율 보강(수식 구분자 자동 교정) | `final:from-input` 합본 재작성 단계에서 `\\[...\\]`→`$$...$$`, `\\(...\\)`→`$...$`, 닫는 구분자 직전 마침표 제거를 적용. strict 모드 스모크에서 실제 DOCX 생성 성공 확인 | `scripts/make-final-from-input.mts`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md` |
| 2026-05-05 | 원클릭 파이프라인 전문가 합의 2차 반영 | `final:from-input` 기본값을 strict gate로 전환하고, 빠른 예외 모드 `--fast` 추가. 입력 폴더 사전검증·선택된 workdir 출력·게이트 모드 로그를 보강 | `scripts/make-final-from-input.mts`, `docs/AGENTIC_MD_PIPELINE.md`, `docs/obsidian-mcp/06_v2.1_전문가토의_운영스키마.md`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md` |
| 2026-05-05 | 파일 투입→최종본 원클릭 파이프라인 추가 | `final:from-input` 신설. `batch-crops-to-docx --drafts-only` 실행 후 최신 작업폴더를 자동 선택해 `write-final-docx`까지 연속 실행. 기본은 `--skip-structure-check`로 즉시 산출, 엄격 검수는 `--strict-gate` 옵션으로 분기 | `scripts/make-final-from-input.mts`, `package.json`, `docs/AGENTIC_MD_PIPELINE.md`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md` |
| 2026-05-05 | `check-api`에 Mathpix 연결 검사 추가 | `.env.local`의 `MATHPIX_APP_ID`/`KEY`로 v3/text 예제 URL 1회 호출, 키 미노출 | `scripts/check-api-connection.mts`, `docs/worklog.md` |
| 2026-05-05 | 문항·도형 자동 크롭(비전 검출) | Gemini로 페이지에서 stem+diagrams 정규화 박스 JSON 수신 → 기존 `pendingDiagramBoxes`와 동일 형식으로 채움. 번호 필터 `1,5,7-9`·2단은 세로 가이드로 열 클립. API `POST /api/detect-question-layout`, 파서 `parseQuestionNumbersSpec` | `src/app/api/detect-question-layout/route.ts`, `src/lib/parseQuestionNumbersSpec.ts`, `src/app/page.tsx`, `.env.local.example`, `README.md`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md`, `docs/obsidian-mcp/05_세션종합_다음작업_토의록.md` |
| 2026-05-05 | Mathpix OCR 연동(전문가 토의·구현) | v3 `/text`로 크롭→텍스트화 후 `questionText`로 Gemini에 전달. Next `/api/mathpix-text`(SHA256 파일 캐시), 배치 `--mathpix*` 옵션, MCP `mathpix_recognize`(엔트리 안정용 `mcp/mathpixClient.mts` 복제). `npm run build`·`mcp:smoke` 통과 | `src/lib/mathpixV3Text.ts`, `src/app/api/mathpix-text/route.ts`, `scripts/batch-crops-to-docx.mts`, `mcp/gemini-explanation.mts`, `mcp/mathpixClient.mts`, `.env.local.example`, `README.md`, `.gitignore`, `docs/worklog.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md`, `docs/obsidian-mcp/05_세션종합_다음작업_토의록.md` |
| 2026-05-05 | MCP vs `.cursorrules` 원리 문서·워크스페이스 규칙 반영 | MCP는 권한 지속, 자동 참조는 규칙 트리거 필요라는 합의를 `00_운영원칙`, `05`, `README`, `POST_WORK_DOCS`에 반영. 상위 워크스페이스 `.cursorrules` + `highroad-math-solution/.cursorrules`(하위 폴더만 열었을 때) 이중화 | `docs/obsidian-mcp/00_운영원칙.md`, `docs/obsidian-mcp/05_세션종합_다음작업_토의록.md`, `docs/obsidian-mcp/README.md`, `docs/POST_WORK_DOCS.md`, `docs/context.md`, `.cursorrules`(상위), `highroad-math-solution/.cursorrules` |
| 2026-05-05 | Obsidian·다음 세션용 핸드오프 문서 정리 | 채팅 이슈(DOCX 볼드·OMML·LaTeX 잔재·체크리스트)를 `05_세션종합_다음작업_토의록.md`에 일원화. `README` 권위 목록·6단계, `POST_WORK_DOCS` 선행 읽기 8행, `plan`/`checklist`/`context` 동기화 | `docs/obsidian-mcp/05_세션종합_다음작업_토의록.md`, `docs/obsidian-mcp/README.md`, `docs/POST_WORK_DOCS.md`, `docs/plan.md`, `docs/checklist.md`, `docs/context.md` |
| 2026-05-05 | gemini-gpt MCP 기동 오류 즉시 복구 | `gemini-explanation.mts`가 Next 라우트 모듈의 named export에 의존하며 런타임 번들에서 실패하던 문제를 제거. MCP 전용 시스템 프롬프트 빌더를 파일 내부로 내장해 기동 안정화. `mcp:smoke` 통과 확인 | `mcp/gemini-explanation.mts`, `scripts/mcp-stdio-smoke.mjs`(검증 실행) |
| 2026-05-04 | Obsidian MCP 권위 문서 세트 신설 + OpenAI/SequentialThinking 재검토 | 새 채팅 편차를 줄이기 위한 템플릿 5종을 `docs/obsidian-mcp/`에 추가. OpenAI strict 호출로 현재 환경 키 미설정을 확인하고, SequentialThinking으로 soft/strict 결합 전략 재검토 완료 | `docs/obsidian-mcp/*`, `scripts/build-markdown-assembly.mts` |
| 2026-05-04 | OpenAI preflight 자동 fallback 추가 | `build:md --preflight-openai` 실행 시 키/네트워크 오류가 나도 기본은 대체 리포트를 저장하고 계속 진행. 엄격 차단이 필요할 때만 `--preflight-openai-strict`로 중단 | `scripts/build-markdown-assembly.mts`, `docs/AGENTIC_MD_PIPELINE.md` |
| 2026-05-04 | 크롭 ZIP 문항 집계 안정화 + 내보내기 전 자동 검수 루프 적용 | `manifest.json`이 있으면 문항 본문 이미지(`items[].file`)만 배치 대상에 포함해 도형 이미지 오집계를 차단. TEST1은 문항별 검수 후 7문항으로 합본/내보내기 재생성 | `scripts/batch-crops-to-docx.mts`, `해설 작업중/[TEST]_TEST1.pdf_크롭묶음_2026-05-03T16-38-31.zip __ q1_PDF_1p.png/*`, `해설지 최종본/[TEST]_TEST1.pdf_크롭묶음_2026-05-03T16-38-31.zip __ q1_PDF_1p_해설_20260504_233323.docx` |
| 2026-05-04 | Agentic 합본 파이프라인 도입 | `build:md`에 python 펜스 실행, OpenAI preflight, 엄격 헤더 검수, docx 연계 옵션 추가 | `scripts/build-markdown-assembly.mts`, `scripts/validate-format.mts`, `src/lib/explanationPythonGraphRunner.ts`, `src/lib/openaiExportPreflight.ts`, `docs/AGENTIC_MD_PIPELINE.md` |
| 2026-05-04 | OpenAI 비용/품질 하이브리드 라우팅 | `solver-profile`별 easy mini / balanced·killer 상위 모델 분기, preflight 기본 mini 분리 | `src/app/api/generate-explanation/route.ts`, `src/lib/openaiExportPreflight.ts`, `docs/models.md`, `.env.local.example` |
| 2026-05-04 | Supabase 자동 업로드 개선 | `upload-to-supabase`에 `--watch`, `upload-solutions:watch` 스크립트 추가 | `scripts/upload-to-supabase.mts`, `package.json` |
| 2026-05-04 | Cursor 저장 후 자동 업로드 훅 | `해설 작업중/<시험>/...md` 저장 시 해당 시험만 Supabase 업로드 트리거 | `.cursor/hooks.json`, `.cursor/hooks/auto-upload-supabase-after-edit.mjs` |
| 2026-05-04 | 합본 미리보기 지연 로딩 | 목록은 `listOnly=1`, 본문은 선택 시 `id` 단건 로드로 합본 멈춤 완화 | `src/components/examSolutionReview/CropExamSolutionsPreviewPanel.tsx` |
| 2026-05-04 | Supabase 일괄 삭제 기능 | 필터(`exam_name`) 기준 “모두 삭제” + 확인창 1회 + API bulk delete | `src/components/examSolutionReview/CropExamSolutionsPreviewPanel.tsx`, `src/app/api/exam-solutions/route.ts` |
| 2026-05-04 | DOCX 수식 렌더/잔재 정리 및 페이지 잘림 방지 강화 | OMML 수식 유지, `quad/Rightarrow/Leftrightarrow` 잔재 정리, 긴 문제 블록은 문항 시작 전 강제 페이지 넘김 추가 | `src/lib/docxOmmlBuilder.ts`, `src/lib/latexToPlainText.ts`, `src/lib/explanationExportGate.ts`, `src/lib/examExplanationDocx.ts`, `해설 작업중/[TEST] TEST1.pdf/합본_편집용.md` |

---

## 자동 로그 규칙

- Cursor 훅(`afterAgentResponse`)이 실행될 때, 코드 변경이 있으면 `docs/worklog.md` 하단에 자동 항목을 추가한다.
- 자동 항목은 중복 방지를 위해 동일 변경 집합에서는 반복 기록하지 않는다.
- 운영자는 PR/릴리즈 전 `context.md`, `plan.md`, `checklist.md`도 함께 맞춘다.