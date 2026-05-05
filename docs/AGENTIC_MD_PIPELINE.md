# Agentic 마크다운·그래프·이중 검수 파이프라인

- 문서 기준일: 2026-05-03

## 한 줄 요약

`해설 작업중/<시험>/` 에 `문항##_API초안.md` + `manifest.json` 이 있을 때,

1. **(선택)** 초안에 ` ```python` … ` ``` ` 가 있으면 Node가 추출해 **matplotlib 실행** → `q{n}_generated_graph.png`
2. **`npm run build:md`** 가 manifest 기준으로 이미지 경로를 주입하고 **`합본_편집용.md`** 작성
3. **`[해설]`** 직후 **`![참고 도형 …]`** 는 `<div align="center">` 로 감싸서 주입
4. **기존 `explanationExportGate`** 로 구조·LaTeX 잔존 등 이중 검수 (exit 1)
5. **(선택)** `--preflight-openai` 로 OpenAI에 “그림 권장” 표 받아 `export_preflight_openai.md` 저장 → **Cursor·원장님이 최종 검토** 후 DOCX  
   - 키/네트워크 문제 시 기본은 **경고 후 계속 진행**(대체 리포트 저장)  
   - OpenAI 검수를 반드시 통과해야 하면 `--preflight-openai-strict` 사용
6. **(선택)** `--write-docx` 로 **`npm` 대신 `npx tsx write-final-docx.mts`** 호출 — 수식은 기존 **`docx` + OMML** (`examExplanationDocx`) 경로. Pandoc 전환은 토큰·환경 의존도가 커서 기본 경로는 유지한다.

## 명령 예시

```bash
# 파일 넣고 최종본까지 한 번에 (권장 기본 동선, strict 기본)
npm run final:from-input -- --input "./크롭된 시험지"

# 기존과 동일(병합 + 게이트만)
npm run build:md -- --workdir "./해설 작업중/[TEST] TEST1.pdf"

# matplotlib 펜스 실행 + 병합 + 게이트
npm run build:md:agentic -- --workdir "./해설 작업중/[TEST] TEST1.pdf"

# OpenAI 그림 필요 검수표까지(OPENAI_API_KEY 필요)
npm run build:md -- --workdir "./해설 작업중/[TEST] TEST1.pdf" --preflight-openai

# OpenAI 검수 실패 시 중단(엄격 모드)
npm run build:md -- --workdir "./해설 작업중/[TEST] TEST1.pdf" --preflight-openai-strict

# DOCX까지(빠른정답은 파일 또는 인자)
npm run build:md -- --workdir "./해설 작업중/[TEST] TEST1.pdf" --write-docx --exam-name "TEST1"
```

### 원클릭 최종본 (`final:from-input`)

- 실행 순서:
  1) `batch-crops-to-docx --drafts-only`로 `해설 작업중/<시험>/` 초안 생성  
  2) 방금 생성된 최신 `합본_편집용.md`를 자동 선택  
  3) `write-final-docx --workdir <자동선택폴더>` 실행  
- 즉, **입력 폴더 지정만으로 최종 DOCX까지** 연속 실행한다.
- 기본값은 **strict gate**(구조검사 포함)다.
- 기본값은 **Mathpix ON**(해설 입력 보강)이다.
- Mathpix를 끄려면 `--no-mathpix`를 사용한다.
- 빠른 즉시 산출이 필요하면 `--fast`를 사용한다(구조검사 생략).
- 예시:
  - `npm run final:from-input -- --input "./크롭된 시험지" --solver-profile balanced`
  - `npm run final:from-input -- --input "./크롭된 시험지" --fast`
  - `npm run final:from-input -- --input "./크롭된 시험지" --no-mathpix`
  - `npm run final:from-input -- --input "./크롭된 시험지" --mathpix --mathpix-min-confidence 0.7`

## AST 엄격 헤더 (`n) [문제]` …)

기본 게이트는 `[문제]` → `[빠른 정답]` → `[해설]`(또는 `n)` 접두)를 이미 허용한다.  
**번호 접두만** 강제하려면:

```bash
npm run validate:format -- --workdir "./해설 작업중/..." --strict-numbered-headers
```

## OpenAI 시스템 지시 (수석 편집장·matplotlib)

- 상수: `src/lib/chiefEditorPrompts.ts` (`CHIEF_EDITOR_SYSTEM_PROMPT`, `OPENAI_IMAGE_NECESSITY_CHECKLIST_SYSTEM`)
- 비전 폴백 한 줄 보강: `CHIEF_EDITOR_MATPLOTLIB_LINE` → `generate-explanation/route.ts` 의 OpenAI system 문자열에 포함

## 원장님 사전 점검

- **Python 3** + `pip install matplotlib` (한글 폰트는 Windows **맑은 고딕** 등이 있으면 자동 후보에 포함)
- `--run-python-graphs` 사용 시 실패하면 터미널 메시지에 stderr 일부가 붙는다.
- **`PYTHON` / `PYTHON_EXE`** 로 인터프리터 지정 가능 (예: `PYTHON=python`)
- **OpenAI 비용:** `--preflight-openai` 는 기본 **`gpt-4o-mini`**(교차검증용 `OPENAI_MODEL_CROSS_VERIFY` 와 별도). 종량제·프로필별 라우팅은 [models.md](./models.md) 「OpenAI 종량제·하이브리드 라우팅」.

## Cursor 최종 검토 (자동 이후)

`export_preflight_openai.md` 를 채팅에 붙이고, 합본을 한 번 더 다듬은 뒤 `write-final-docx` 또는 `--write-docx` 로 저장한다.
