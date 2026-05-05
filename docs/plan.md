# 하이로드 수학 해설지 제작기 — 작업 계획서

- 문서 기준일: 2026-05-05

## 프로젝트 목표

- PDF·이미지에서 **문항 단위 크롭**을 안정적으로 쌓는다.
- **Gemini(·OpenAI)** 로 해설을 생성·보정하고, 규칙을 통과한 뒤 **로컬 DOCX**로 저장한다.
- **Google Drive 입력 폴더**는 선택적으로 연동해 시험지 목록을 가져온다(쓰기·DOCX 업로드 없음).

## 작업 운영 원칙 (academy_manager 정렬)

- 작업 1건이 끝나면 **`docs/context.md`**(의사결정 1행 이상), **`docs/plan.md`**(상태·다음 단계), **`docs/checklist.md`**(검증 체크)를 갱신한다.
- 배포 관련 변경은 **`docs/PIPELINE.md`** 와 `.env.local.example` 을 함께 본다.
- 중요한 전제 변경(폴더명, Drive 정책, UI 모드)은 **문서 없이 완료 처리하지 않는다**.
- 장애 시 원인 분류: **코드 / 환경변수 / 외부 API / 브라우저** 를 먼저 구분한다 (`enterprise_workflow.md` 트리아지).

## 현재 상태

- [x] 로컬 최종 산출 폴더 `해설지 최종본` 상수화
- [x] `NEXT_PUBLIC_UI_MODE=crop` 크롭 전용 UI
- [x] 문서 세트: `enterprise_workflow`, `context`, `plan`, `checklist`
- [x] Agentic 합본 파이프라인(`build:md` + preflight + python graph + validate:format)
- [x] OpenAI preflight soft/strict 분리(기본 계속 진행, 필요 시 엄격 차단)
- [x] Supabase 미리보기 성능 개선(목록/본문 분리 로드) + 전체 삭제
- [x] 작업 이력 자동 누적(`docs/worklog.md`, Cursor `afterAgentResponse` 훅)
- [x] 크롭 ZIP 문항 집계 보정(`manifest.items.file` 기반 본문 문항만 배치 처리)
- [x] Obsidian MCP 권위 문서 세트(`docs/obsidian-mcp`) 구축
- [x] 세션 핸드오프 문서 `docs/obsidian-mcp/05_세션종합_다음작업_토의록.md` + `README` 6단계 반영
- [x] Mathpix v3 OCR: `/api/mathpix-text`, 배치 `--mathpix`, MCP `mathpix_recognize`(로컬 `mcp/mathpixClient.mts`)
- [x] 크롭 2단계: Gemini 비전 문항 박스 자동 채우기(`/api/detect-question-layout`, 번호 필터 `1,5,7-9`)
- [x] 원클릭 최종본 파이프라인 `final:from-input` 추가 (입력 폴더 -> 초안 -> 최종 DOCX 자동 연속 실행)
- [x] 전문가 합의 반영: 원클릭 기본값 strict gate, 예외 fast(`--fast`) 분기
- [x] strict 통과율 보강: 수식 구분자 자동 정규화(`\\[\\]`,`\\(\\)`, 닫는 구분자 직전 마침표 제거)
- [x] strict content gate 도입: 해설 길이/포기문구/결론-정답 불일치 치명 규칙 검사
- [x] content gate 2차: 변수 없는 단순 산술 등식(`lhs=rhs`) 자동 계산 검증
- [x] content gate 3차: 체인 등식(`A=B=C`) 인접 항 자동 비교 검증
- [x] content gate 4차: 부등식 체인(`A<B<C`, `A<=B<=C`) 인접 항 자동 비교 검증
- [x] 원클릭 `[문제]`에 원본 이미지 자동 주입(문항XX_문제원본.* 생성 및 연결)
- [x] OMML 수식 런 bold 적용 및 HML 선행 학생명 태그 제거 규칙 반영
- [x] 원클릭 Mathpix 기본 ON 전환(`--no-mathpix`로만 비활성화)
- [x] Railway 빌드 실패 복구: `MathRun` 타입 호환 수정 후 `npm run build` 통과
- [x] Supabase 우측 미리보기: `exam_name` 표기 차이(괄호/pdf) 폴백 매칭 추가
- [x] Supabase 해설 미리보기: 수식 구분자 정규화로 최종 DOCX와 렌더 체감 정합성 개선
- [x] 원클릭 strict 게이트: Python(sympy) 보조 수식 검산 추가(미설치 시 경고 폴백)
- [x] Supabase 스냅샷 비교 도구: 로컬 초안 vs DB 본문 문항별 diff 리포트(`snapshot:compare`)

## 최근 완료 작업 (요약)

### 문서·운영 체계 정비 — 2026-05-02

- **상태**: 완료
- **구현**: `docs/enterprise_workflow.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md`, `PIPELINE.md` 상단 「문서 세트」
- **검증**: 문서 간 **문서 기준일** 일치(2026-05-02)
- **다음 단계**: 실제 기능 변경 시마다 동일 세트 업데이트 습관 유지

### Railway 크롭 전용 UI — (코드 반영 완료, 기록일 2026-05-02)

- **상태**: 완료(코드)
- **구현 파일**: `src/lib/uiMode.ts`, `src/app/page.tsx`, `.env.local.example`, `README.md`, `docs/PIPELINE.md`
- **검증**: `npm run build` PASS; 로컬에서 `NEXT_PUBLIC_UI_MODE=crop` 으로 1·2단계만 보이는지 확인 권장
- **운영**: Railway Variables 설정 후 **재배포**

## 다음 단계 (후보)

- [ ] content gate 5차: 내용검수 결과를 단계별_진행상황.txt에 코드별 누적 기록
- [ ] 원본 이미지 + OCR 발문 병기(문제 본문 가독성 강화)
- [ ] 수식 볼드 시각 확인용 기준 샘플(사용자 제공 이미지와 대조) 자동 스냅샷 절차 정의
- [ ] `snapshot:compare`를 원클릭 파이프라인 후처리 옵션으로 연결할지 결정(자동 실행 vs 수동 실행)
- [ ] Mathpix: UI 단건에서 OCR 미리보기 버튼, 또는 `generate-explanation` 내부 자동 선호출(옵션 플래그) — 현재는 배치·API·MCP만
- [ ] 자동 크롭: 다중 페이지 일괄·저장 품질 메트릭(박스 면적·겹침) — 현재는 페이지별 수동 실행 + 저장 전 사용자 확인 전제
- [ ] DOCX: 해설 구간까지 **OMML 유지 + 시각적 볼드**를 목표로 한 저수준 OMML 실험(A/B) — 전제는 `docs/obsidian-mcp/05_세션종합_다음작업_토의록.md` §1 P2
- [ ] 크롭 세션 영속화 또는 묶음 내보내기(필요 시 PRD-lite 작성 후 Gate A)
- [ ] Turbopack NFT 경고(`next.config` ↔ `save-result` 추적) 정리 여부 검토
- [ ] `worklog.md` 자동 항목에 커밋 해시 연결(선택)
- [ ] 릴리즈 전 `docs/checklist.md`를 기준으로 운영 점검 루틴화
