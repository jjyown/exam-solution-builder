# 하이로드 수학 해설지 제작기 — 체크리스트

- 문서 기준일: 2026-05-05

## 문서·기록 (운영)

- [x] `docs/enterprise_workflow.md` 도입 — Gate A~E·작업 단위 정의 (2026-05-02)
- [x] `docs/context.md` 도입 — 제품 컨텍스트·의사결정 표 (2026-05-02)
- [x] `docs/plan.md` 도입 — 목표·원칙·완료/다음 단계 (2026-05-02)
- [x] `docs/checklist.md` 도입 — 본 파일 (2026-05-02)
- [x] `docs/PIPELINE.md`·`README.md` 와 상호 링크·`NEXT_PUBLIC_UI_MODE` 설명 정합
- [ ] 이후 작업마다 **동일 세션**에서 context/plan/checklist 최소 1곳 이상 갱신 (습관)
- [x] `docs/worklog.md` 생성 및 최근 누락 작업 역정리 (2026-05-04)
- [x] Cursor 훅 `afterAgentResponse` 자동 로그 추가 (`.cursor/hooks/auto-docs-worklog-after-response.mjs`)
- [x] `POST_WORK_DOCS.md`에 문서 반영 강제 규칙(강화) 반영

## 기능·회귀

- [x] 크롭 묶음 Drive 업로드: ZIP + `작업완료` 폴더 (`/api/upload-crop-bundle`, UI 버튼)
- [x] 로컬 최종 DOCX 경로가 `해설지 최종본` 상수와 일치 (`outputPaths.ts`, `save-result`)
- [x] `NEXT_PUBLIC_UI_MODE=crop` 시 3단계(해설)·DOCX UI 비표시, 자동 step3 이동 없음
- [x] 크롭 ZIP에 `manifest.json` 존재 시 도형 파일(`diagramFiles`, `*_fig*`)을 문항 집계에서 제외하고 본문 문항만 초안 생성
- [x] `build:md --preflight-openai`는 OpenAI 실패 시 대체 리포트 저장 후 계속 진행(엄격 차단은 `--preflight-openai-strict`)
- [x] Obsidian MCP 권위 문서 세트(운영원칙/표준프롬프트/검수체크리스트/실패사전/최종게이트) 추가
- [x] Obsidian 세션 핸드오프 `docs/obsidian-mcp/05_세션종합_다음작업_토의록.md` 및 `README` 6단계 연계
- [x] MCP(연결 유지)와 `.cursorrules`(트리거) 관계를 `00_운영원칙`·워크스페이스 `.cursorrules`에 문서화
- [x] 원클릭 실행: `npm run final:from-input -- --input "./크롭된 시험지"` 로 최종 DOCX 자동 생성 확인
- [x] 전문가 합의 반영: 원클릭 기본 strict gate, 빠른 예외 모드 `--fast` 분기
- [x] strict 모드 상시 운용을 위한 LaTeX 구분자 자동 교정(`\\[\\]`,`\\(\\)`, 닫는 구분자 직전 마침표 제거) 적용 및 통과 확인
- [x] strict content gate 적용: 과소 해설/포기문구/해설 결론-정답 불일치 치명 규칙 검사
- [x] content gate 2차 적용: 변수 없는 산술 등식(`lhs=rhs`) 자동 계산 검증
- [x] content gate 3차 적용: 체인 등식(`A=B=C`) 인접 항 비교 검증
- [x] content gate 4차 적용: 부등식 체인(`A<B<C`, `A<=B<=C`) 인접 항 비교 검증
- [x] 교육과정 적합성 게이트 1차 적용: 범위 밖 고위험 개념 탐지(`E_CURRICULUM_OUT_OF_SCOPE`)
- [x] 모듈화 1차 적용: content gate를 `src/lib/quality/contentGate.ts`로 분리 후 빌드/린트 통과
- [x] 모듈화 2차 적용: 입력 매핑(`questionVisuals`), 완결성 게이트(`completenessGate`), 이미지정책(`explanationImagePolicy`) 분리
- [x] 실행 간섭 차단: manifest 미포함 문항 초안 자동 제외 + 기존 생성 이미지 파일 자동 정리
- [x] 모듈화 런타임 안정화: `final:from-input`에서 분리 모듈 동적 import 주입으로 strict 스모크 통과
- [x] 모듈화 3차(부분): `generate-explanation` 정책 로직을 `src/lib/reasoning/explanationPolicy.ts`로 분리
- [x] 모듈화 3차(확장): 형식/정합 검증 로직을 `src/lib/reasoning/explanationFormatPolicy.ts`로 분리
- [x] 수업기준 게이트 오탐 완화: 근삿값 문구의 치명/경고 분리 및 strict 재실행 통과
- [x] 원클릭 합본 `[문제]`에 원본 문항 이미지 자동 주입 확인
- [x] 원클릭 합본 `[문제]`에 manifest `diagramFiles`(fig)까지 자동 주입되도록 확장
- [x] 운영 규칙에 중·고등(2022 개정) 교육과정 준수 항목 반영(`.cursorrules` 상위/프로젝트)
- [x] OMML 수식 런 bold 적용 패치 및 DOCX 생성 스모크 확인
- [x] Railway 배포 로그 기준 TypeScript 실패(`MathRun` 인자 타입 불일치) 복구 후 `npm run build` 재통과
- [x] Supabase 우측 미리보기 0건 오탐(시험명 표기 차이) 복구: `exam_name` 정규화 폴백 매칭 + 빌드 통과
- [x] Supabase 해설 미리보기에서 `\(...\)`, `\[...\]` 정규화 적용으로 KaTeX 렌더 품질 개선 + 빌드 통과
- [x] 원클릭 strict 검수에 Python(sympy) 보조 수식 검산 게이트 추가(미설치 시 경고 폴백) + 빌드 통과
- [x] Supabase 스냅샷 비교 도구 추가: `npm run snapshot:compare -- --workdir "./해설 작업중/[TEST] TEST1"` 실행 및 리포트 생성 확인
- [x] 수식 토큰 손상 보정(`￦`, `#wfrac`, `\frac12`) 적용 후 `npm run build` 통과 + DOCX 재생성 확인
- [x] 선분 표기 보강(`\overline{P_kQ_k}`) 및 `TEST1_검수2` 재업로드 후 스냅샷 0 diff + DOCX 재생성 확인
- [x] 빠른정답/해설의 `[정답]` 줄 분수(`a/b`)를 OMML 분수로 출력하도록 수정 + `TEST1_검수2` 재생성 확인
- [x] 느슨한 축약 LaTeX(`\frac1{...}`, `\frac{16}3`, `\sqrt3`) 정규화 적용 + `TEST1_검수2` DOCX 재생성 확인
- [x] 해설 축약 치환 금지 규칙(`s=sin..., c=cos...`)을 strict content gate에 추가 + 문항2 축약표현 제거 반영
- [x] DOCX 수식 전체 볼드 강제 후처리(OMML `m:r` 스타일 주입) 적용 + `TEST1_검수2` 재생성 확인
- [x] HML 양식 zip(`Downloads.Zip`) 분석 후 선행 학생명 태그 제거 규칙 반영
- [x] 원클릭 `final:from-input` Mathpix 기본 ON 전환 및 `--no-mathpix` 비활성화 옵션 반영
- [x] 문제 발견 시 자동 피드백 규칙 반영: 사용자 허용 없이도 이슈 요약/영향/조치/재발방지 4행 포맷으로 기록·보고
- [x] DOCX 문제 파트 공백 복구: `문제 원본` 이미지 제외 규칙 해제 후 재생성 확인
- [x] 객관식 정답 표기 통일: 빠른정답/해설 `[정답]`을 ①~⑤ 형식으로 출력
- [x] 가독성 보정: 장문 등식 체인 `\cdots` 축약 + 과도한 연결 서술 자동 정리 로직 반영
- [x] DOCX 수식 줄넘침 보정: 렌더 단계에서 긴 등식/합을 `\cdots` 축약 + `√2/2`,`√3/2` 텍스트 분수의 수식 승격 적용
- [x] 문제 가독성 보정: `write-final-docx` 단계에서 문제 텍스트 부족 시 문제 이미지 OCR 발문/선지 자동 병기
- [x] 시중교재 전용 모듈화: `final:from-textbook` 스크립트/프리셋 모듈/운영 가이드(`docs/TEXTBOOK_WORKFLOW.md`) 추가
- [x] 교재 OCR 참고자료 구축 모듈화: `textbook:build-reference` + `textbookReferenceSelector` + `generate-explanation` 태그 주입(`textbookUnit/type/difficulty`)
- [x] 전체 참고자료 반영: 태그 미지정 시에도 교재 참고 md를 기본 후보로 주입하도록 fallback 활성화
- [x] 교재 다문항 페이지: Mathpix `line_data` bbox 기반 `textbook:split-pages`로 문항별 png+md 1:1 분할(Pillow)
- [ ] 교재 PDF 다문항: `textbook:build-reference`에서 split script가 자동 실행되어 `*_problemNN` 산출물이 생성되는지(샘플 PDF) 검증
- [x] 샘플 검증(확률과통계/여러가지 순열): `scratch/ocr-mapping-runs/tmp_split_output`에 `*_problemNN.md/png` 쌍 생성 확인 (`md_count=403`, `png_count=403`)
- [ ] 다문항 분할 튜닝: 후반 페이지 과분할(예: page62/63) 억제를 위한 번호 인식 조건(좌표/간격/타입) 강화
- [x] 다문항 분할 튜닝 1차 적용: 번호 인식에 line type/좌표/번호 진행성 필터 + 세그먼트 상한 폴백 반영
- [x] 분할 3차: 한 세그먼트에 타 문항 `[정답]`이 섞일 때 줄·bbox 1:1(`LinePiece`) 유지하며 강제 분할(기본 ON, `--no-foreign-answer-split`로 비교)
- [x] 분할 저장 시 번호 fallback 보강: `printedNumber`를 owner→`N) [정답]`→문항시작 패턴 순으로 추정해 `n/a` 축소
- [x] 분할 재검증(2026-05-06): `tmp_split_v3_force` 기준 `md=174`, `image=174`, strict 혼입 위반 0, `skipped(no printedNumber)=1`
- [x] 분할 5차: 동일 번호·유사 본문 전역 병합(`merge_duplicate_owner_segments_global`) + 병합 후 인접 동일 `LinePiece` dedupe(bbox 합집합) + `--force` 시 `clear_stem_problem_outputs`로 orphan `*_problemNN.*` 삭제
- [~] 잔여 고분할 4차 실험: 머리말 노이즈/인접 동일 owner/인접 중복 본문 제거 적용했으나 `page64=9`, `page79=7` 유지 (5차 적용 후 전체 `--force` 재빌드로 문항 수·strict 감사 재확인 필요)
- [ ] 튜닝 재검증 2차: `scratch/ocr-mapping-runs/tmp_split_output_tuned`에서 잔여 고분할 페이지(page64=8, page79=7) 원인 분석 후 추가 규칙 보강
- [x] 교재 참고자료: `textbook:audit-tree` 기준 깊이 3·legacy `.pdf` 폴더 0건(정규화 스크립트 적용)
- [x] 참고용 문제 폴더 실데이터 OCR 완료: PDF 16건을 Markdown 참고자료로 변환(성공 16, 실패 0)
- [ ] DOCX 보내기 후: 문제 박스 수식 굵기·해설 OMML 모양·보기 잘림·페이지 끊김 — `05` §3 체크리스트로 육안 확인
- [x] `npm run build` 통과 (Turbopack NFT 경고는 별도 이슈)
- [x] Mathpix: `.env.local` 키 설정 후 `npm run dev` + `POST /api/mathpix-text` 또는 배치 `--mathpix`; MCP는 Cursor에 `MATHPIX_APP_ID`/`MATHPIX_APP_KEY` 등록 후 `mathpix_recognize` 스모크
- [x] 자동 크롭: 2단계 UI에서 「비전으로 박스 채우기」→ 박스 확인 → 「현재 페이지 작업 저장」; 2단 시험지는 세로 가이드 후 실행 권장
- [ ] Railway 배포 환경에서 `NEXT_PUBLIC_UI_MODE=crop` 적용 후 실제 크롭 동선 스모크 (사용자)
- [ ] 로컬 전체 모드: 시험지 → 크롭 → 해설 생성 → `해설 제작 (DOCX)` → 파일 생성 확인 (필요 시 반복)

## 환경·보안

- [x] `.env.local`·API 키는 git 제외 (`.gitignore`)
- [ ] Drive 사용 시: refresh token·폴더 ID 만료·권한 이슈 시 `PIPELINE.md` 트리아지 순서로 점검

## 알려진 제한 (문서화됨)

- [x] 크롭 대기열은 **브라우저 세션** 기준 — 새로고침 시 유실 가능 (`page.tsx` 안내 문구)
- [x] DOCX를 Drive API로 업로드하는 흐름 **없음** (의도된 설계)
