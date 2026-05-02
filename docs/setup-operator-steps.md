# 운영·세팅 단계별 가이드 (이미지 → 해설 → DOCX)

- **문서 기준일:** 2026-05-02  
- **전제:** 코드는 GitHub `jjyown/exam-solution-builder`(본 저장소) 최신 `main` 기준.  
- **관련 문서:** [models.md](./models.md)(모델·env 상세), [workflow-image-to-docx.md](./workflow-image-to-docx.md)(동선·품질), [supabase-prompt-rules.md](./supabase-prompt-rules.md)(규칙 자동 업데이트).

---

## 전문가 관점 요약 (왜 이 순서인가)

| 관점 | 내용 |
|------|------|
| 비용 | UI의「테스트/최종」「쉬움/균형/킬러」는 **서로 다른 `GEMINI_MODELS_GENERATE_*` 키**를 가리킵니다. 모든 키에 **같은 모델 ID**를 넣으면 라디오만 바꿔도 **API 호출 모델은 동일**해져, 비용만 나가고 체감 차이가 없을 수 있습니다. |
| 품질 | 근호·2단 시험지는 **한 크롭·한 문항**이 안 지켜지면 오독·연쇄 출력이 늘어납니다. 크롭이 1순위 방어선입니다. |
| 신뢰도 | `EXPLANATION_CROSS_VERIFY=true`는 **추가 호출 비용**으로 Gemini 초안을 OpenAI 비전이 재점검합니다. 정답 보증은 아니지만 계열이 달라 실수를 줄이는 데 도움이 됩니다. |

코드 기준으로 UI와 동일한 매핑은 `src/lib/generateExplanationGeminiEnv.ts` 의 `resolveGeminiGenerateEnvKey` 입니다.

---

## 0단계: 로컬 실행 준비

1. 저장소 클론 후 앱 디렉터리로 이동: `highroad-math-solution`
2. `npm install`
3. `npm run build` 로 타입·빌드 확인(선택, 배포 전 권장)

---

## 1단계: 필수 비밀값 (`.env.local`)

**커밋하지 마세요.** Vercel 등 배포 환경에는 동일 키를 프로젝트 설정에 넣습니다.

| 변수 | 필수 | 역할 |
|------|------|------|
| `GEMINI_API_KEY` | ✅ | Gemini 호출(사전검증·해설 생성·repair 등). `GOOGLE_API_KEY` 별칭도 코드에서 허용되는 경로 있음. |
| `OPENAI_API_KEY` | 권장 | Gemini 실패 시 해설 **폴백**, 선택 시 **교차 검증**. 없으면 해당 경로만 비활성. |

이 두 가지만으로도 **해설 생성 주 경로**는 동작할 수 있습니다.

---

## 2단계: 해설 옵션(UI)과 환경변수 매핑 이해

웹 UI「해설 옵션」에서 고르는 값과 **실제로 읽는 env 키**는 아래와 같습니다(`resolveGeminiGenerateEnvKey`).

| 생성 모드 | 프로필 | 사용 env 키 |
|-----------|--------|-------------|
| 테스트 | 쉬운 문제 | `GEMINI_MODELS_GENERATE_EASY` |
| 테스트 | 균형형 | `GEMINI_MODELS_GENERATE_TEST` |
| 테스트 | 킬러 | `GEMINI_MODELS_GENERATE_KILLER` |
| 최종 | 쉬운 문제 | `GEMINI_MODELS_GENERATE_FINAL` |
| 최종 | 균형형 | `GEMINI_MODELS_GENERATE_BALANCED` |
| 최종 | 킬러 | `GEMINI_MODELS_GENERATE_KILLER` |

**현재 선택에 대응하는 키**는 앱 화면 해설 옵션 아래 **노란 안내 상자**에 실시간으로 표시됩니다.

---

## 3단계: 모델·비용 프로파일 설정 (권장)

기본값은 각 키마다 `gemini-2.0-flash` 후보 하나로 통일되는 경우가 많아, **단계 2의 라디오를 바꿔도 모델이 같을 수 있습니다.**

권장 패턴(예시, 계정·과금에 맞게 조정):

- **실험·대량 스모크:** `GEMINI_MODELS_GENERATE_TEST`, `GEMINI_MODELS_GENERATE_EASY` → 저지연 Flash 계열  
- **발행 직전:** `GEMINI_MODELS_GENERATE_BALANCED`, `GEMINI_MODELS_GENERATE_KILLER`, `GEMINI_MODELS_GENERATE_FINAL` → 필요 시 Pro/상위 Flash  

콤마로 **여러 후보**를 두면 한 모델 429/오류 시 다음 후보로 순회합니다. 자세한 키 목록은 [models.md](./models.md) §1 B.

---

## 4단계: 교차 검증·폴백 (선택, 품질 우선)

| 변수 | 설명 |
|------|------|
| `EXPLANATION_CROSS_VERIFY=true` | Gemini 1차 초안 통과 후 OpenAI 비전으로 재검토(추가 비용). |
| `OPENAI_MODEL_CROSS_VERIFY` | 기본 `gpt-4o` 등. |
| `OPENAI_MODEL_GENERATE_FALLBACK` | Gemini 전부 실패 시 폴백 모델. |
| `OPENAI_EXPLANATION_FORMAT_RETRY=false` | 폴백 **2차 재호출**을 끄고 비용 절감(형식 실패 시 재시도 안 함). 미설정은 재시도 허용 쪽. |

---

## 5단계: Supabase 규칙 자동 업데이트 (선택)

운영자 토큰(`PROMPT_RULES_ADMIN_TOKEN`)과 Supabase 연동이 되어 있을 때만 의미 있습니다.  
입력은 **아쉬운 해설 / 좋은 예시**를 라디오로 구분합니다(API `/api/prompt-rules/analyze-and-apply`). 자세한 동작은 [supabase-prompt-rules.md](./supabase-prompt-rules.md)를 참고하세요.

---

## 6단계: 첫 해설 ~ DOCX까지 (운영 동선)

1. PDF/이미지에서 **문항당 하나의 문제 박스**만 들어오게 영역 지정·저장  
2. (있으면) 사전검증 통과 확인 — 저품질 크롭이면 생성 전 차단  
3. 해설 생성 실행 — 필요 시 **테스트 모드 + 저가 env**로 먼저 형식 확인  
4. 카드에서 빠른정답·해설 선택·순서 확인  
5. **해설 제작(DOCX)** — 게이트 실패 시 `/api/repair-explanations` 자동 보정 경로 가능  

단계별 품질 원칙은 [workflow-image-to-docx.md](./workflow-image-to-docx.md) §1~3.

---

## 문제 해결 (자주 하는 오해)

- **「테스트인데 왜 비용이 크게 나가나요?」** → 교차 검증을 켰거나, 폴백이 고가 모델이거나, env가 모두 동일 상위 모델일 수 있습니다.  
- **「프로필을 바꿔도 결과가 같아요」** → [models.md](./models.md) 표대로 해당 키에 **다른 모델 ID**가 들어갔는지 확인하세요.  
- **「정답이 자주 틀려요」** → 크롭에 근호가 잘리지 않았는지, `EXPLANATION_CROSS_VERIFY` 여부를 점검하세요. LLM은 100% 보증이 없습니다.

---

## 변경 이력

| 날짜 | 내용 |
|------|------|
| 2026-05-02 | 최초 작성: 단계 0~6, UI–env 매핑, 전문가 요약, 트러블슈팅. |
