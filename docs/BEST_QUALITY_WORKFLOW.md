# 최상의 해설집 우선 워크플로

> **⚠️ 2026-05-06 갱신:** Cursor IDE 의존을 제거하고 Railway `/auto` 자동 파이프라인으로 전환했습니다.
> 본 문서의 Cursor 채팅 검수 단계는 이제 [src/lib/autoPipelineChecklist.ts](../src/lib/autoPipelineChecklist.ts)
> 와 `/auto` UI의 별점 피드백 루프가 흡수합니다. 운영 가이드는 [README.md](../README.md)와
> [INTEGRATION.md](../INTEGRATION.md) 참조.

- 문서 기준일: 2026-05-03 (구 Cursor·MCP 운영 문서: [_archive/cursor-legacy/docs/CURSOR_MCP_WORKFLOW.md](../_archive/cursor-legacy/docs/CURSOR_MCP_WORKFLOW.md))
- **품질 최우선 시 모델·env:** [models.md](./models.md) 「해설 품질 최우선」절
- **목표:** 자동화·배치보다 **해설 품질·교과 적합성·정답 신뢰도**를 최우선으로 둔다.

---

## 전문가 합의 요지 (요약)

| 논점 | 합의 |
|------|------|
| **입력** | 크롭 이미지는 **원본(PNG/JPEG) 그대로** 비전에 넣는 것이 정석이다. Base64는 JSON 전송용 포장일 뿐, 품질을 깎지 않는다. |
| **자동화** | ZIP 일괄·배치는 **시간 절약용**. 품질이 목표면 **문항 단위 검수**가 빠지면 안 된다. |
| **역할 분담** | LLM은 초안·풀이 후보, **최종 책임은 사람(+ Cursor 중재)**. 형식 맞추기는 그 다음이다. |
| **실패 패턴** | 근사 표현, 객관식 번호·값 불일치, 한 해설에 두 문항 섞임, 장황한 자문자답 → **검수 체크리스트**로 걸러낸다. |

---

## 권장 동선 (품질 최우선)

아래는 **자동화를 쓰더라도** “품질을 지키는” 최소 루프다.

1. **크롭** — 문항별로 선명하게 잘라 저장(Railway/로컬 앱 동일).
2. **초안 생성** — 택일:
   - **Cursor MCP:** `generate_math_explanation`(Gemini)로 이미지+`task` → 초안.
   - **또는** 앱 `/api/generate-explanation`(같은 백엔드). 난이도 높으면 `.env`에서 교차 검증([models.md](./models.md)) 고려.
3. **검수·중재(필수)** — [CURSOR_MCP_WORKFLOW.md](./CURSOR_MCP_WORKFLOW.md)의 **「중재 검수 체크리스트」** 전항 적용. 정답·해설 일치, 보기 번호, 근사 표현 제거.
4. **스타일 정돈(권장)** — `참고용 문제` 단원 예시 한두 개만 채팅에 붙여 “이 전개·톤으로 맞춰라”고 하면 일관성이 오른다.
5. **합본·DOCX** — 확정 텍스트만 `[문항 n]` / `[정답]` / `[해설]` 형식으로 모은 뒤 `npm run write-final-docx` → **`해설지 최종본`**.

**배치를 쓸 때:** 한 번에 DOCX까지 가는 `batch:crops-to-docx`보다, 초안만 모으는 **`npm run batch:crops-drafts`** (`--drafts-only`) 후 **3~5단계**를 거치는 편이 해설집 품질에는 유리하다.

---

## 하지 말 것 (품질 목표일 때)

- 초안을 검수 없이 곧바로 최종본에 넣기.
- 정답만 맞는 것처럼 보이게 근사·어림으로 결론 내리기.
- 자동화 스크립트가 실패·혼선을 줄 때 **그대로 두고** 다음 문항으로 넘어가기.

---

## 관련 문서

| 문서 | 내용 |
|------|------|
| [CURSOR_MCP_WORKFLOW.md](./CURSOR_MCP_WORKFLOW.md) | MCP 인자, 중재 체크리스트, 복사용 지시문 |
| [PIPELINE.md](./PIPELINE.md) | Drive·Railway·전체 동선 |
| [models.md](./models.md) | 모델·교차 검증 env |

---

## 한 줄 원칙

**이미지로 정확히 읽고 → 초안 → 사람이 검수해 한 벌로 확정 → 그다음 합본·DOCX.**
