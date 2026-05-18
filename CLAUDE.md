# 시험지 해설 제작기 (highroad-math-solution) — 매뉴얼

> 글로벌 룰(`~/.claude/CLAUDE.md`)에 더해 이 프로젝트 한정 규칙. **이 파일이 항상 우선.**

## 1. 정체성 — 뭘 만드는 프로젝트인지
시중 교재·내신 시험지를 OCR + LLM으로 자동 풀이 → PDF 해설 생성·Drive 업로드.

- **라이브**: https://exam-solution-builder-production.up.railway.app/auto
- **클라이언트·서버**: Node.js + Express, 정적 페이지 + API 라우트
- **DB**: Supabase (ref: `gsdhwuoyiboyzvtokrao` — **매니저와 분리**)
- **저장**: Google Drive (search-then-update 패턴)
- **AI**: Google Gemini (Vision OCR + 풀이 LLM)
- **배포**: Railway (자동 빌더)

## 2. 도구 — 어떤 스택·외부 서비스
- Node `20.x`
- Google Generative AI SDK (Gemini)
- Google Drive API (search-then-update)
- Supabase JS client (자체 프로젝트 `gsdhwuoyiboyzvtokrao`)
- pdf-to-img (native canvas — 메모리 누수 주의)
- Railway 자동 배포 (main 브랜치 push 시)

## 3. 검증 방법 — **가장 중요**. 변경 후 반드시 해당 항목 실행

### 환경 마커 (의무 명시)
- 🖥️ **로컬 dev** — `npm run dev` 또는 `node server.js`
- ☁️ **라이브** — Railway 배포된 환경 (https://...)

> 모든 변경 안내에 어디서 검증할지 마커 명시. 사용자가 dev/라이브 혼동 회피.

### 로컬 dev (🖥️)
- 의존성: `npm install`
- 실행: `npm run dev` 또는 `node server.js`
- 헬스 체크: `curl http://localhost:<port>/` 또는 `/auto` 페이지 브라우저 접속
- 변경 모듈 구문 체크: `node -c <file>.js`
- 메모리 모니터링: `NODE_OPTIONS=--expose-gc node ...` + 페이지 처리 후 RSS 확인

### 라이브 (☁️)
- Railway 자동 배포 (main push 시) — 배포 후 5분 모니터링 필수
- Usage 페이지 확인 (egress 95% 패턴 + 429 fallback 폭주 시그니처 주의)
- Google Cloud Console (Gemini API) 비용 추이 확인
- 로그: Railway dashboard

### Supabase (해설제작기 전용)
- 프로젝트 ref: `gsdhwuoyiboyzvtokrao` (매니저와 다름)
- 마이그레이션은 SQL Editor 직접 (academy_manager와 동일 패턴)

### PowerShell 자동 명령 (메모리 룰)
- 사용자가 dev vs 라이브 선택 의식 안 하게 — 명령에 cd + npm 두 줄로 안내
- 예: `cd c:\Users\mirun\Desktop\시험지 해설 제작\highroad-math-solution; npm run dev`

## 4. DO
- 변경 후 §3 검증 명령 **반드시 실행**. 못 돌리면 못 돌렸다고 명시.
- 새 일 시작 시 `/memory`로 관련 기억 확인 후 진행.
- 시크릿은 `.env.local` / Railway 환경변수에. 코드/커밋/로그에 절대 X.
- 커밋 메시지는 한국어 + Conventional Commits (`feat(auto): ...`, `fix(drive): ...`).
- 검증 환경 🖥️/☁️ 마커 명시. PowerShell `cd` + 명령 두 줄로 안내.
- 코드 push와 환경변수 변경 stage 분리 (회귀 isolation).
- **자동 토의 + 자율 협업** — 다음 신호 감지 시 `docs/DISCUSSIONS.md`에 시간순 회의록 누적하며 자동 토의 진행: LLM/OCR 모델 변경 또는 fallback 추가, /auto 파이프라인 단계 추가, Drive 업로드 로직 변경, 해설 PDF 출력 형식 변경, 자동 빌더 toggle/스케줄 변경, 영향 파일 3개 이상. 총 16개 페르소나 — 이 프로젝트에서 14개 호출 가능 (글로벌 12 + 해설 전용 2: `haeseol-developer`/`haeseol-reviewer`). 매니저 전용 2개(`academy-developer`/`academy-reviewer`)는 매니저 작업창에서만. 자기들끼리 토의, 사용자는 의뢰인 입장. **각 페르소나는 다른 의견 무조건 수용 금지** — 본인 도메인 관점에서 독립 판단, 결론은 "할만하다/조건부/불가" 명시, 불가 시 대안 제시 필수.
- **자율 학습 누적** — 페르소나가 작업/토의 중 발견한 룰을 해당 페르소나 마크다운 `## 학습 노트` 섹션에 자동 누적. 의뢰인 명령("이 룰 [페르소나]에 학습시켜줘")으로도 추가.
- **현 상태 안주 금지 — 대안 적극 제시** — 토의 시 현재 스택(Gemini / Drive / Railway / Supabase)에 갇히지 말 것. 더 나은 도구(OpenAI / Claude API / AWS Textract / Anthropic Files API / Cloudflare R2 등)가 명확히 유리하면 **과감히 제시**. 비전공자 1인 운영 부담 항상 고려.
- **git 히스토리 참고 필수** — 모든 페르소나는 `git log` / `git diff` / `git blame`으로 변경 맥락 확인. 추측 금지. 검토자는 최근 30일 commit 패턴 점검.
- **마무리까지 체크** — `git commit`/`git push`로 끝 X. **다음까지 완료**: ① 검증 결과 명시 ② Railway 배포 후 5분 모니터링 (Usage + 비용) ③ 학습 노트 추가 ④ DISCUSSIONS.md 후속 변경 채우기 + [종결] 처리 ⑤ 회귀 발견 시 즉시 토의 재개 또는 롤백.

## 5. DON'T
- **LLM fallback "싼→비싼" 자동 진급 금지** — 단일 모델+backoff 우선, 다중 fallback은 같거나 싼 단가만 (2026-05-09 5만원 spike 회귀 방지).
- **OCR 신규 호출은 Gemini Vision만** — Mathpix 폐기, 신규 호출 금지.
- **LLM 프롬프트에 expected_hint 등 범위 힌트 주입 금지** — 17~20 누락 회귀 방지.
- **백그라운드 작업 in-flight 가드 누락 금지** — UI disabled는 새로고침 우회 가능. 모듈 전역 `progressState` + 409 패턴 필수.
- **Drive 업로드는 search-then-update만** — `files.create` 단독 사용 시 동명 파일 새로 생성 (462쪽 중복 사고).
- **Drive 폴더명 콜론(:) 금지** — 날짜시간은 `HH-mm` 형식, `safeExamFolder()` sanitize 패턴.
- **sync 함수에 dynamic `await import()` 금지** — async 함수만. sync 함수엔 static import.
- **PDF 처리 메모리 누수 방치 금지** — pdf-to-img 등 native canvas는 10페이지마다 `setImmediate` + `global.gc()` 패턴 + `NODE_OPTIONS=--expose-gc`.
- **자동 git push 금지** — 커밋만, push는 사용자 직접.
- **자동 빌더 안전 toggle 누락 금지** — 비활성 toggle + 리소스 한도 + 실패 모니터링 3종 안전가드.

## 6. 분할 매뉴얼 (필요시 자동 로드)
- (필요 시 추가)

## 7. 트리거 단어 (이 단어가 나오면 정해진 동작)
- "**검증해줘**" → §3 검증 절차 전체 실행 (🖥️/☁️ 마커 명시)
- "**/auto**" / "**해설 제작**" → /auto 파이프라인 우선 탐색
- "**Drive 업로드**" → search-then-update 패턴 확인
- "**자동 빌더**" → 안전 toggle + 실패 모니터링 점검
- "**토의해주세요**" → **즉시 plan mode 진입** (Claude가 `EnterPlanMode` 도구 자동 호출) 후 `docs/DISCUSSIONS.md` 시간순 회의록 형식으로 자율 토의 시작. 사용자가 Shift+Tab 누를 필요 X. 토의 결론 후 `ExitPlanMode`로 사용자 승인 받고 일반 모드 복귀. "토의 좀", "회의해줘", "의견 들어봐" 등 변형 표현도 동일 처리.
- "**[페르소나명]에 학습시켜줘**" → 해당 페르소나 `.claude/agents/<name>.md` 의 `## 학습 노트` 섹션에 룰 추가

---

> **사용자 보정 필요 부분**: 이 파일은 메모리·일반 Node 패턴 기반 초안. 실제 폴더 구조(`server.js` 위치, `package.json` scripts, 라우트 경로 등) 확인 후 §2~§3 보정 권장.
