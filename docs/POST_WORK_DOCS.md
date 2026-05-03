# 작업 후 문서 반영 규칙

기능·동선·API·환경 변수를 바꾼 뒤에는 **코드와 문서를 한 세트**로 맞춘다. PR·커밋 전에 아래를 점검한다.

## 1. 반드시 대조할 항목

| 변경 유형 | 갱신할 문서·위치 (우선순) |
|-----------|---------------------------|
| 폴더 경로·상수(`outputPaths` 등) | [PIPELINE.md](./PIPELINE.md) 표·한 줄 구조, 필요 시 [context.md](./context.md) 의사결정 로그 |
| 신규/변경 API 라우트 | [PIPELINE.md](./PIPELINE.md) API 표기, [checklist.md](./checklist.md) 회귀 항목 |
| `process.env` / 모델 키 | [models.md](./models.md), (선택) [PIPELINE.md](./PIPELINE.md) 환경 변수 절 |
| UI 단계·버튼 문구·배포 동선 | [enterprise_workflow.md](./enterprise_workflow.md), [PIPELINE.md](./PIPELINE.md) |
| 제품 방향·Trade-off | [context.md](./context.md) 결정 로그에 **한 줄** |

## 2. 문서 기준일

의미 있는 동선/스키마 변경이 있으면, 수정한 문서 상단 **문서 기준일**(또는 본 문서 세트의 공통 기준일)을 작업일로 맞춘다.

## 3. 이 레포 문서 세트

전체 목록과 역할은 [PIPELINE.md](./PIPELINE.md) 상단의「문서 세트」절을 기준으로 한다.  
새 **문서 반영 규칙**은 이 파일(`POST_WORK_DOCS.md`)에만 상세히 둔다.

## 4. Git

- **커밋하지 않음:** `.env`, `.env.local`, 키·토큰, 로컬 전용 스크립트에 들어가는 비밀.
- **커밋함:** `docs/`, `src/`, `.gitignore` 등. 문서-only 커밋도 허용.

## 5. 에이전트/자동화

Cursor·CI에서 “구현만” 하고 끝내지 말고, **같은 PR/같은 작업 범위**에서 위 표에 해당하면 문서 diff를 남긴다.
