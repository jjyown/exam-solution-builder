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
- [x] 원클릭 합본 `[문제]`에 원본 문항 이미지 자동 주입 확인
- [x] OMML 수식 런 bold 적용 패치 및 DOCX 생성 스모크 확인
- [x] Railway 배포 로그 기준 TypeScript 실패(`MathRun` 인자 타입 불일치) 복구 후 `npm run build` 재통과
- [x] Supabase 우측 미리보기 0건 오탐(시험명 표기 차이) 복구: `exam_name` 정규화 폴백 매칭 + 빌드 통과
- [x] Supabase 해설 미리보기에서 `\(...\)`, `\[...\]` 정규화 적용으로 KaTeX 렌더 품질 개선 + 빌드 통과
- [x] 원클릭 strict 검수에 Python(sympy) 보조 수식 검산 게이트 추가(미설치 시 경고 폴백) + 빌드 통과
- [x] Supabase 스냅샷 비교 도구 추가: `npm run snapshot:compare -- --workdir "./해설 작업중/[TEST] TEST1"` 실행 및 리포트 생성 확인
- [x] HML 양식 zip(`Downloads.Zip`) 분석 후 선행 학생명 태그 제거 규칙 반영
- [x] 원클릭 `final:from-input` Mathpix 기본 ON 전환 및 `--no-mathpix` 비활성화 옵션 반영
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
