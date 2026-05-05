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
| 2026-05-05 | 교재 참고자료 빌드에서 PDF는 Mathpix에 직접 넣지 않고 1페이지를 PNG로 변환 후 OCR한다 | Mathpix v3/text에 로컬 PDF data URL을 직접 전달하면 `Cannot read image`가 반복되어, 실무 자동화를 위해 렌더링 전처리 계층(PDF→이미지)이 필요함 | `scripts/build-textbook-reference.mts`, `src/lib/recognition/textbookReferenceOcr.ts` |
| 2026-05-05 | 태그가 없더라도 교재 참고 md 전체를 기본 후보로 주입한다(`maxItems=12`) | 실무 입력에서 단원/유형/난이도 태그를 항상 전달하지 못하는 경우가 많아, “현재 참고자료 모두 반영” 요구를 만족하려면 무태그 fallback을 상시 동작으로 두는 편이 운영 안정성이 높음 | `src/lib/reasoning/textbookReferenceSelector.ts`, `src/app/api/generate-explanation/route.ts` |
| 2026-05-05 | 교재 OCR 참고자료는 `frontmatter(unit/type/difficulty)+본문` md 자산으로 저장하고, 해설 API에서 태그 매칭으로 자동 주입한다 | 교재의 난이도·유형 분류 자산을 재사용 가능한 지식 계층으로 분리하면, DOCX 양식과 독립적으로 해설 품질(서술 톤/전개 밀도)을 안정적으로 향상시킬 수 있음 | `scripts/build-textbook-reference.mts`, `src/lib/recognition/textbookReferenceOcr.ts`, `src/lib/reasoning/textbookReferenceSelector.ts`, `src/app/api/generate-explanation/route.ts` |
| 2026-05-05 | 시중교재 작업은 `final:from-textbook` 전용 엔트리로 분리하고, 기존 코어 오케스트레이터(`final:from-input`)는 재사용한다 | 정책 충돌(시험지 vs 시중교재)을 줄이고 회귀 리스크를 낮추려면 실행 엔트리/프리셋 분리가 가장 안전하며, 핵심 로직 중복 없이 유지보수할 수 있음 | `src/lib/textbook/textbookPipelinePreset.ts`, `scripts/make-final-from-textbook.mts`, `package.json`, `docs/TEXTBOOK_WORKFLOW.md` |
| 2026-05-05 | 문제 파트 텍스트가 부족한 경우 DOCX 생성 단계에서 이미지 OCR 발문/선지를 자동 병기한다(자격증명 존재 시) | 원클릭 재생성이 외부 모델 혼잡으로 실패해도 `write-final-docx`만으로 문제 가독성을 끌어올릴 수 있어야 하며, 문제 박스 경고(텍스트 부족)를 실무적으로 줄이기 위함 | `src/lib/examExplanationDocx.ts`, DOCX 문제 섹션 |
| 2026-05-05 | DOCX 렌더 단계에서 텍스트형 분수(`√2/2`,`√3/2`)는 가능한 한 분수 수식으로 승격하고, 긴 다단 수식은 생략 기호(`\cdots`)로 축약한다 | 본문 텍스트로 노출되는 분수와 줄넘침 수식은 교재형 가독성을 크게 떨어뜨리고 테두리 침범까지 유발하므로, 의미 보존 범위에서 렌더 직전 정규화를 적용하는 편이 안정적임 | `src/lib/examExplanationDocx.ts` |
| 2026-05-05 | DOCX `[문제]`에서 `![문제 원본](...)` 이미지는 작업용 참조로 보더라도 기본 출력한다 | 실제 산출물에서 문제 파트가 비어 보이는 치명 체감 이슈를 막기 위해, 문제 원본 이미지는 기본 표시하고 진짜 타이핑 보조 이미지(명시 태그)만 제외하는 것이 안전함 | `src/lib/docxMarkdownImage.ts`, DOCX 문제 섹션 |
| 2026-05-05 | 객관식 정답 표기는 빠른정답/해설의 `[정답]` 모두 ①~⑤를 기본값으로 사용한다 | 숫자만 표기하면 사용자 검수 기준(원 안 숫자)과 불일치가 반복되어 재작업이 발생함 | `src/lib/examExplanationDocx.ts` |
| 2026-05-05 | 원클릭 합본 재작성에서 장문 수식 체인과 과도한 연결 서술을 경량화한다 | 고교 문항 해설에서 지나치게 장황한 변형식을 그대로 내보내면 가독성이 크게 저하되므로, 의미를 유지하는 범위에서 `\cdots` 축약과 서술 정리를 자동 적용함 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | 사용자 허용 여부와 무관하게 문제 발견 시 자동 피드백을 작성하고, 최종 보고에 이슈 건수(또는 없음)를 명시한다 | 사용자가 승인 타이밍을 놓치면 품질 이슈가 누락될 수 있으므로, 발견 즉시 기록·보고를 상시 기본값으로 고정해야 운영 리스크를 줄일 수 있음 | `.cursorrules`, 전 작업 응답 포맷 |
| 2026-05-05 | 수식 볼드는 파서 옵션에만 의존하지 않고 DOCX 생성 후 OMML(`m:r`)에 볼드 스타일을 강제 주입하는 후처리 안전망을 둔다 | docx 라이브러리 타입/버전 차이로 수식 런 볼드 옵션이 누락되면 동일 이슈가 반복될 수 있어, 최종 산출물 기준의 강제 보정이 필요함 | `src/lib/examExplanationDocx.ts` |
| 2026-05-05 | `highroad-math-solution/.cursorrules`에 전문가 토의 절차(증상분해→가설→검증→재발방지→재검증)와 불명확 시 1회 확인 원칙을 명시한다 | 사용자 요구인 “전문가 토의 방식 고정”을 채팅 단발 지시가 아닌 워크스페이스 규칙으로 상시 적용하기 위함 | `.cursorrules` |
| 2026-05-05 | 해설 내용검수 게이트에서 `s=sin..., c=cos...` 같은 단일문자 치환 축약 표기를 치명 오류로 차단한다 | 학생용 해설에서 기호 치환은 읽기 난도를 높이고 사용자 불만이 반복되어, 생성 단계 실수라도 출고 전에 강제로 막아야 하기 때문 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | DOCX 수식 전처리에 느슨한 축약형(`\frac1{...}`, `\frac{a}b`, `\sqrt3`)을 완전 중괄호 형식으로 강제 정규화한다 | TeX 관용 표기라도 현재 OMML 파서는 brace-first 형태를 요구해, 미정규화 시 `₩frac...` 문자열이 그대로 찍히는 재발이 발생하기 때문 | `src/lib/docxOmmlBuilder.ts` |
| 2026-05-05 | DOCX `[빠른정답]`/해설의 `[정답]` 줄은 텍스트 결합 대신 정답 부분을 별도 수식 파싱으로 렌더해 `a/b` 형태를 OMML 분수로 출력한다 | 빠른정답 라인에서 `1/5`, `17/4`가 일반 텍스트로 남으면 사용자 검수 단계에서 “수식 미반영”으로 판단되어 재작업이 반복되기 때문 | `src/lib/examExplanationDocx.ts` |
| 2026-05-05 | 손상 토큰 복구 대상에 `#sqrt`, `#log` 계열도 포함한다 | 실제 운영 캡처에서 `#sqrt3`, `#wfrac1` 등 분수 외 토큰 손상이 반복적으로 관찰되어 범용 복구가 필요함 | `src/lib/latexSourceNormalize.ts` |
| 2026-05-05 | 수식 손상 토큰 보정은 렌더 단계(미리보기/DOCX)에만 두지 않고 `normalizeLatexSourceText` 공통 입력 단계에서 우선 처리한다 | 줄이 텍스트로 폴백되는 경로에서는 렌더 단계 보정만으로 `#wfrac` 잔재가 남을 수 있어, 입력 정규화를 단일 진실 원천으로 두는 편이 안전하기 때문 | `src/lib/latexSourceNormalize.ts` |
| 2026-05-05 | 기하 표기에서 선분 길이를 의미하는 항(`P_kQ_k`)은 문항 본문에 `\overline{P_kQ_k}`를 명시해 의미 손실을 방지한다 | 사용자 검토 관점에서 선분 기호가 사라지면 식 의미가 달라지고 오독 위험이 커짐 | `해설 작업중/[TEST] TEST1_검수2/문항07_API초안.md`, `해설 작업중/[TEST] TEST1_검수2/합본_편집용.md` |
| 2026-05-05 | 렌더 전 LaTeX 정규화에서 `￦`(U+FFE6)와 `#wfrac` 같은 손상 토큰, `\frac12` 축약 표기를 함께 보정한다 | 현장 환경(한글 폰트/복붙/OCR)에서 수식 토큰이 미세하게 깨지면 Supabase 미리보기·DOCX 모두에서 원문 기호가 노출되어 검토 불가능해지기 때문 | `src/lib/latexSourceNormalize.ts`, `src/lib/docxOmmlBuilder.ts`, `src/components/ExplanationMarkdownMath.tsx` |
| 2026-05-05 | Supabase 정합성 확인은 업로드 성공 로그만 보지 않고, 로컬 초안과 DB 본문을 문항별 diff로 비교하는 별도 CLI(`snapshot:compare`)를 운영 루틴에 포함한다 | “Supabase 미리보기/최종 DOCX가 다르게 보인다”는 반복 이슈를 빠르게 분리(데이터 차이 vs 렌더 차이)하기 위함 | `scripts/compare-supabase-snapshot.mts`, `package.json`, `해설 작업중/*/supabase_snapshot_compare.md` |
| 2026-05-05 | 원클릭 strict content gate 뒤에 Python(sympy) 보조 검산 게이트를 추가하되, 런타임에 미설치면 치명 중단 없이 경고로만 처리한다 | 운영 환경 편차(Windows/배포)에서 파이썬 의존성 미설치로 전체 파이프라인이 멈추는 리스크를 방지하면서 검산 이득을 확보하기 위함 | `tools/math_expression_gate.py`, `scripts/make-final-from-input.mts` |
| 2026-05-05 | Supabase 우측 해설 미리보기는 렌더 직전에 수식 구분자(`\(...\)`, `\[...\]`)를 markdown 수학 구분자(`$...$`, `$$...$$`)로 정규화한다 | 검수자는 “최종 해설 형태”를 미리 봐야 하며, 원문 LaTeX 토큰 노출이 검토 효율을 크게 떨어뜨림 | `src/components/ExplanationMarkdownMath.tsx` |
| 2026-05-05 | 크롭 UI 우측 Supabase 미리보기는 `exam_name` 완전 일치가 실패하면 정규화(괄호/확장자/공백 제거) 기반 폴백 매칭을 적용한다 | 현장 운영에서 시험명 표기 `(TEST) TEST1.pdf` vs `[TEST] TEST1` 차이로 “행 없음”이 반복됨 | `src/app/api/exam-solutions/route.ts` |
| 2026-05-05 | Railway 빌드 TypeScript 실패는 `docx`의 `MathRun` 시그니처 변경(string only)으로 판정하고, 수식 런 생성을 타입 호환 우선으로 복구한다 | 배포 로그에서 `src/lib/docxOmmlBuilder.ts`의 `new MathRun({...})` 타입 불일치가 치명 에러로 확인됨 | `src/lib/docxOmmlBuilder.ts` |
| 2026-05-05 | 원클릭(`final:from-input`)은 중요한 작업 기본값으로 Mathpix OCR 보강을 ON으로 운용한다 | 사용자 요청: Mathpix를 수동으로 켜지 않아도 중요한 작업에서 자동 적용되도록 해야 함 | `scripts/make-final-from-input.mts`, `docs/AGENTIC_MD_PIPELINE.md` |
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
| 2026-05-05 | 원본 문제 이미지 외에 `manifest.items[].diagramFiles`도 문항 `[문제]` 블록에 함께 넣는 것을 기본 동작으로 확정한다 | 사용자 검수 기준이 “문제 하단에 관련 그래프/이미지 동반 표시”이므로, placeholder 문구 대신 원본+fig를 함께 주입해야 Supabase/DOCX 시각 정합성이 유지됨 | `scripts/make-final-from-input.mts`, `해설 작업중/[TEST] TEST1_검수2/합본_편집용.md` |
| 2026-05-05 | 해설 품질의 최상위 제약으로 “중·고등 2022 개정 교육과정 범위”를 고정한다 | 사용자 제공 커리큘럼을 운영 규칙으로 승격해, 정답 일치뿐 아니라 교육과정 적합성(범위 밖 개념 배제)을 검수 실패 기준으로 함께 강제하기 위함 | `../.cursorrules`, `.cursorrules` |
| 2026-05-05 | 교육과정 적합성은 규칙 문서뿐 아니라 strict 게이트 코드에서도 치명 차단한다 | 운영 규칙만으로는 누락 가능성이 있어, 파이프라인 단계에서 `E_CURRICULUM_OUT_OF_SCOPE` 자동 탐지를 추가해 재발을 줄이기 위함 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | 수업기준 게이트는 “근삿값 문구 존재”와 “근삿값 중심 풀이”를 분리해 치명도 판정한다 | 정확값 결론이 있는 풀이까지 치명 차단되던 오탐을 줄이고, 실제로는 경고로 유도한 뒤 파이프라인 통과를 보장하기 위함 | `src/app/api/generate-explanation/route.ts` |
| 2026-05-05 | trig 축약 금지 정책은 사용자 합의대로 `s=sin`, `c=cos` 계열만 차단한다 | `sincos`나 일반 문자 사용까지 막는 과잉 규칙을 줄여 strict 게이트 오탐을 완화하기 위함 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | 모듈화 1차는 동작 변경 없이 오케스트레이터를 얇게 만드는 방식으로 진행한다 | 누락 이슈 대응에서 회귀를 줄이려면 “로직 이동 + 인터페이스 고정” 전략이 안전하므로, content gate를 `src/lib/quality`로 먼저 분리한다 | `src/lib/quality/contentGate.ts`, `scripts/make-final-from-input.mts` |
| 2026-05-05 | 모듈화 2차에서 “쓰레기 산출물 간섭 차단”을 파이프라인 책임으로 포함한다 | 이전 실행 잔여 파일/가짜 문항(도형 파일 기반) 간섭을 사람이 수동 정리하면 재발하므로, 실행 전에 자동 정리/manifest 기준 필터링을 코드로 강제한다 | `scripts/make-final-from-input.mts`, `src/lib/recognition/questionVisuals.ts` |
| 2026-05-05 | 해설 이미지 정책은 “필요성 판단”과 “생성”을 분리한다 | 현재는 fig 존재 여부로 필요성/배치 타이밍(문제 이미지와 함께 vs 해설 뒤)을 먼저 결정하고, 실제 신규 이미지 생성은 후속 모듈로 분리해야 안정적이다 | `src/lib/assembly/explanationImagePolicy.ts`, `scripts/make-final-from-input.mts` |
| 2026-05-05 | 분리 모듈의 런타임 연동은 `tsx` 환경에서 동적 import 훅을 우선 사용한다 | 빌드는 통과해도 스크립트 실행 시 named export 해석 오류가 간헐적으로 발생할 수 있어, 오케스트레이터에서 동적 import로 모듈을 주입하는 방식이 안정적이었다 | `scripts/make-final-from-input.mts` |
| 2026-05-05 | `generate-explanation` 라우트는 정책 판단(교육과정/수업기준/재시도지시/도형보조)부터 모듈로 분리한다 | 라우트 비대화가 누적되면 수정 리스크가 커지므로 reasoning 정책 로직을 `src/lib/reasoning`으로 이동해 변경 범위를 줄인다 | `src/lib/reasoning/explanationPolicy.ts`, `src/app/api/generate-explanation/route.ts` |
| 2026-05-05 | `generate-explanation`의 형식/정합 검증도 `reasoning` 모듈로 이관한다 | 포맷 검증·연쇄문항 오염 검사를 라우트에 남겨두면 분리 효과가 제한되므로, 형식 정책(`explanationFormatPolicy`)까지 함께 이동해 라우트를 오케스트레이션 중심으로 유지한다 | `src/lib/reasoning/explanationFormatPolicy.ts`, `src/app/api/generate-explanation/route.ts` |
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
