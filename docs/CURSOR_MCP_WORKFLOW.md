# Cursor + MCP 해설 워크플로 (전문가 검토 요약)

문서 기준일: 2026-05-02

**품질 최우선 한 페이지 요약:** [BEST_QUALITY_WORKFLOW.md](./BEST_QUALITY_WORKFLOW.md) — 여기서는 MCP·체크리스트·복사용 문구를 상세히 다룬다.

### Base64가 예전엔 없던 것처럼 보이던 이유 (Gemini·OpenAI 공통)

| 질문 | 정리 |
|------|------|
| **이전엔 Base64 없이 MCP만 쓴 것 아닌가?** | **API는 원래 이진(이미지)을 JSON으로 보낼 때 Base64(또는 URL)로 싣는 것이 일반적**이다. **숨긴 것이 아니라**, 윈도에서 잘라 **채팅에 이미지로 붙이거나** IDE가 첨부를 대신 인코딩해 주면 **사용자 화면에는 Base64가 안 보인다.** |
| **지금은 왜 Base64·길이 이야기가 나오나?** | **에이전트가 `call_mcp_tool`로 `imageBase64` 문자열을 한꺼번에 실을 때** JSON 메시지가 길어져 **도구/세션 쪽 한도**에 걸릴 수 있다. **같은 MCP라도 “사람이 채팅에 그림 첨부”와 “에이전트가 초대형 문자열로 호출”은 경로가 다르다.** |
| **Gemini vs OpenAI** | 둘 다 비전은 **같은 계열(바이너리→API)** 이다. 차이는 **모델명·키·할당량**이지 “한쪽만 Base64”가 아니다. OpenAI는 **종량제(토큰)** 이므로, 앱 교차검증은 **프로필별로 mini/4o를 나누는 하이브리드**가 기본이다([models.md](./models.md) 「하이브리드 라우팅」). |
| **수동 크롭 vs 툴 크롭, 문제는 어디서?** | **Base64 때문이 아니라** 보통 아래에서 생긴다: 해상도·압축(PNG/JPEG)·여백이 많음·**영역이 빗나감**·내보내기 버그·ZIP/폴더 혼동. **품질 목적이면 크롭은 선명·문항만 꽉 차게** 두고, 길이 문제는 **채팅 첨부·앱 API** 등 **한도 덜한 경로**로 우회하는 편이 낫다. |

**실무 권장:** 이미지가 크거나 에이전트 MCP 호출이 불안하면 **Cursor 채팅에 크롭 PNG를 직접 첨부**하고, 같은 내용의 **`task` 지시문**(출력 형식·단일 문항)만 텍스트로 주거나, **로컬 Next `/api/generate-explanation`** 로 파일 업로드 동선을 쓴다.

**“예전엔 빨랐는데 지금은 느리다” Git·코드 분석:** [HISTORY_SPEED_ANALYSIS.md](./HISTORY_SPEED_ANALYSIS.md)

## 결론: 구조적으로 가능한가?

**가능합니다.** 이유는 다음과 같습니다.

1. **MCP**는 Cursor가 로컬에서 띄운 프로세스와 표준 프로토콜로 통신합니다. 여기서 **Gemini** 또는 **OpenAI(Chat Completions)** 를 호출해 **해설 초안 텍스트**만 반환하는 도구를 둡니다.
2. **Cursor**는 그 텍스트를 받아 형식·오류·톤을 다듬고, 프로젝트 파일이나 CLI로 **산출물을 기록**할 수 있습니다.
3. **DOCX**는 이미 `src/lib/examExplanationDocx.ts`의 `buildExamExplanationDocxBuffer`로 생성 가능합니다. Next API(`/api/save-result`)와 동일 로직을 **`npm run write-final-docx`** CLI로도 호출할 수 있게 두었습니다.
4. **MCP ↔ 웹 API 프롬프트 통일:** `mcp/gemini-explanation.mts` 는 호출마다 `buildMcpSystemInstruction()`(= `prompts.ts` 의 전체 시스템 지시)를 **Gemini `systemInstruction` / OpenAI `system` 역할**로 넣는다. 예전에는 Cursor `task` 만 모델에 가서 규칙이 빠질 수 있었고, 그 차이가 초안·DOCX 불일치로 이어질 수 있다. 난이도 프로필만 바꿀 때: MCP 환경변수 `GEMINI_MCP_SOLVER_PROFILE=easy|balanced|killer`(기본 `balanced`). 해설 `.md` 편집 시 Cursor 규칙: `.cursor/rules/explanation-markdown-latex.mdc`.

한계(의도적으로 분리):

- MCP 서버는 **“원문 생성”**까지만 담당합니다. 최종 품질 책임은 **사람 + Cursor 대화**에 둡니다.
- Cursor가 파일을 쓰는 것은 **에이전트/채팅에서의 도구 사용**에 의존합니다. 완전 무인 배치가 아니라, **대화 안에서 “이 내용으로 DOCX 저장”**을 시키는 모델에 가깝습니다.

### 원장님 확정 운영 원칙 (2026-05-03)

**주 동선:** **MCP로 해설 초안** → **Cursor로 중재**(제미나이·오픈에이아이 왕복·한 벌 확정) → 필요 시 **`write-final-docx` / `save-result`** 로 **`해설지 최종본`**.

| 구분 | 기대 수준 |
|------|-----------|
| **전체 틀** | `[문항 n]`·`[정답]`·`[해설]`·DOCX 자리맞춤 등은 **대략 맞추면 됨** — 형식 오류만 없게 하면 충분한 경우가 많다. |
| **해설 내용** | **여기가 핵심** — 정답·전개·수식·검산이 **좋아야 함**. |
| **중재(Cursor)의 실제 일** | 단순 말솜씨가 아니라, **MCP로 받은 초안을 검수·수정**하는 것 — 아래 **「중재 검수 체크리스트」** 를 따른다. |

### 중재 검수 체크리스트 (원장님 기준)

MCP·API로 받은 텍스트를 **최종본에 넣기 전**에 Cursor에서 다음을 본다.

| 항목 | 할 일 |
|------|--------|
| **근사·회피 표현** | ≈, 어림, 대충, 가장 가까운, 참 정도로 등 **근사로 결론 내리는 표현**이 있으면 제거하거나 **교과서형 단일 결론**으로 고친다. (프로젝트 프롬프트와 동일 취지) |
| **객관식 vs 단답** | 문제가 **객관식(보기 ①~⑤)** 인데 `[정답]`에 **숫자·식만** 있고 보기 번호가 안 맞으면, **보기 번호**로 통일한다. 반대로 **단답형**이면 수치·식이 문제 조건과 맞는지 본다. |
| **정답–해설 일치** | `[정답]` 한 줄과 `[해설]` 마지막 결론·보기 선택이 **같은 답**을 가리키는지 확인한다. |
| **형식** | `[정답]`·`[해설]` 헤더 규칙, 수식은 `$...$` KaTeX 등 **저장 호환 형식** 유지. |
| **길게 붙은 오답** | 다른 문항 풀이가 붙었거나 `[해설]`이 두 갈래면 **한 문항분만** 남긴다. |

### MCP로 **이미지(크롭)** 보내서 풀기 → Cursor가 참고용 대수(1~6) 스타일로 검수

MCP 도구 **`generate_math_explanation`** / **`generate_math_explanation_openai`** 에 다음 인자를 쓸 수 있다.

| 인자 | 설명 |
|------|------|
| `task` | 출력 형식(`[정답]`/`[해설]`), 단일 문항만 풀 것 등 지시 |
| `imageBase64` | 크롭 PNG/JPEG의 **base64** (또는 `data:image/png;base64,...`) |
| `imageMimeType` | 예: `image/png`, `image/jpeg` (`imageBase64` 있을 때) |

**원장님 동선:** 문항 이미지마다 MCP로 비전 풀이 → 받은 텍스트를 Cursor에서 **`참고용 문제/대수(수학1)`** (1~6단원 HML에서 발췌한 짧은 예시 스타일)과 대조해 **근사 표현·객관식 표기 오류** 등을 걸러낸 뒤 → **`합본_편집용.md`** 수준으로 모아 **`npm run write-final-docx`**.

※ 참고 HML 전체를 MCP에 넣지 않아도 되고, Cursor 채팅에 **단원별 한두 문단**만 붙여 “이 말투·전개로 다듬어라”고 하면 된다.

### `postToolUse` 훅: MCP 해설 직후 체크리스트 자동 주입

에이전트가 **`generate_math_explanation`** / **`generate_math_explanation_openai`** 를 호출해 성공하면, Cursor가 **`postToolUse`** 훅을 돌리고 스크립트(`.cursor/hooks/mcp-explanation-post-tool.mjs`)가 **`additional_context`** 로 **필수 다듬기 체크리스트**를 대화에 붙인다. (객관식 `[정답]` 표기, 서술형 `해설참고`, LaTeX·`$` 짝, 정답–해설 일치, 회피 문구·재풀이, **검수 완료본만** `문항##_API초안.md`·`합본_편집용.md` 저장, 마무리 보고 문장.)

| 위치 | 용도 |
|------|------|
| 저장소 `highroad-math-solution/.cursor/hooks.json` | 폴더를 Cursor **프로젝트 루트**로 열었을 때 |
| 상위 워크스페이스 `시험지 해설 제작/.cursor/hooks.json` | 상위 폴더를 루트로 둔 현재 구성(같은 스크립트를 `node highroad-math-solution/.cursor/hooks/...` 로 호출) |

규칙 백업: `.cursor/rules/mcp-explanation-post-review.mdc` (`alwaysApply`). 훅이 안 먹으면 Cursor **Hooks** 설정·출력 채널을 보고, `hooks.json` 저장 후에도 로드가 안 되면 **Cursor 재시작**을 시도한다.

### Cursor에 붙여 넣는 중재 지시문 (복사용)

아래를 채팅에 넣고, 그 아래에 **MCP 초안 전문** 또는 **`합본_편집용.md`** 내용을 붙인다.

```
아래는 시험 문항 해설 초안이다. 수정 없이 두지 말고 다음을 반드시 점검해 고친 뒤, 같은 형식([문제] 선택 / [정답] / [해설])으로 전체를 다시 출력해라.

1) 근사·어림·≈·대충·가장 가까운 등으로 결론을 흐리지 말 것.
2) 객관식이면 [정답]은 보기 번호(예 ③) 등 문제 유형에 맞게 쓸 것. 단답만 던져 놓고 보기와 안 맞으면 고칠 것.
3) [정답]과 [해설] 결론이 같은 답을 가리키는지 검산할 것.
4) 한 문항만 남기고 다른 문항 풀이가 붙어 있으면 제거할 것.

초안:
```

---

- **`batch:crops-to-docx` (기본, `--drafts-only` 없음)** = 로컬 Next의 **`/api/generate-explanation`만** 연속 호출 → 곧바로 **해설지 최종본 DOCX**. **MCP도 아니고, Cursor 중재도 끼어 있지 않음** — “급행·1차 밀개”에 가깝다.
- **`batch:crops-to-docx -- --drafts-only`** (또는 `npm run batch:crops-drafts`) = API 초안만 **`해설 작업중/<시험명>/`** 에 `문항##_API초안.md`, `합본_편집용.md` 로 저장(진행 로그·빠른정답·README 는 `.txt`), **DOCX는 안 씀**. 이후 **Cursor·MCP로 중재(위 검수)** 한 뒤 `npm run write-final-docx -- --body-file ...` 로 최종본.

**품질 우선**일 때는 기본 배치(바로 DOCX) 대신 **`--drafts-only` → 중재·검수 → write-final-docx** 를 쓰거나, **문항마다 Cursor+MCP**만 쓰면 된다.

## 권장 동선

### A. 원장님 확정: Gemini 1차 → OpenAI 2차(킬러·체크) → **중재 반복** → 최종본

1. **1차:** MCP **`generate_math_explanation`** — 문제 지문·크롭 맥락·출력 형식(`[정답]`/`[해설]`)을 `task`에 넣어 **Gemini 초안** 생성.
2. **2차(필요할 때만, 여러 번 가능):** MCP **`generate_math_explanation_openai`** 에 **1차 전문**과 “검산·보기 불일치 수정·형식 유지”를 `task`로 넣어 **OpenAI 검토본**을 받는다. (또는 `/api/generate-explanation` + **`EXPLANATION_CROSS_VERIFY=true`** 로 서버가 한 번에 2차까지 시도 — [models.md](./models.md).)
3. **중재(검수·계속):** 두 모델 출력이 다르면 **이미지·보기 기준**으로 한 벌로 합친 뒤, **위「중재 검수 체크리스트」**(근사 표현, 객관식/단답 표기, 정답–해설 일치 등)를 반드시 적용한다. 필요하면 **1→2를 다시 반복**한다.
4. **Cursor** — 체크리스트를 반영한 **최종 문구**로 `[문항 n]` 묶음, 톤·오타 정리.
5. **저장** — 아래「B」항목 5와 동일: `write-final-docx` 또는 `/api/save-result` 로 **`해설지 최종본`** 에 DOCX.

### B. 기본 권장 동선(요약)

1. **Railway / 로컬 앱** — `NEXT_PUBLIC_UI_MODE=crop` 이면 **크롭·Drive ZIP** 중심 UI만 사용.
2. **Drive**에서 문항 이미지·묶음 확보 후, Cursor에서 작업.
3. **MCP 도구** — `generate_math_explanation`(Gemini) 또는 `generate_math_explanation_openai`(OpenAI) 로 `task`에 문제·출력 형식을 넣어 초안 생성.
4. **Cursor** — 초안을 `[문항 n]`, `[정답]`, `[해설]` 형식으로 정리(프로젝트 기존 DOCX 파서와 호환).
5. **저장**
   - **1)** Cursor가 `해설지 최종본`에 맞는 `.md`/`.txt`를 쓰게 한 뒤  
     `npm run write-final-docx -- --exam-name "시험명" --quick-answer "..." --body-file ./path.txt`  
     (스크립트 엔트리는 프로젝트 루트의 `write-final-docx.mts` 입니다.)
   - **2)** 로컬에서 Next를 `full` 모드로 띄운 경우 기존처럼 `/api/save-result` 사용 가능(레거시 동선).

## MCP 설정 (전문가 점검 반영)

- **설정 파일:** **`시험지 해설 제작/.cursor/mcp.json`** 에 `gemini-gpt` 한 개만 둡니다. `highroad-math-solution/.cursor/mcp.json` 은 **비워** 두어 같은 서버가 두 번 뜨지 않게 했습니다.
- **핵심 원인(지속 Error):** Cursor가 워크스페이스를 **`%USERPROFILE%\.cursor\projects\...`** 같은 **프로젝트 미러**로만 잡는 경우가 있습니다. 그 루트에는 `node_modules` 가 없어 `${workspaceFolder}` 기반 상대 경로 MCP는 **실패**합니다. (`npm run check-api` 는 터미널에서 **실제 클론 폴더**로 `cd` 한 뒤 돌아가므로 OK인데 MCP만 Error인 패턴이 나옵니다.)
- **대응:** Cursor가 **`cwd`를 무시하거나 워크스페이스 루트(상위 `시험지 해설 제작`)만 쓰는 경우**가 있어, `args` 의 `tsx`·`gemini-explanation.mts` 경로는 **`./`가 아니라 `highroad-math-solution` 기준 전체 절대 경로**로 둡니다. (`cwd`도 동일 절대 경로로 맞춤.)
- **폴더를 옮기면:** `시험지 해설 제작/.cursor/mcp.json` 안 **`args` 두 줄 + `cwd` 한 줄**을 모두 본인 PC 경로로 바꿉니다.
- **API 키:** `highroad-math-solution/.env.local` 의 `GEMINI_*` / `OPENAI_*` 는 **`mcp/0-bootstrap.mjs`** 가 엔트리 로드 시 읽습니다.
- **실행 파일:** `mcp/gemini-explanation.mts`(도구: `generate_math_explanation`, `generate_math_explanation_openai`).
- **tsx 번들 주의:** MCP 엔트리에서 `../src/lib/geminiDefaultModels` 를 가져오면 **tsx가 번들할 때 export 해석이 깨져 프로세스가 즉시 종료**(`Connection closed`, `-32000`) 될 수 있다. 기본 모델 배열은 **`mcp/gemini-explanation.mts` 안에 `src/lib/geminiDefaultModels.ts` 와 동일한 값으로 유지**한다.
- **권장:** 가능하면 Cursor에서 **바탕화면의 `시험지 해설 제작`** 폴더를 직접 연다(미러만 열리면 혼동이 생기기 쉽습니다).
- Next `npm run build` 는 `tsconfig.json` 에서 `mcp`, `write-final-docx.mts`, `scripts` 를 exclude 합니다.

## 수동 점검

터미널에서(프로젝트 루트, 키 설정 후):

```bash
npm run check-api
```

키가 API에 통하는지 확인합니다.

```bash
npm run mcp:smoke
```

로컬에서 **실제 MCP stdio**(initialize → tools/list)까지 돌려 **Cursor와 동일한 `node` + tsx + `gemini-explanation.mts` 경로**가 살아 있는지 확인합니다. **여기서 OK인데 Cursor MCP만 Error**이면, MCP는 별도 프로세스 기동 문제일 수 있습니다(Windows에서 `npx` 스폰이 실패하는 경우 등). 저장소의 `.cursor/mcp.json` 은 **`node` + `node_modules/tsx/dist/cli.mjs`** 로 기동하도록 맞춰 두었습니다.

```bash
npm run mcp:gemini-explanation
```

stdio 대기만 하면 프로세스 기동은 된 것입니다. Cursor가 이와 동일한 방식으로 띄웁니다.

## DOCX 본문 형식 힌트

`examExplanationDocx`는 다음을 파싱합니다.

- 문항별: `[문항 1]` … `[정답]`, `[해설]` 줄들
- 또는 반복되는 `[정답]` / `[해설]` 블록

자세한 규칙은 `src/lib/examExplanationDocx.ts` 의 `parseExplanationBlocks` 참고.
