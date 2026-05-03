# Cursor + MCP 해설 워크플로 (전문가 검토 요약)

문서 기준일: 2026-05-02

## 결론: 구조적으로 가능한가?

**가능합니다.** 이유는 다음과 같습니다.

1. **MCP**는 Cursor가 로컬에서 띄운 프로세스와 표준 프로토콜로 통신합니다. 여기서 **Gemini** 또는 **OpenAI(Chat Completions)** 를 호출해 **해설 초안 텍스트**만 반환하는 도구를 둡니다.
2. **Cursor**는 그 텍스트를 받아 형식·오류·톤을 다듬고, 프로젝트 파일이나 CLI로 **산출물을 기록**할 수 있습니다.
3. **DOCX**는 이미 `src/lib/examExplanationDocx.ts`의 `buildExamExplanationDocxBuffer`로 생성 가능합니다. Next API(`/api/save-result`)와 동일 로직을 **`npm run write-final-docx`** CLI로도 호출할 수 있게 두었습니다.

한계(의도적으로 분리):

- MCP 서버는 **“원문 생성”**까지만 담당합니다. 최종 품질 책임은 **사람 + Cursor 대화**에 둡니다.
- Cursor가 파일을 쓰는 것은 **에이전트/채팅에서의 도구 사용**에 의존합니다. 완전 무인 배치가 아니라, **대화 안에서 “이 내용으로 DOCX 저장”**을 시키는 모델에 가깝습니다.

## 권장 동선

1. **Railway / 로컬 앱** — `NEXT_PUBLIC_UI_MODE=crop` 이면 **크롭·Drive ZIP** 중심 UI만 사용.
2. **Drive**에서 문항 이미지·묶음 확보 후, Cursor에서 작업.
3. **MCP 도구** — `generate_math_explanation`(Gemini) 또는 `generate_math_explanation_openai`(OpenAI) 로 `task`에 문제·출력 형식을 넣어 초안 생성.
4. **Cursor** — 초안을 `[문항 n]`, `[정답]`, `[해설]` 형식으로 정리(프로젝트 기존 DOCX 파서와 호환).
5. **저장**
   - **A)** Cursor가 `해설지 최종본`에 맞는 `.md`/`.txt`를 쓰게 한 뒤  
     `npm run write-final-docx -- --exam-name "시험명" --quick-answer "..." --body-file ./path.txt`  
     (스크립트 엔트리는 프로젝트 루트의 `write-final-docx.mts` 입니다.)
   - **B)** 로컬에서 Next를 `full` 모드로 띄운 경우 기존처럼 `/api/save-result` 사용 가능(레거시 동선).

## MCP 설정 (전문가 점검 반영)

- **설정 파일:** **`시험지 해설 제작/.cursor/mcp.json`** 에 `gemini-gpt` 한 개만 둡니다. `highroad-math-solution/.cursor/mcp.json` 은 **비워** 두어 같은 서버가 두 번 뜨지 않게 했습니다.
- **핵심 원인(지속 Error):** Cursor가 워크스페이스를 **`%USERPROFILE%\.cursor\projects\...`** 같은 **프로젝트 미러**로만 잡는 경우가 있습니다. 그 루트에는 `node_modules` 가 없어 `${workspaceFolder}` 기반 상대 경로 MCP는 **실패**합니다. (`npm run check-api` 는 터미널에서 **실제 클론 폴더**로 `cd` 한 뒤 돌아가므로 OK인데 MCP만 Error인 패턴이 나옵니다.)
- **대응:** Cursor가 **`cwd`를 무시하거나 워크스페이스 루트(상위 `시험지 해설 제작`)만 쓰는 경우**가 있어, `args` 의 `tsx`·`gemini-explanation.mts` 경로는 **`./`가 아니라 `highroad-math-solution` 기준 전체 절대 경로**로 둡니다. (`cwd`도 동일 절대 경로로 맞춤.)
- **폴더를 옮기면:** `시험지 해설 제작/.cursor/mcp.json` 안 **`args` 두 줄 + `cwd` 한 줄**을 모두 본인 PC 경로로 바꿉니다.
- **API 키:** `highroad-math-solution/.env.local` 의 `GEMINI_*` / `OPENAI_*` 는 **`mcp/0-bootstrap.mjs`** 가 엔트리 로드 시 읽습니다.
- **실행 파일:** `mcp/gemini-explanation.mts`(도구: `generate_math_explanation`, `generate_math_explanation_openai`).
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
