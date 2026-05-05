# 문서 운용 규칙 (작업 전·중·후)

- 문서 기준일: 2026-05-05

이 레포에서는 **코드나 설정을 바꾸기 전에 `docs`를 먼저 읽고**, 작업할 때마다 **같은 맥락으로 `docs`에 남기는 것**을 기본 습관으로 둔다.

---

## 1. 작업 전 — `docs`를 먼저 읽는다

**어떤 작업을 시작하기 전에**(기능 추가, 버그 수정, 스크립트·배치, 문서만 수정 포함) 아래를 **가능한 한 순서대로** 훑는다. 해당 없으면 건너뛴다.

| 순서 | 문서 | 읽는 목적 |
|------|------|-----------|
| 1 | [PIPELINE.md](./PIPELINE.md) | 확정 동선, 폴더 역할, 배치 CLI, 환경 변수 한 줄 |
| 2 | 이 파일(`POST_WORK_DOCS.md`) 전체 | 작업 후 무엇을 맞출지, 에이전트·사람 공통 규칙 |
| 3 | [context.md](./context.md) | 제품 맥락, **의사결정 로그**(이미 내린 판단 재반복 방지) |
| 4 | [plan.md](./plan.md) | 현재 목표·완료/다음 단계 |
| 5 | [checklist.md](./checklist.md) | 회귀·미완료·PASS 조건 |
| 6 | [enterprise_workflow.md](./enterprise_workflow.md) | Gate·작업 단위(큰 작업·릴리즈 전) |
| 7 | [models.md](./models.md) | LLM·`process.env`(API/모델/키를 건드릴 때) |
| 8 | [obsidian-mcp/05_세션종합_다음작업_토의록.md](./obsidian-mcp/05_세션종합_다음작업_토의록.md) | 채팅·이슈 핸드오프, DOCX 수식·볼드 우선순위·다음 세션 체크리스트 |

- **시간이 없을 때 최소:** `PIPELINE.md` + 이 파일 + 변경 영역과 맞닿은 한두 개(`context` 또는 `checklist` 등). **새 채팅/인수인계 직후**에는 `05_세션종합_다음작업_토의록.md`만 추가로 본다.
- **에이전트(Cursor 등)에게도** 구현·리팩터 지시를 줄 때, 위 **선행 읽기**를 요청에 포함하거나, 저장소의 이 규칙을 따르도록 한다.
- **MCP와 규칙:** MCP 연결은 종종 **세션 간에도 유지**되지만, “항상 옵시디언(또는 권위 md)부터 읽기”는 **워크스페이스 `.cursorrules` 등에 명시**해야 일관된다. 원리는 [obsidian-mcp/00_운영원칙.md](./obsidian-mcp/00_운영원칙.md) 「MCP 연결 vs 규칙」절.

---

## 2. 작업할 때마다 — `docs`에 기록한다

- 의미 있는 **의사결정·동선 변경·새 제약·되돌리기 어려운 선택**은 작업과 **같은 단위**(같은 PR·같은 작업 세션)에서 [context.md](./context.md) 의사결정 로그 표에 **한 줄 이상** 남긴다.
- **제품/운영 메모**가 길어지면 [plan.md](./plan.md) 또는 [checklist.md](./checklist.md)를 함께 갱신한다.
- 문서만 고치는 작업이라도, **문서 기준일**(각 파일 상단 또는 본 세트 공통일)을 작업일에 맞출 것.
- 자동 보조: Cursor 훅(`afterAgentResponse`)이 `docs/worklog.md`에 변경 요약을 자동 추가한다. 다만 **최종 판단/의사결정 문장**은 사람이 `context.md`에 직접 1줄 이상 남긴다.

### 2.1 강제 규칙(강화)

- 코드/설정 변경이 있는데 `docs/` 변경이 없으면 작업 완료로 보지 않는다.
- 최소 반영 세트:
  1) `docs/worklog.md` 자동/수동 로그
  2) `docs/context.md` 의사결정 1줄 이상
  3) 필요 시 `docs/plan.md`, `docs/checklist.md` 동기화
- 예외(문서 생략 허용): 오탈자 1~2줄, 주석 정리만 있는 순수 비기능 수정

---

## 3. 작업 후 — 코드와 문서를 한 세트로 맞춘다

기능·동선·API·환경 변수를 바꾼 뒤에는 **코드와 문서를 한 세트**로 맞춘다. PR·커밋 전에 아래를 점검한다.

### 3.1 반드시 대조할 항목

| 변경 유형 | 갱신할 문서·위치 (우선순) |
|-----------|---------------------------|
| 폴더 경로·상수(`outputPaths` 등) | [PIPELINE.md](./PIPELINE.md) 표·한 줄 구조, 필요 시 [context.md](./context.md) 의사결정 로그 |
| 신규/변경 API 라우트 | [PIPELINE.md](./PIPELINE.md) API 표기, [checklist.md](./checklist.md) 회귀 항목 |
| `process.env` / 모델 키 | [models.md](./models.md), (선택) [PIPELINE.md](./PIPELINE.md) 환경 변수 절 |
| UI 단계·버튼 문구·배포 동선 | [enterprise_workflow.md](./enterprise_workflow.md), [PIPELINE.md](./PIPELINE.md) |
| 제품 방향·Trade-off | [context.md](./context.md) 결정 로그에 **한 줄** |

### 3.2 문서 기준일

의미 있는 동선/스키마 변경이 있으면, 수정한 문서 상단 **문서 기준일**(또는 본 문서 세트의 공통 기준일)을 작업일로 맞춘다.

### 3.3 이 레포 문서 세트

전체 목록과 역할은 [PIPELINE.md](./PIPELINE.md) 상단의「문서 세트」절을 기준으로 한다.  
새 **문서 반영 규칙**은 이 파일(`POST_WORK_DOCS.md`)에만 상세히 둔다.

### 3.4 Git

- **커밋하지 않음:** `.env`, `.env.local`, 키·토큰, 로컬 전용 스크립트에 들어가는 비밀.
- **커밋함:** `docs/`, `src/`, `.gitignore` 등. 문서-only 커밋도 허용.

### 3.5 에이전트/자동화

Cursor·CI에서 “구현만” 하고 끝내지 말고, **같은 PR/같은 작업 범위**에서 위 표에 해당하면 문서 diff를 남긴다.
