# 하이로드 수학 해설 제작기 컨텍스트 노트

- 문서 기준일: 2026-05-01

## 제품/운영 컨텍스트
- 대상 사용자: 중고등 수학 학원 원장/강사
- 핵심 목표: 문제 추출 후 학생 눈높이 해설을 빠르게 생성하고 DOCX 결과물을 배포 가능한 환경(Vercel)에서 안정적으로 저장
- 현재 배포 환경: Vercel + GitHub `jjyown/exam-solution-builder`
- 현재 생성형 모델: Gemini (`GEMINI_API_KEY`)

## Cursor MCP (로컬 개발)
- 프로젝트 전용 stdio 서버: `mcp/gemini-gpt-server.mjs` — 도구 `gemini_generate`, `gpt_chat` 등 (각각 `GEMINI_API_KEY`, `OPENAI_API_KEY` 필요).
- 설정: 워크스페이스가 상위 폴더(`시험지 해설 제작`)이면 루트 `.cursor/mcp.json`, `highroad-math-solution`만 열면 `highroad-math-solution/.cursor/mcp.json` 사용. 비밀은 `highroad-math-solution/.env.local`에 두고 커밋하지 않음.
- 수동 실행(디버그): `npm run mcp:gemini-gpt`

### MCP 모델 선택 기준 (고정)
- 모델명을 모르면 기본값 사용:
  - Gemini 도구(`gemini_generate`, `gemini_chat`): `gemini-2.5-flash`
  - GPT 도구(`gpt_generate`, `gpt_chat`): `gpt-4o-mini`
- 역할 분담 권장:
  - Gemini: 문제 인식/구조화/요약 초안
  - GPT: 해설 문장화/양식 준수/최종 표현 다듬기
- 상향/하향 기준:
  - 정확도 부족 시 상향(`gemini-2.5-pro`, 상위 GPT 모델)
  - 비용/지연 부담 시 기본 유지 또는 `gemini-2.5-flash-lite` 검토
- 기본 워크플로우:
  1) Gemini로 문항 구조화(JSON)
  2) GPT로 해설 생성(개념 -> 풀이 -> 정답)
  3) Gemini 또는 Cursor로 누락/표현 최종 검수

## 현재 아키텍처 요약
- 프론트: Next.js App Router (`src/app/page.tsx`)
- 해설 생성 API: `src/app/api/generate-explanation/route.ts`
- 시험지 목록/파일 API: `src/app/api/exams/route.ts`, `src/app/api/exams/file/route.ts`
- 결과 저장 API: `src/app/api/save-result/route.ts`
- Drive 연동 공통 모듈: `src/lib/googleDrive.ts`

## 최근 의사결정 로그
| 날짜 | 결정 | 이유 | 영향 범위 |
|---|---|---|---|
| 2026-05-02 | 해설 **최고 신뢰도** 옵션: `EXPLANATION_CROSS_VERIFY=true`일 때 Gemini 1차 초안(품질 게이트 통과) 뒤 OpenAI vision(`OPENAI_MODEL_CROSS_VERIFY`, 기본 `gpt-4o`)으로 교차 검증 1회. 검증 실패 시 1차 초안 유지·경고. 프로필·test/final별 권장 Gemini·GPT 조합은 `docs/models.md` §4에 정리. | 운영자·MCP 토의에서 멀티모델 교차검증으로 오답·논리 오류를 줄이기 위함(100% 보장은 불가, 인간 검수는 별도) | `src/app/api/generate-explanation/route.ts`, `.env.local.example`, `docs/models.md`, `docs/plan.md` |
| 2026-05-02 | Gemini 할당량·혼잡(429 등) 시 동일 요청에서 후보 모델 순회를 중단하고, 해설 생성에서 형식 재시도 도중에도 동일 신호면 순회를 끊도록 통일한다. OpenAI 폴백의 형식 실패 2차 호출은 기본 생략(`OPENAI_EXPLANATION_FORMAT_RETRY=true`일 때만 허용). 프론트는 단건·배치 생성 중복 클릭을 막고 배치 생성 API 재시도를 1회로 제한한다. | 429 반복 시 호출 증폭(모델 순회·재시도·폴백)으로 할당량 악화와 지연을 키우는 문제를 줄이기 위함 | `src/lib/geminiRateLimit.ts`, `src/app/api/generate-explanation/route.ts`, `src/app/api/precheck-extraction/route.ts`, `src/app/page.tsx`, `.env.local.example`, `docs/plan.md` |
| 2026-05-01 | 버전 엔트리에 `sourceType(single/batch/manual)`와 `runId`를 추가하고, 저장(DOCX) 시 현재 문항의 `selectedVersion`을 우선 반영하도록 고정 | 문항 재생성/전체재구성 출처를 추적 가능하게 하고, 편집 화면과 저장 결과의 버전 불일치를 방지하기 위함 | `src/app/page.tsx` |
| 2026-05-01 | 해설 제작 단계에 문항별 버전 관리(v1/v2/...)를 추가: 생성 결과를 문항별 `versions[]`로 누적하고 `selectedVersionId`로 채택 버전을 전환할 수 있게 구현 | 문항별 재생성/비교/채택 흐름을 지원해 버전 꼬임 없이 운영자가 원하는 해설을 선택 반영하기 위함 | `src/app/page.tsx` |
| 2026-05-01 | 해설 생성 응답의 `diagramAidRecommendation`을 프론트에 노출(권장/점수/근거 + 선택 적용 안내 버튼) | 도형 보조 이미지가 필요한 문항을 운영자가 즉시 구분해 선택 적용할 수 있도록 가시성을 높이기 위함 | `src/app/page.tsx`, `src/app/api/generate-explanation/route.ts` |
| 2026-05-01 | 도형 보조 이미지(바나나) 자동 판정 규칙을 도입하고, 해설 생성 API 응답에 `diagramAidRecommendation`(권장 여부/점수/사유)을 포함 | 텍스트 해설 중심을 유지하면서, 도형 이해 보강이 필요한 문항만 선택적으로 이미지 생성을 적용하기 위함 | `src/app/api/generate-explanation/route.ts`, `README.md` |
| 2026-05-01 | HML 원본 붙이기 동선을 중단하고, 시험지 작업을 이미지 영역 지정 기반(PDF/이미지)으로 단일화 | 운영자가 원하는 제작 방식(문제 영역 직접 지정)에 집중하고, 원본 HML 처리 복잡도로 인한 동선 혼란을 줄이기 위함 | `src/app/page.tsx` |
| 2026-05-01 | MCP 사용 가이드를 문서에 고정: 모델명을 모를 때 기본값(`gemini-2.5-flash`, `gpt-4o-mini`)으로 시작하고, 역할 분담(구조화=Gemini, 해설 문장화=GPT)으로 작업하도록 명시 | 운영자가 모델명을 매번 찾지 않아도 안정적인 작업 동선을 유지하기 위함 | `README.md`, `docs/context.md`, `docs/plan.md`, `docs/checklist.md` |
| 2026-05-01 | Cursor MCP용 `gemini_generate` / `gpt_chat` stdio 브리지 서버를 추가하고, 워크스페이스 루트 또는 `highroad-math-solution` 기준 `.cursor/mcp.json`으로 연결 | 에이전트가 동일 저장소에서 Gemini·OpenAI API를 도구 호출로 쓸 수 있게 하기 위함 | `mcp/gemini-gpt-server.mjs`, `.cursor/mcp.json`, `package.json` |
| 2026-05-01 | PDF에서 빠른정답/해설참고로 지정된 제외 페이지에서는 `문제 저장` 및 `해설 생성`을 차단하고, 문제 페이지로 이동하라는 명확한 안내 메시지를 추가 | 참고 전용 페이지에서 생성을 시도할 때 비전 사전검증 실패(0점)로 오해가 발생해, 원인/조치 경로를 즉시 이해할 수 있도록 UX를 보정 | `src/app/page.tsx` |
| 2026-05-01 | 객관식 정답 보정에서 `선택지 첫 값` 강제 대입 로직을 제거하고, 정답 미검출 시 `-`로 유지하도록 변경. 동시에 해설 본문 앞의 문제번호 재출력(예: `17.`) 금지 규칙 추가 | 잘못된 빠른정답(특히 1번으로 쏠림)과 문항 번호 오인 표시를 줄여 문항 지정과 결과 정합성을 높이기 위함 | `src/app/page.tsx`, `src/app/api/generate-explanation/route.ts`, `src/app/api/hml/append-solution/route.ts` |
| 2026-05-01 | 학생용 가독성 기준으로 수식 표기 정책을 `LaTeX 금지 + 조합 nCk 고정`으로 강화하고, 저장 단계에서 `\\binom`, `\\frac` 등 LaTeX 잔여 표기를 일반식으로 치환 | 결과 문서에 `\\binom{}` 같은 코드형 수식이 노출되어 학생이 읽기 어려운 문제를 해소하고 교육과정 표기 일관성을 확보하기 위함 | `src/app/api/generate-explanation/route.ts`, `src/app/api/hml/append-solution/route.ts`, `src/app/api/save-result/route.ts` |
| 2026-05-01 | 해설 제작 단계를 세분화(`문제풀이 -> 해설 선택 -> 빠른정답 확정 -> 해설지 생성`)하고, 해설 다중안 반영 정책(모두/선택)을 UI에서 명시적으로 선택하도록 추가 | 운영자가 문항별 의사결정을 단계적으로 통제해 정확도를 우선 확보할 수 있도록 워크플로우를 분리 | `src/app/page.tsx` |
| 2026-05-01 | 프론트 해설 파서의 `[해설]` 섹션 추출 정규식을 보정(다음 헤더가 없는 경우에도 끝까지 안정 추출)하고, 생성 응답 검증에 최소 해설 분량 기준을 추가 | `[정답] 해설참고`만 반복되고 해설 본문이 비는 출력을 줄이기 위해 추출/검증 경계를 동시에 강화 | `src/app/page.tsx`, `src/app/api/generate-explanation/route.ts` |
| 2026-05-01 | 저장 API의 텍스트 정규화에서 줄바꿈을 보존하도록 변경해 문항별 `[해설]` 본문 파싱 안정성을 개선 | 공백 일괄 축약으로 문항 경계/해설 줄구조가 무너져 본문이 누락되는 케이스를 완화 | `src/app/api/save-result/route.ts` |
| 2026-05-01 | DOCX 양식을 `빠른 정답 2열 + 해설 2단` 구조로 재정의하고, 문항 유형별 빠른정답 표기(객관식 번호/단답형 값/서술형 `해설참고`)를 적용 | `test2` 양식 대비 포맷 불일치(빠른정답 배치/표기 규칙)와 서술형 처리 혼선을 줄이기 위해 출력 규격을 명시적으로 고정 | `src/app/api/save-result/route.ts`, `src/app/api/hml/append-solution/route.ts` |
| 2026-05-01 | 해설 생성 프롬프트에 `문제풀이→빠른정답→해설` 내부 순서를 강제하고, 중간 잘림(미완결) 응답 감지/재시도 규칙을 추가 | 일부 문항에서 해설이 중간에 끊겨 저장되는 품질 이슈를 줄이고, 빠른정답 확정 후 해설 작성 흐름을 일관화하기 위함 | `src/app/api/generate-explanation/route.ts`, `src/app/api/hml/append-solution/route.ts` |
| 2026-05-01 | 편집 커서 가시성을 높이기 위해 문제 지정 영역에 고대비 십자 커서(검정+흰 외곽선)를 적용하고, 시험지 클릭 시 즉시 선택 하이라이트가 보이도록 처리 | 흰색 계열 배경에서 기본 커서 식별이 어려웠고, 파일 클릭 후 반응이 느리게 체감되는 UX를 완화하기 위함 | `src/app/page.tsx` |
| 2026-05-01 | PDF 페이지 렌더링 성능 개선을 위해 `pdfjs` 모듈/문서 객체 캐시를 도입하고 렌더 스케일을 2.0 -> 1.7로 조정 | 페이지 이동/초기 편집 진입 시 같은 PDF를 반복 파싱하던 병목을 줄여 전환 속도를 개선하기 위함 | `src/app/page.tsx` |
| 2026-05-01 | 수동 지정/대기열 UI의 `영역 박스` 라벨을 `문제 박스`로 통일하고 박스 번호를 `문제 n` 형식으로 정리 | 작업 중 라벨이 `그림/영역`으로 혼재되어 실제 문항 번호 인지에 혼란이 있어, 운영자가 문제 단위로 직관적으로 확인하도록 정합화 | `src/app/page.tsx` |
| 2026-05-01 | PDF 페이지 지정 UI에 `빠른정답 없음`, `해설참고 없음` 체크박스를 추가하고 체크 시 해당 페이지 입력/검증을 비활성화하도록 반영 | 빠른정답/해설 참고 페이지가 없는 실사용 케이스를 입력 실수 없이 더 직관적으로 처리하기 위함 | `src/app/page.tsx` |
| 2026-05-01 | 문제 지정 방식을 구분선/세로선 기반에서 영역 박스 기반으로 전환하고, 페이지 저장 로직도 영역 박스를 문제 단위로 직접 저장하도록 변경 | 실사용에서 구분선/세로선 조작 복잡도가 높아 작업 속도를 저해해, 드래그 박스 중심의 직관적 지정 방식으로 단일화할 필요가 있었음 | `src/app/page.tsx` |
| 2026-05-01 | 결과 저장 버튼에서 `작업 완료 폴더로 저장`(중복 저장 경로) 기능을 제거하고 PDF 저장만 유지 | 현재 생성 플로우에서 작업 완료 폴더 업로드/저장이 자동으로 수행되어 수동 저장 버튼은 중복 동작 및 UX 혼란을 유발함 | `src/app/page.tsx` |
| 2026-05-01 | 빠른정답/해설 참고 페이지가 없는 케이스를 정상 시나리오로 처리하고, 페이지 지정값이 범위를 벗어나면 체크 경고를 표시하도록 보강 | 실제 운영에서 정답/해설 참고 페이지가 없는 시험지가 존재해도 생성이 중단되면 안 되며, 잘못 입력된 페이지 지정은 조기에 인지할 필요가 있음 | `src/app/page.tsx` |
| 2026-05-01 | PDF 작업에서 빠른정답 페이지/해설참고 페이지를 사용자가 직접 지정하는 기능을 추가하고, 지정 페이지는 필수 작업 페이지에서 자동 제외하도록 변경 | 실제 시험지 배치에서 정답/해설 페이지를 별도로 제공하는 케이스가 많아, 문제 페이지와 참고 페이지를 분리 운영할 필요가 있었음 | `src/app/page.tsx`, `src/app/api/generate-explanation/route.ts` |
| 2026-05-01 | 영역지정 메인 정책을 코드에 반영: HML 실행 모드를 `manual`(기본) / `auto_assist`(보조)로 분리하고, 자동 보조 품질 이슈 시 수동 전환 가이드를 응답에 포함 | 자동 추출 편차로 운영 안정성이 떨어지는 문제를 줄이기 위해 기본 동선을 수동으로 고정하고 자동은 보조 역할로 제한 | `src/app/page.tsx`, `src/app/api/hml/append-solution/route.ts` |
| 2026-05-01 | 운영 스모크를 모드 분리(`HML_SMOKE_MODE`) + 샘플 선택(`HML_SMOKE_SAMPLES`) + PASS 컷으로 재정의하고, `smokeFast` 커버리지 판정을 처리 문항 기준으로 보정 | 모드별 품질을 동일 기준으로 비교하고, `smokeFast` 축약 실행에서 발생하던 PASS 왜곡을 제거하기 위함 | `scripts/hml-smoke.mjs`, `src/app/api/hml/append-solution/route.ts` |
| 2026-05-01 | `smokeFast` 모드의 커버리지 판정 분모를 전체 정답 수가 아닌 처리 문항 수 기준으로 보정하고, 스모크 스크립트에 샘플 선택 실행(`HML_SMOKE_SAMPLES`)을 추가 | `smokeFast`가 문항 수를 8개로 제한할 때 기존 커버리지 계산이 과도하게 낮게 나와 PASS 판정 왜곡이 발생했음. 또한 장시간 샘플을 분리 실행해 병목 원인을 빠르게 좁히기 위해 샘플 선택 기능이 필요했음 | `src/app/api/hml/append-solution/route.ts`, `scripts/hml-smoke.mjs` |
| 2026-04-30 | 운영 검증 자동화를 위해 대표 4개 HML 스모크 스크립트(`npm run smoke:hml`)를 추가하고, 요청 타임아웃(`HML_SMOKE_TIMEOUT_MS`)을 지원하도록 구성 | 수동 재검증은 반복 비용이 높아 대표 샘플 PASS/실패를 동일 기준으로 빠르게 확인할 자동화 도구가 필요했음. 타임아웃을 넣어 장시간 정지 시 원인(시간 초과)을 즉시 분류 가능하게 함 | `scripts/hml-smoke.mjs`, `package.json` |
| 2026-04-30 | 수동 영역지정 보강: 구분선 모드에서 좌표(%) 직접 입력(X/Y)으로 구분선을 추가하는 기능을 도입 | 클릭 오차/화면 배율 영향으로 구분선 위치가 어긋나는 케이스를 줄이고, 운영자가 의도한 위치를 정밀하게 지정할 수 있도록 하기 위함 | `src/app/page.tsx` |
| 2026-04-30 | 생성 안정성 가드 보강: Gemini 실패 후 GPT 백업도 실패하면 문항 단위 수동검토 상태로 대체하고 전체 작업은 계속 진행하도록 변경 | 특정 환경에서 OpenAI 모델 접근 제한(404)으로 전체 배치가 중단되던 운영 리스크를 제거하기 위함 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | 전문가 토의(파싱/품질/운영) 후 중요작업 우선으로 원문 구조 디코더 3차 2차분을 적용: `ENDNOTE` 블록에서 번호/보기 텍스트를 문항으로 복원하는 저품질 보완 경로 추가 | 봉명고 샘플처럼 본문 문항 텍스트가 거의 누락된 HML에서 기존 경로가 2문항에 고착되어 운영 불가능했음. `ENDNOTE` 기반 복원을 추가해 최소 문항 커버리지를 확보해야 했음 | `src/app/api/hml/append-solution/route.ts`, `docs/*` |
| 2026-04-30 | 원문 구조 디코더 3차 1차분(`태그 계층 기반 번호-본문-보기 결합`)을 추가하고 수동 문항 선택(`1-30`) 포함 재스모크를 수행 | 오토넘버 보조 + 번호앵커 방식만으로는 대표 샘플 저커버리지 문제가 남아 있어, 문항 신호/선택지 블록 결합 규칙을 추가 검증함. 다만 봉명고 샘플은 여전히 `questionCount=2`, `coverageRatio=10%`로 구조 복원 한계가 확인되어 원문 태그 구조 직접 디코딩 단계가 필요 | `src/app/api/hml/append-solution/route.ts`, `docs/*` |
| 2026-04-30 | HML 원본 해설 생성에 수동 문항 선택 입력(`manualQuestionSelection`, 예: `1-30`, `1,3,5-8`)을 추가하고, 오토넘버는 보조 추출로 유지 | 학교 시험지 25~30문항 운영에서 사용자가 직접 범위를 지정해 생성 대상을 통제하려는 실사용 요구를 반영 | `src/app/page.tsx`, `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | 원문 구조 디코더 2차로 `정답표 번호 앵커 기반` 문항 세그먼트 추출(평문 번호분할 + 문단 AUTONUM 결합)을 추가하고 재스모크를 수행 | 대표 샘플(봉명고)에서 기존 구조/평문 추출이 2문항 수준으로 고착되어, 정답표 번호를 문항 경계 힌트로 사용하는 보강 경로가 필요했음. 다만 재검증 결과 `questionCount=4`, `coverageRatio=20%`로 여전히 저커버리지여서 태그 계층 기반 3차 디코더가 필요함을 확인 | `src/app/api/hml/append-solution/route.ts`, `docs/*` |
| 2026-04-30 | HML 핵심 경로 전문가 리뷰에서 확인된 안정성 리스크를 수정: (1) 정답 불일치 재시도 시 프로필/백업 경로 누락 보완, (2) `quickAnswerMode` 판정을 최종 문항 집합(`workingQuestions`) 기준으로 정합화 | 재시도 중 예외 전파로 전체 생성이 중단되거나, AI 재추출 이후 모드 판정이 실제 문항 집합과 어긋날 수 있는 위험을 제거 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | 사용자 주요 요청 파일군(해동고/부산중앙여고/보인고/봉명고)을 대표 샘플 프로필(`core-request-set`)로 등록하고, 해당 프로필은 구조 복원보다 해설 확보 우선 경로를 기본 사용 | 실제 운영 입력 분포를 반영해 추출 안정성을 높이고, 복잡한 구조 복원 실패로 인한 생성 중단을 줄이기 위함 | `src/app/api/hml/append-solution/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | 저커버리지 파일 대응을 위해 Gemini 기반 AI 문항 추출 fallback(JSON 배열)을 추가하고, 기존 추출보다 많을 때만 교체하도록 보수 적용 | 구조/평문 규칙이 모두 약한 파일에서 문항 수 회복 여지를 만들기 위한 보완 경로가 필요했음. 다만 현재 대상 샘플에서는 AI 추출 0건으로 추가 튜닝이 필요함을 확인 | `src/app/api/hml/append-solution/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | `ENDNOTE` 제거 정규식을 `ENDNOTESHAPE`와 구분되도록 태그 경계 기반으로 수정하고, fallback 선택은 커버리지 우선(본문/전체 평문 중 더 많은 문항)으로 변경 | `ENDNOTE` 패턴 오매치로 본문이 과삭제되는 문제와 본문전용 추출 감소(1문항) 이슈를 동시에 완화하기 위함 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | 매 작업 전 전문가 토의(파싱/품질/운영) 후 구현을 강제하는 상시 규칙(`expert-discussion-workflow.mdc`)을 추가 | 사용자 요청에 따라 작업 방식 자체를 표준화하고, 상황 정리-결론-구현-검증 사이클을 고정하기 위함 | `.cursor/rules/expert-discussion-workflow.mdc` |
| 2026-04-30 | 문단 추출 입력을 `ENDNOTE` 제외 본문으로 제한하고 문항 시작 완화 판정(`relaxed`)을 문단 추출에도 적용 후 재스모크 수행 | 정답표 혼입이 문단 추출 신호를 약화시키는 가설을 검증했으나, 대상 샘플은 여전히 문단/구조 추출 0건으로 추가 분석 필요 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | `AUTONUM` 블록 기반 구조 추출기를 추가하고 스모크 재검증을 수행했으나, 특정 샘플은 여전히 구조 추출 0건으로 평문 대체 경로에 머무름 | 단순 문단/평문 추출 한계를 넘기기 위해 구조 추출을 시도했지만, 해당 파일은 `AUTONUM`과 본문 결합 형식이 달라 추가 규칙이 필요함을 확인 | `src/app/api/hml/append-solution/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | HML 추출 신호가 약한 파일 대응을 위해 번호 기반 완화 추출 모드(`relaxed`)를 추가하고 스모크 재검증을 수행 | 특정 수학비서 파일에서 `[문제]/구하시오` 신호가 약해 문항 누락이 발생해, 신호 의존도를 낮춘 백업 추출 경로가 필요했음 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | 로컬 실행 환경에 `OPENAI_API_KEY`를 설정해 HML 해설 생성의 GPT 백업 경로를 즉시 사용 가능 상태로 전환 | Gemini 실패 시 자동 백업 경로가 코드상 존재해도 런타임 키가 없으면 동작하지 않기 때문에 로컬 검증/운영 연속성을 확보 | `.env.local`, `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | 문항별 실패 패턴 대응을 위해 노이즈 문항 전용 생성 프로필(`noisy`)을 도입하고, 모델 순서/온도/프롬프트를 차등 적용한 뒤 GPT 백업에서도 동일 프로필을 사용 | 수식 노이즈 문항에서 일반 프롬프트 재시도만으로는 성공률이 낮아, 입력 정제와 안정적 생성 설정을 함께 적용할 필요가 있었음 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | 파싱 진단에 노이즈 문항 수(`noisyQuestionCount`)를 추가하고 프론트 상태 메시지에 노출 | 운영자가 특정 파일의 난이도/노이즈 수준을 즉시 파악해 후속 튜닝 우선순위를 잡을 수 있도록 개선 | `src/app/api/hml/append-solution/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | HML 문항 텍스트 노이즈를 자동 점수화해 문단 추출본과 평문 추출본을 문항 번호 기준으로 교차 대체하고, Gemini 실패 시 `OPENAI_API_KEY`가 있으면 GPT 백업 생성 경로를 추가 | 수식/태그 노이즈가 심한 문항에서 단일 추출/단일 모델 실패가 누적되어 전체 생성 안정성을 떨어뜨리는 문제를 완화 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | HML 진단에 GPT 백업 사용 횟수 및 문항별 보정 노트(최대 10개)를 포함하고 프론트에서 요약 노출 | 운영자가 생성 품질 저하 원인(추출 보정/모델 백업 사용)을 빠르게 추적할 수 있도록 가시성 강화 | `src/app/api/hml/append-solution/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | HML 처리 결과에 PASS 기준(최소 문항 수/커버리지/불일치율) 기반 품질 판정을 추가하고, 경고 사유를 프론트에 노출 | 단순 성공 응답만으로는 샘플별 실패를 늦게 발견해 운영 리스크가 커서, 생성 직후 품질 상태를 즉시 확인 가능하게 개선 | `src/app/api/hml/append-solution/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | HML 파서를 `문단 우선 추출 + 평문 대체` 이중 전략으로 개편하고, 빠른정답 추출은 원본 `ENDNOTE` 정답표 우선으로 전환 | 샘플별 형식 편차가 커 단일 정규식 추출 실패 시 품질 변동이 컸고, 정답표는 원본문맥(ENDNOTE)에서 직접 읽는 편이 안정적이기 때문 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | HML 생성 응답에 파싱 진단(`strategy`, 문항 추출 수, 정답 원천)을 추가하고 UI 성공 메시지에 노출 | 운영 중 실패 원인(문단 파싱 실패/대체 경로 사용/정답표 인식 방식)을 즉시 파악해 후속 튜닝 속도 향상 | `src/app/api/hml/append-solution/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | 시험지 목록에서 HML 선택 시 이미지 단계로 보내지 않고 HML 전용 워크플로우로 즉시 전환(목록 파일 타입 배지, 선택 HML 표시, 생성 통계 메시지 노출) | HML 클릭 시 깨진 미리보기 화면으로 넘어가던 UX 혼란 제거, 수학비서 원본 처리 동선 명확화 | `src/app/page.tsx` |
| 2026-04-30 | HML 텍스트 추출을 태그별 분리 병합 방식에서 문단 순서 보존 방식으로 교체하고 `AUTONUM` 번호를 문항 시작 인식에 반영 | 수학비서 HML에서 문항/수식/정답 순서가 뒤섞여 비정상 번호(예: 6), 4))만 추출되던 문제 해결 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | 수학비서형 HML 처리에 빠른정답 단계 로직을 도입(전체 제공 시 검증, 부분 제공 시 누락 정답 자동 보완 + 검증) | 운영 입력 파일의 빠른정답이 부분 누락/혼재되는 현실 케이스에서 해설 생성 품질과 일관성 확보 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | 시험지 목록/파일 API 허용 확장자에 한글 문서(`.hml`, `.hwp`, `.hwpx`)를 추가하고, UI에서 한글 문서 선택 시 HML 전용 워크플로우 안내 메시지를 노출 | Drive `시험지` 폴더에 올린 한글 파일이 목록에 보이지 않거나 미리보기 동작과 혼동되는 문제 완화 | `src/app/api/exams/route.ts`, `src/app/api/exams/file/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | HML 문항 추출기를 문단/스크립트 경계 기반으로 확장하고 번호 인식 패턴을 `1)`, `1.`, `1번`까지 지원 | 원본 HML마다 번호 표기가 달라 기존 정규식이 빈번히 실패하던 문제 완화 | `src/app/api/hml/append-solution/route.ts` |
| 2026-04-30 | 시험지 목록 자동 새로고침 타이머를 제거하고, 버튼 클릭 기반 수동 새로고침으로 변경 | 사용자 조작 없이 목록이 바뀌는 혼란과 선택 중 UI 흔들림 방지 | `src/app/page.tsx` |
| 2026-04-30 | A안 구현: 원본 HML 업로드 후 문항 추출 → 문항별 해설 생성 → 원본 뒤에 해설을 붙인 DOCX 저장 API 추가 | PDF 이미지 기반이 아닌 원본문서 기반 후처리(append) 워크플로우 요구 대응 | `src/app/api/hml/append-solution/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | DOCX 저장 포맷을 `빠른 정답(단일 섹션)` + `해설(2단 컬럼 섹션)`으로 분리하고, LaTeX 표기를 텍스트 친화적으로 단순화 | `[TEST] TEST 2.pdf`에 가까운 가독성(2단, 정답/해설 분리, 수식 난독화 완화) 요구 반영 | `src/app/api/save-result/route.ts` |
| 2026-04-30 | 좌측 작업 패널을 단계 집중형으로 재구성(현재 단계 안내 추가, 고급 옵션 접기, AI 원문 기본 비노출) | 불필요한 정보/버튼을 줄이고 초보 사용자도 순서대로 진행 가능하게 UX 단순화 | `src/app/page.tsx` |
| 2026-04-30 | 우측 액션 버튼을 단계형 노출로 개편(해설 생성 전에는 저장 버튼 숨김, 생성 후에만 저장 CTA 표시) | 비활성 버튼이 먼저 보여 혼란을 주는 UX를 제거하고 작업 흐름 집중도 개선 | `src/app/page.tsx` |
| 2026-04-30 | 문제 추출 비전 사전검증 API(`/api/precheck-extraction`)를 추가하고 생성 전 선차단 정책을 적용 | 크롭 크기 기준만으로 놓치던 누락(선택지/조건/식)을 모델 기반으로 추가 판별 | `src/app/api/precheck-extraction/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | 해설 생성 API 재시도 지시를 이슈 유형별(형식/정합/교육과정 이탈)로 분기하고 UI에 품질 경고 플래그를 노출 | 자동 보정 발생 사실과 원인을 운영자가 확인 가능하게 하여 품질 추적성 강화 | `src/app/api/generate-explanation/route.ts`, `src/app/page.tsx` |
| 2026-04-30 | 교육과정 외 용어/기호(로피탈, 편미분, 선형대수 등) 감지 필터를 생성 검증에 추가하고, 감지 시 재생성 지시로 교정 | 대학수학 용어 유입으로 학생 눈높이 해설 품질이 흔들리는 문제를 자동 차단 | `src/app/api/generate-explanation/route.ts` |
| 2026-04-30 | 생성 결과 검증에 정답-본문 모순/형식 혼합(객관식·주관식) 감지를 추가하고, 실패 시 재생성 지시에 포함 | 형식은 맞아도 내용 정합이 어긋나는 응답을 자동으로 1차 정리 | `src/app/api/generate-explanation/route.ts` |
| 2026-04-30 | 생성 결과 포맷 검증(`[정답]`, `[해설]`) 실패 시 동일 모델로 1회 자동 재생성하도록 적용 | 형식 누락으로 파서/저장 단계 품질 저하되는 케이스 감소 | `src/app/api/generate-explanation/route.ts` |
| 2026-04-30 | 해설 생성 전 문제 추출 사전검증(크롭 크기/비율/면적) 도입, 기준 미달 시 생성 차단 | 선택지/조건 누락 상태로 잘못 생성되는 케이스 선제 차단 | `src/app/page.tsx` |
| 2026-04-30 | 작업 규칙을 `.cursor/rules/docs-workflow.mdc`로 고정(작업 전 docs 3종 확인, 작업 후 docs 기록 의무화) | 작업 누락/맥락 단절 방지, 연속 작업 안정성 확보 | `.cursor/rules/docs-workflow.mdc`, `docs/plan.md`, `docs/checklist.md` |
| 2026-04-30 | Google Drive 저장 시 `media.body`를 `Readable.from(buffer)` 스트림으로 변경 | Vercel 런타임에서 `body.pipe is not a function` 500 오류 해결 | `src/lib/googleDrive.ts` |
| 2026-04-30 | Drive 모드에서는 로컬 `작업 완료` 폴더 `mkdir`를 건너뛰도록 수정 | `/var/task/작업 완료` ENOENT 오류 해결 | `src/app/api/save-result/route.ts` |
| 2026-04-30 | `/api/exams`, `/api/exams/file`, `/api/save-result` 에러 메시지 상세화 | 운영 중 원인 추적 속도 개선 | `src/app/api/exams/route.ts`, `src/app/api/exams/file/route.ts`, `src/app/api/save-result/route.ts` |
| 2026-04-30 | Drive 인증을 서비스 계정 키 방식에서 OAuth(`CLIENT_ID/SECRET/REFRESH_TOKEN`) 방식으로 전환 | 조직 정책(`iam.disableServiceAccountKeyCreation`)으로 서비스 계정 키 생성 불가 | `src/lib/googleDrive.ts`, `.env.example` |
| 2026-04-30 | Gemini 시스템 프롬프트를 `[정답]`, `[해설]` 통합 문서 형식으로 교체 + 교육과정 외 용어 금지 강화 | 학생용 해설 품질 통제 및 원장 요구 포맷 반영 | `src/app/api/generate-explanation/route.ts` |
| 2026-04-30 | 프론트 파서를 신규 형식(`[정답]`, `[해설]`) 우선 파싱 + 기존 포맷 하위호환 유지로 변경 | 배포 중 포맷 전환 시 사용자 경험 단절 방지 | `src/app/page.tsx` |
| 2026-04-30 | DOCX 출력 양식을 2단 표에서 섹션형 문서로 변경 | 테스트 양식(빠른 정답/해설 중심)과 출력 형태 일치 | `src/app/api/save-result/route.ts` |

## 현재 리스크
- OAuth 토큰(`GOOGLE_REFRESH_TOKEN`)이 `GOOGLE_CLIENT_ID/SECRET`와 다른 세트일 경우 `invalid_grant` 재발 가능
- 민감정보(클라이언트 시크릿/토큰) 노출 이력 존재: 재발급 및 키 회전 필요
- 시험지/작업완료 폴더명이 Drive에서 중복될 경우 잘못된 폴더를 선택할 위험

## 운영 메모
- Drive 폴더 기본값: `해설제작/시험지`, `해설제작/작업완료`
- Vercel env 필수: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GEMINI_API_KEY`
- 저장 실패 시 우선 확인 로그: `/api/save-result`
