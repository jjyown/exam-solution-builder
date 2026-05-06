# Auto Pipeline 업그레이드 — Cursor 없이 돌아가는 라인

이 패키지는 **`exam-solution-builder` 저장소에 그대로 추가하는 추가 모듈** 입니다.
기존 코드는 건드리지 않고 새 파일만 얹으면 동작합니다.

---

## 핵심 변경 사항

| 기존 워크플로 | 새 워크플로 |
|---|---|
| 문제 크롭 → 해설 생성 → **Cursor에서 수동 검수/재호출** → DOCX | 문제 입력 → **자동 검색 + 생성 + 검증 + 재시도** → 결과 |
| LLM이 LaTeX raw로 출력해도 그대로 통과 | **검증기가 잡아내고 자동 교정** 요청 |
| 프롬프트 품질을 수작업으로 다듬음 | 수학비서 53개 예시를 **few-shot으로 자동 주입** |

---

## 추가/변경 파일 목록

```
exam-solution-builder/
├── reference/
│   └── kb.jsonl                          ← 수학비서 HML에서 추출한 53개 참고 예시 (이미 빌드됨)
├── scripts/
│   └── build-reference-kb.mjs            ← 추가 HML 자료 들어올 때 KB 갱신용
├── src/
│   ├── lib/
│   │   ├── referenceRetriever.ts         ← 참고 예시 검색 (TF-IDF)
│   │   ├── promptBuilder.ts              ← few-shot 프롬프트 조립
│   │   ├── explanationValidator.ts       ← 출력 검증 (raw LaTeX, 단계 부족 등)
│   │   └── autoPipeline.ts               ← 검색→생성→검증→재시도 오케스트레이터
│   └── app/
│       ├── api/
│       │   └── auto-pipeline/route.ts    ← 단일 엔드포인트 POST/GET
│       └── auto/
│           └── page.tsx                  ← 사용자 UI (/auto)
└── INTEGRATION.md                         ← 이 문서
```

---

## 설치 (5분)

### 1단계: 파일 복사
받으신 압축 파일의 모든 폴더를 `exam-solution-builder` 루트에 그대로 풀기.

### 2단계: 환경 변수 (`.env.local`)
```bash
GEMINI_API_KEY=...           # 기존 키 그대로
GEMINI_MODEL=gemini-2.5-pro  # (선택) 기본값
OPENAI_API_KEY=...           # (선택) OpenAI도 쓰려면
REFERENCE_KB_PATH=./reference/kb.jsonl  # (선택, 기본값 그대로 OK)
```

### 3단계: 의존성 — **추가 설치 불필요**
모두 Node 표준 모듈만 사용. `package.json` 안 건드림.

### 4단계: 로컬 검증
```bash
npm run dev
# 다른 터미널에서:
curl http://localhost:3000/api/auto-pipeline
# → { "ok": true, "kb_size": 53 } 나오면 정상

# 실제 생성 테스트:
curl -X POST http://localhost:3000/api/auto-pipeline \
  -H 'Content-Type: application/json' \
  -d '{"questionText":"둘레의 길이가 16인 부채꼴 중에서 넓이가 최대인 부채꼴의 반지름의 길이를 구하시오."}'
```

### 5단계: 브라우저에서 사용
`http://localhost:3000/auto` 접속 → 문제 붙여넣기 → 「실행」

---

## Railway 배포

기존 Railway 프로젝트가 이미 `next build && next start`로 돌고 있다면 **추가 설정 불필요**.

체크리스트:
- [ ] `reference/kb.jsonl` 가 git에 커밋됐는지 (Railway는 빌드 시점 파일을 사용)
- [ ] Railway Variables에 `GEMINI_API_KEY` 들어 있는지
- [ ] 배포 후 `https://<your-app>.railway.app/api/auto-pipeline` (GET)으로 헬스체크 → `kb_size: 53` 확인
- [ ] `https://<your-app>.railway.app/auto` 접속해서 UI 동작 확인

> 💡 **수학비서 자료 추가 갱신**: 새 HML 파일이 생기면
> ```bash
> node scripts/build-reference-kb.mjs ./수학비서_원본자료/ ./reference/kb.jsonl
> git commit -am "kb: refresh"
> git push  # Railway가 자동 재배포
> ```
> 검색 풀이 풍부해질수록 LLM 결과 품질이 향상됩니다.

---

## 사용자가 호소하던 두 문제, 어떻게 해결되는가

### 문제 1: "문제 부분이 안 들어간다"
- **원인:** 기존 DOCX 빌더가 해설만 출력
- **해결:** API 응답이 `{ answer, explanation_steps[] }` 구조로 정형화. UI/DOCX 단계에서 `explanation_steps`를 그대로 채우면 빠짐없이 들어감. 검증기 V4가 본문이 50자 미만이면 자동 재시도 트리거.

### 문제 2: "해설의 수식이 LaTeX로 그대로 나온다"
- **원인:** LLM이 `\frac{}`, `\theta` 같은 raw LaTeX를 평문에 섞어 출력
- **해결:** 출력 스키마를 `{text, equation}` 페어로 강제 → 평문(text)과 수식(equation) 분리. 검증기 V6이 평문에 `\frac`, `\sqrt`, `\theta` 등이 섞여 있으면 자동 재시도. DOCX 빌더에서는 `equation` 필드를 KaTeX/OMML로 따로 렌더하면 깨짐 없이 표시됨.

### 보너스: "Cursor에서 매번 API 호출 보고 조율"
- **원인:** 실패 사유를 사람만 볼 수 있어서 매번 개입 필요
- **해결:** `/auto` 페이지의 Trace 패널이 모든 단계(retrieve / llm_call / validate / retry)를 실시간 표시. 무엇이 왜 실패했는지 즉시 보임 → 프롬프트나 모델만 바꾸고 재실행하면 끝.

---

## 다음 개선 단추 (필요시 추가)

1. **PDF 업로드 → 자동 크롭 → 일괄 처리**: 기존 크롭 UI와 이 파이프라인을 잇는 어댑터 추가 (1~2일)
2. **DOCX 자동 생성**: `parsed.explanation_steps`를 기존 `examExplanationDocx.ts`에 넘기고 KaTeX 렌더 추가 (반나절)
3. **Supabase 로그 영속화**: `trace`를 DB에 저장 → 시간이 지나도 어떤 문제가 어떻게 풀렸는지 추적 (반나절)
4. **임베딩 검색**: KB가 1,000개를 넘기면 TF-IDF→OpenAI embedding으로 교체 (반나절)

먼저 1, 2번을 끝내면 진짜로 "PDF 올림 → DOCX 떨어짐" 무인 라인이 완성됩니다.

---

## 트러블슈팅

| 증상 | 원인 / 조치 |
|---|---|
| `kb_size: 0` 응답 | `reference/kb.jsonl` 가 빌드 산출물에 포함 안 됨 → git commit 후 재배포 |
| 모든 시도가 V1(JSON 파싱)에서 실패 | Gemini 응답이 markdown으로 감싸짐 → `validator`의 `stripCodeFences`가 처리하므로 보통 통과. 그래도 실패하면 `temperature`를 0.1로 낮출 것 |
| 결과 품질이 들쑥날쑥 | `topK` 를 5로 올리거나, 비슷한 단원 자료를 KB에 더 추가 |
| Railway에서 빌드 실패 | `tsconfig.json`의 `paths`에 `"@/*": ["./src/*"]` 가 있는지 확인 (기존 프로젝트는 이미 있을 것) |
