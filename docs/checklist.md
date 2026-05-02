# 하이로드 수학 해설지 제작기 — 체크리스트

- 문서 기준일: 2026-05-02

## 문서·기록 (운영)

- [x] `docs/enterprise_workflow.md` 도입 — Gate A~E·작업 단위 정의 (2026-05-02)
- [x] `docs/context.md` 도입 — 제품 컨텍스트·의사결정 표 (2026-05-02)
- [x] `docs/plan.md` 도입 — 목표·원칙·완료/다음 단계 (2026-05-02)
- [x] `docs/checklist.md` 도입 — 본 파일 (2026-05-02)
- [x] `docs/PIPELINE.md`·`README.md` 와 상호 링크·`NEXT_PUBLIC_UI_MODE` 설명 정합
- [ ] 이후 작업마다 **동일 세션**에서 context/plan/checklist 최소 1곳 이상 갱신 (습관)

## 기능·회귀

- [x] 크롭 묶음 Drive 업로드: ZIP + `작업완료` 폴더 (`/api/upload-crop-bundle`, UI 버튼)
- [x] 로컬 최종 DOCX 경로가 `해설지 최종본` 상수와 일치 (`outputPaths.ts`, `save-result`)
- [x] `NEXT_PUBLIC_UI_MODE=crop` 시 3단계(해설)·DOCX UI 비표시, 자동 step3 이동 없음
- [x] `npm run build` 통과 (Turbopack NFT 경고는 별도 이슈)
- [ ] Railway 배포 환경에서 `NEXT_PUBLIC_UI_MODE=crop` 적용 후 실제 크롭 동선 스모크 (사용자)
- [ ] 로컬 전체 모드: 시험지 → 크롭 → 해설 생성 → `해설 제작 (DOCX)` → 파일 생성 확인 (필요 시 반복)

## 환경·보안

- [x] `.env.local`·API 키는 git 제외 (`.gitignore`)
- [ ] Drive 사용 시: refresh token·폴더 ID 만료·권한 이슈 시 `PIPELINE.md` 트리아지 순서로 점검

## 알려진 제한 (문서화됨)

- [x] 크롭 대기열은 **브라우저 세션** 기준 — 새로고침 시 유실 가능 (`page.tsx` 안내 문구)
- [x] DOCX를 Drive API로 업로드하는 흐름 **없음** (의도된 설계)
