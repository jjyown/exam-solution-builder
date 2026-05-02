# 해설지 제작기 — 개발·운영 플레이북 (경량)

- 문서 기준일: 2026-05-02
- 적용 범위: `highroad-math-solution` (Next.js 앱, 로컬 + Railway 배포, 선택 Drive 읽기)

본 문서는 별도 프로젝트 **academy_manager** 의 `docs/enterprise_workflow.md` 에 있는 **게이트·작업 단위** 아이디어를 이 저장소 규모에 맞게 축소한 것입니다. (Python 자동 문서 스크립트는 두지 않음 — 기록은 수동·에이전트가 `context` / `plan` / `checklist`에 반영.)

## 1) 작업 단위 정의 (Work Item)

모든 기능 변경은 **작업 단위 1개**로 쪼개고, 끝날 때 아래를 채운다.

| 항목 | 설명 |
|------|------|
| 목표 | 왜 하는지 (1~2문장) |
| 변경 범위 | 어떤 파일·API·UI인지 |
| 위험 | 깨질 수 있는 동선·환경 |
| 검증 계획 | `npm run build`, 수동 스모크 경로 |
| 완료 기준 | PASS로 볼 조건 |

## 2) 단계별 게이트 (Gate A~E)

### Gate A. 설계·영향

- 요구를 한 문장으로 재정의한다.
- 영향 받는 경로: `src/app/page.tsx`, `src/app/api/*`, `src/lib/*`, `.env*`, `docs/*`
- 범위 밖 요구는 `docs/context.md`에 **범위 변경**으로 남긴다.

### Gate B. 구현

- 작은 커밋 단위로 수정한다.
- API·환경변수 변경 시 `.env.local.example` 과 `docs/models.md` / `PIPELINE.md` 정합을 맞춘다.

### Gate C. 통합 회귀 (최소)

- `npm run build` 성공
- **로컬 전체 모드**: 시험지 선택 → 크롭 → 해설 생성 → DOCX 저장 → `해설지 최종본` 생성
- **크롭 모드** (`NEXT_PUBLIC_UI_MODE=crop`): 1·2단계만 노출, 3단계 미표시
- Drive 사용 시: 시험지 목록 API 스모크 (자격 증명·폴더 ID 전제)

### Gate D. 배포·운영

- Railway: `NEXT_PUBLIC_*` 변경 후 **재빌드** 필요 여부 확인
- 원인 분류: 코드 / 환경변수 / 외부 API(Gemini·Drive) / 브라우저

### Gate E. 사후 기록

- `docs/plan.md`: 상태·다음 단계
- `docs/context.md`: 의사결정 1행 추가
- `docs/checklist.md`: 체크 또는 미완료 `[ ]`

## 3) PRD-lite 템플릿

- 문제:
- 사용자 영향:
- 성공 기준:
- 제외 범위:
- 위험·가정:

## 4) 테스트 전략 (Risk-Based)

| 위험도 | 예시 | 최소 검증 |
|--------|------|-----------|
| High | API 키·과금, 저장 경로, 내보내기 게이트 | 전체 해설·DOCX 동선 1회 |
| Medium | UI 모드 전환, PDF 페이지 상태 | crop / full 각 스모크 |
| Low | 문구·스타일 | 해당 화면만 확인 |

## 5) 장애 대응 (트리아지)

1. 재현: 동일 시험지·동일 단계
2. 네트워크: `/api/*` 상태코드·응답 본문
3. 환경: `.env.local`, Railway Variables
4. 외부: Gemini 할당량, Drive 토큰 만료

## 6) 작업 로그 (수동)

- 2026-05-02 | 문서 세트 도입 (`enterprise_workflow`, `context`, `plan`, `checklist`) | gates: A:PASS, B:N/A, C:문서만, D:N/A, E:PASS | note: academy_manager 패턴 모방
