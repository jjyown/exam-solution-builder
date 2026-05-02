# 하이로드 수학 해설지 제작기 — 작업 계획서

- 문서 기준일: 2026-05-02

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

- [ ] 크롭 세션 영속화 또는 묶음 내보내기(필요 시 PRD-lite 작성 후 Gate A)
- [ ] Turbopack NFT 경고(`next.config` ↔ `save-result` 추적) 정리 여부 검토
