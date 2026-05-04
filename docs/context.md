# 하이로드 수학 해설지 제작기 — 컨텍스트 노트

- 문서 기준일: 2026-05-04

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
