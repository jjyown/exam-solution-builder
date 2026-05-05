# 하이로드 수학 해설지 제작기 — 컨텍스트 노트

- 문서 기준일: 2026-05-05

## 제품·운영 컨텍스트

- **현재 최우선 목표**: **상용화·확장보다 결과물 품질** — 해설·DOCX가 **원장님이 낼 수 있는 한 가장 완성도 있게** 나오는지에 집중. (AI는 100% 보장 불가, 중재·교차검증·참고 족보로 근접.)
- **확장 목표(상한)**: **일반 상용 서비스가 아님.** 커지더라도 **학원 원생·내부용으로 오픈하는 정도**가 상한 — 멀티테넌트 SaaS·전국 공개 앱 수준의 필수 과제(Supabase 전면 이식, 큐 워커 등)는 **필수 아님**.
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
| 2026-05-05 | DOCX 수식은 OMML 내부 런 자체를 bold로 생성해 수식 박스 내 굵기 체감을 우선 개선한다 | 사용자 피드백이 “Ctrl+B 전/후 차이”에 집중되어 있어 평문화 우회보다 OMML 런 bold 적용이 직접적 대응임 | `src/lib/docxOmmlBuilder.ts` |
| 2026-05-05 | 외부 HML 양식에서 선행 학생명 태그(`[이름]`)는 출력 제목에서 제거하고 내용 규칙만 반영한다 | 사용자 요청: 수학비서 양식 적용 시 학생 이름은 제외하고 서식/내용만 채택 | `src/lib/examExplanationDocx.ts`, `tools/downloads_zip_extracted/*` |
| 2026-05-05 | 원클릭 합본 `[문제]`에는 placeholder 문장 대신 원본 문항 이미지 링크를 기본 주입한다 | 사용자 피드백에서 가장 큰 불만이 `[문제]` 누락이었고, 이미지 주입은 즉시 품질 체감을 개선함 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | content gate 4차로 부등식 체인(`A<B<C`, `A<=B<=C`) 검증을 strict에 추가한다 | 전문가 토의 합의: 숫자식 상수 체인만 검증하면 오탐을 낮추고 단계식 부등식 오류를 차단할 수 있음 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | content gate 3차로 체인 등식(`A=B=C`) 검증을 strict에 추가한다 | 전문가 토의 합의: 숫자식 체인만 비교하면 저비용으로 명백한 단계식 불일치를 차단할 수 있음 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | content gate 2차로 단순 산술 등식 자동검증(`lhs=rhs`)을 strict에 추가한다 | 전문가 토의 합의: 변수 없는 숫자식만 검사하면 오탐을 낮추면서 명백한 계산 오류를 사전 차단할 수 있음 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | strict 모드에 content gate(내용검수)를 추가해 형식 통과 후에도 치명 품질 리스크(포기문구, 결론-정답 불일치, 과소 해설)를 차단한다 | 전문가 토의 합의: 오탐 낮은 규칙 기반 게이트를 먼저 적용하고, 고위험 문항의 자동 통과를 방지한다 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | strict 기본 운용에서 실패를 줄이기 위해 합본 재작성 시 수식 구분자 자동 정규화(`\\[\\]`,`\\(\\)`)를 적용한다 | 전문가 토의 합의: 최소 침습 정규화는 안전하고 strict 통과율을 실질적으로 높임 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | 원클릭(`final:from-input`)은 strict gate를 기본값으로 고정하고, 예외적으로 즉시 산출이 필요할 때만 `--fast`를 허용한다 | 전문가 토의 합의: 자동화 목표를 유지하면서도 품질 사고를 줄이려면 기본은 차단형 게이트가 필요함 | `scripts/make-final-from-input.mts`, `docs/AGENTIC_MD_PIPELINE.md`, `docs/obsidian-mcp/06_v2.1_전문가토의_운영스키마.md` |
| 2026-05-05 | 운영 기본 동선을 `파일 투입 -> 초안 생성 -> 최종 DOCX 자동 생성`의 단일 엔트리로 고정하고, 기본은 즉시 산출 모드(`--skip-structure-check`)를 사용한다. 엄격 검수는 `--strict-gate`로 분기한다 | 사용자 운영 목표가 "파일 넣고 해설지 최종본 바로 생성"이므로, 중간 수동 호출을 제거해 실행 단순성을 우선한다 | `scripts/make-final-from-input.mts`, `package.json`, `docs/AGENTIC_MD_PIPELINE.md` |
| 2026-05-05 | 자동 크롭은 **비전 JSON 박스 → 기존 수동 크롭 파이프라인**으로만 연결한다. 모델이 틀릴 수 있으므로 저장 전 육안 확인을 전제로 한다 | 전문가 토의: 레이아웃 CV 전면 도입 대신 Gemini로 stem/diagrams 정규화 좌표를 받아 `DiagramBox`를 채운다. 2단은 세로 가이드로 열 교차 클립 | `src/app/api/detect-question-layout/route.ts`, `src/app/page.tsx`, `src/lib/parseQuestionNumbersSpec.ts` |
| 2026-05-05 | Mathpix는 **OCR·수식 텍스트화 계층**으로만 쓰고, 해설 생성·DOCX 게이트는 기존 LLM·export 경로를 유지한다 | 전문가 토의: Mathpix가 풀이까지 대체하면 실패·형식 이슈가 섞이기 쉬움. `questionText` 보강 + 이미지 우선 지시로 판독 안정화만 담당 | `src/lib/mathpixV3Text.ts`, `src/app/api/mathpix-text/route.ts`, `scripts/batch-crops-to-docx.mts`, MCP `mathpix_recognize`, `mcp/mathpixClient.mts` |
| 2026-05-05 | MCP 연결 유지 ≠ 자동 참조. “항상 권위 문서를 읽는다”는 **워크스페이스 `.cursorrules` + `docs/obsidian-mcp/00` 설명**으로 트리거를 고정한다 | 옵시디언 MCP는 권한(열쇠)이고, `.cursorrules`는 실행(방아쇠)이라는 사용자 정리를 레포 전제에 반영. 워크스페이스가 `highroad-math-solution`만일 때를 위해 **동일 트리거를 하위 `.cursorrules`**에도 둔다 | `.cursorrules`(상위 워크스페이스 루트), `highroad-math-solution/.cursorrules`, `docs/obsidian-mcp/00_운영원칙.md`, `docs/obsidian-mcp/README.md`, `docs/obsidian-mcp/05_세션종합_다음작업_토의록.md`, `docs/POST_WORK_DOCS.md` |
| 2026-05-05 | 채팅·이슈 합의는 `docs/obsidian-mcp/05_세션종합_다음작업_토의록.md`에 고정하고, `README` 권장 순서에 6단계(세션 종료 체크리스트)로 연결한다 | 새 채팅·인수인계 시 DOCX 수식·볼드·LaTeX 잔재 논의가 반복되는 비용을 줄이기 위함 | `docs/obsidian-mcp/05_세션종합_다음작업_토의록.md`, `docs/obsidian-mcp/README.md`, `docs/POST_WORK_DOCS.md` |
| 2026-05-05 | MCP 서버(`gemini-gpt`)는 Next 라우트 export에 직접 의존하지 않고, MCP 엔트리 내 로컬 시스템 프롬프트 빌더를 사용한다 | 런타임 번들/모듈 해석 차이로 named export가 깨질 때 서버가 즉시 죽는 문제를 방지하기 위함 | `mcp/gemini-explanation.mts` |
| 2026-05-04 | Obsidian MCP는 “권위 문서 세트(운영원칙/프롬프트/체크리스트/실패사전/최종게이트)”를 고정 참조하는 방식으로 사용한다 | 새 채팅마다 프롬프트 편차가 발생하는 문제를 문서 고정 참조로 줄이기 위함 | `docs/obsidian-mcp/*` |
| 2026-05-04 | OpenAI preflight를 “기본 soft-fail + strict 옵션”으로 분리한다 (`--preflight-openai`/`--preflight-openai-strict`) | 원장님이 일일이 키 상태를 확인하지 않아도 파이프라인이 멈추지 않게 하고, 필요한 경우만 엄격 차단을 선택하기 위함 | `scripts/build-markdown-assembly.mts`, `docs/AGENTIC_MD_PIPELINE.md` |
| 2026-05-04 | 크롭 ZIP에 `manifest.json`이 있으면 `items[].file`만 문항 배치 대상으로 채택하고, `*_fig*.png` 등 도형 파일은 문항 집계에서 제외한다 | 도형 이미지가 문항으로 잘못 카운트되어 문항 수/해설 매핑이 어긋나는 재발 이슈 차단 | `scripts/batch-crops-to-docx.mts` |
| 2026-05-04 | DOCX 품질에서 “수식 모양 보존(OMML) > 강제 굵기” 우선순위를 확정하고, LaTeX 잔재 토큰(`quad/Rightarrow/Leftrightarrow`)은 변환·경고로 제거한다 | 수식을 평문화하면 모양이 깨지고, 그대로 두면 잔재 텍스트가 남는 문제가 반복됨 | `src/lib/docxOmmlBuilder.ts`, `src/lib/latexToPlainText.ts`, `src/lib/explanationExportGate.ts`, `src/lib/examExplanationDocx.ts` |
| 2026-05-04 | 긴 문제 블록은 페이지 하단에서 잘림이 예상되면 문항 시작 전에 강제 페이지 넘김을 삽입한다 | HML 유사 배치 요구 + 문제 단위 가독성 확보 | `src/lib/examExplanationDocx.ts` |
| 2026-05-04 | 작업 이력 누락 방지를 위해 `docs/worklog.md`를 정식 로그로 추가하고, Cursor `afterAgentResponse` 훅으로 자동 누적 기록을 남긴다 | “무엇/언제/영향 파일” 추적 공백 해소, 회고·인수인계 비용 절감 | `.cursor/hooks.json`, `.cursor/hooks/auto-docs-worklog-after-response.mjs`, `docs/worklog.md`, `docs/POST_WORK_DOCS.md` |
| 2026-05-04 | Supabase 미리보기 합본 지연은 목록 단계에서 본문 전체 로드(`listOnly=0`) + KaTeX 렌더 중첩이 주원인으로 판정, **선택 시 단건 본문 로드**로 전환 | 합본 클릭 멈춤 체감 완화(초기 payload/렌더 부하 절감) | `src/components/examSolutionReview/CropExamSolutionsPreviewPanel.tsx`, `src/app/api/exam-solutions/route.ts` |
| 2026-05-04 | Supabase 미리보기에 “모두 삭제(확인창 1회)”를 추가하고 API는 `examName` 기준 bulk delete를 지원한다 | 문항별 반복 삭제 운영 부담이 큼 | `src/components/examSolutionReview/CropExamSolutionsPreviewPanel.tsx`, `src/app/api/exam-solutions/route.ts` |
| 2026-05-04 | Agentic 합본 파이프라인: python 그래프 실행·OpenAI preflight·엄격 헤더 검수 옵션을 도입 | 해설 품질 검수와 최종 DOCX 이전 점검을 자동화 | `scripts/build-markdown-assembly.mts`, `scripts/validate-format.mts`, `src/lib/explanationPythonGraphRunner.ts`, `src/lib/openaiExportPreflight.ts`, `docs/AGENTIC_MD_PIPELINE.md` |
| 2026-05-04 | OpenAI **종량제·하이브리드 라우팅**: `solver-profile`별 교차검증·Gemini 실패 시 폴백 모델 분리(easy→mini 기본, killer→4o 기본); easy 검증은 공통 `OPENAI_MODEL_CROSS_VERIFY`만으로는 4o를 쓰지 않음 | 원장님 비용·체감 요금 논의 반영, 공식 요금표는 시점별 변동 → 문서에 링크·감만 기술 | `generate-explanation/route.ts`, `docs/models.md`, `.env.local.example` |
| 2026-05-03 | MCP 도구에 **`imageBase64`/`imageMimeType`** 추가 — 크롭 이미지 비전 풀이 후 Cursor가 참고용 대수 등으로 검수 | 구 MCP는 텍스트만 가능했음 | `mcp/gemini-explanation.mts`, `CURSOR_MCP_WORKFLOW.md` |
| 2026-05-03 | **`batch:crops-to-docx` 기본은 API→DOCX 직행**(MCP·중재 없음). 품질 동선은 **`--drafts-only`** 또는 문항별 MCP | 혼동 방지·`해설 작업중/` 초안 저장 | `batch-crops-to-docx.mts`, 문서 |
| 2026-05-03 | **주 동선: MCP 해설 + Cursor 중재** | 틀(DOCX·`[문항]`/`[정답]`/`[해설]`)은 **대략** 맞추면 되고, **해설 내용**을 좋게 하는 데 집중 | [CURSOR_MCP_WORKFLOW.md](./CURSOR_MCP_WORKFLOW.md), 배치는 보조 |
| 2026-05-02 | **우선순위: 결과 품질·완성도** — 상용화·인프라 확장은 뒤로 | 원장님 운영 목표와 일치 | 기획·테스트·중재 동선 |
| 2026-05-02 | 제품 상한: **상용 일반 공개 아님**, 최대 **학원 원생·내부 오픈** 수준 | 제미나이 등에서 제시된 Supabase 전면화·비동기 큐는 **선택**이며 우선순위를 과대평가하지 않음 | 본 문서·기능 범위 논의 |
| 2026-05-02 | **Gemini 1차 → OpenAI 2차(선택) → Cursor+원장님이 두 출력 중재(반복 가능) → 해설지 최종본** | 두 모델 답이 항상 같지 않음. API는 `EXPLANATION_CROSS_VERIFY`로 2차 지원하나 **충돌 해결·최종 한 벌 확정은 중재** | `PIPELINE.md`, `models.md`, `CURSOR_MCP_WORKFLOW.md`, `.env.local` |
| 2026-05-02 | Gemini 기본 모델을 **Flash-Lite 체인**으로 통일 | 크롭·배치 위주로 고가 Flash 불필요, 비용·지연 우선 | `geminiDefaultModels.ts`, generate/precheck/repair 라우트 |
| 2026-05-02 | 크롭 대기열 → **ZIP** → Drive **작업완료** (`POST /api/upload-crop-bundle`) | Railway/브라우저에서 자른 문항을 한 파일로 넘기는 운영 요구 | `googleDrive.ts`, `upload-crop-bundle/route.ts`, `page.tsx`, `.env.local.example` |
| 2026-05-02 | ZIP은 **클라이언트에서 생성**(jszip)·서버는 multipart 수신 | 대량 base64 JSON 본문 제한(413) 회피 | `page.tsx`, `jszip` |
| 2026-05-02 | `docs/` 에 `enterprise_workflow`, `context`, `plan`, `checklist` 도입 | academy_manager와 동일한 **기록 습관**으로 추적 가능하게 | `docs/*`, `PIPELINE.md` |
| 2026-05-02 | Railway 배포에 `NEXT_PUBLIC_UI_MODE=crop` 옵션 | 크롭만 하는 환경에서 해설 UI 노이즈 제거 | `src/lib/uiMode.ts`, `src/app/page.tsx`, `.env.local.example` |
| 2026-05-02 | 크롭 전용에서 필수 페이지 완료 시 **3단계로 자동 이동하지 않음** | 로컬 해설기와 역할 분리 | `page.tsx` `savePendingAsQueuedProblem` |
| 2026-05-02 | 크롭 모드 우측 패널에 **전체 페이지 대형 미리보기** | 좌측 스크롤 영역과 역할 분리해 가독성 확보 | `page.tsx` |
| 2026-05-02 | 1단계 UI를 다시 **`시험지`(원본·`/api/exams` 목록)** 로 롤백 | Railway 등에서 `크롭된 시험지`만 보면 목록이 비고 안내가 혼란 | `page.tsx` 복구, `api/cropped-exams`·`imageDimensionsFromBuffer` 제거 |
| (이전 합의) | 로컬 최종 DOCX 폴더명 **`해설지 최종본`** | `작업 완료`와 혼동 방지·이름 통일 | `outputPaths.ts`, `save-result`, `.gitignore`, 문서 |
| (이전 합의) | **DOCX는 Drive 업로드하지 않음** | Gemini API가 Drive에 쓰지 않음; 최종물은 로컬 책임 | `googleDrive.ts`, 파이프라인 문서 |

## 범위 밖·보류 (기록용)

- **단원·유형·난이도(수학비서 수치·가이드)** 포함 족보 — 수학비서 HML과 연계 가능, [PIPELINE.md](./PIPELINE.md) 아이디어. `getRuntimePromptRules` 실연동·벡터 검색 등은 **미구현**
- 크롭 대기열의 **서버 영속화** 또는 **ZIP 자동 생성·Drive 업로드**는 본 앱 UI에 아직 없음 — 필요 시 별도 작업 단위로 Gate A에서 범위 확정
- academy_manager 수준의 **pre-commit 문서 자동화**는 미도입
