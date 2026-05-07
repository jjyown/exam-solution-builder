/**
 * promptBuilder.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  새 문제 + 참고 예시들로부터 LLM 프롬프트를 조립.
 *  핵심: 수학비서 스타일의 논리 깊이/단계 분할/결론 형식을 references로 보여주고
 *       LLM이 그 스타일을 따라가도록 유도한다.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { ReferenceRecord } from './referenceRetriever';

export interface PromptInput {
  questionText: string;     // OCR이나 사용자 입력으로 받은 문제 본문
  questionImageUrl?: string; // 이미지가 있으면 (Vision 모델용)
  references: ReferenceRecord[];
  retryHint?: string;       // 자동 재시도시 이전 실패 사유
}

export function buildExplanationPrompt({
  questionText,
  references,
  retryHint,
}: PromptInput): string {
  const fewShot = references
    .map((r, i) => {
      // 1:1 페어링된 record 면 분석자료의 문제 본문 + 풀이 단계까지 모두 보여줌
      const hasPaired = !!(r.solution_text && r.solution_text.trim());
      const problemBody = hasPaired ? r.content : r.problem_hint;
      const solution = hasPaired
        ? cleanForPrompt(r.solution_text || '')
        : cleanForPrompt(r.content);
      return `<예시 ${i + 1}>
[문제] ${cleanForPrompt(problemBody)}
[정답] ${cleanForPrompt(r.answer)}
[해설]
${solution}
</예시 ${i + 1}>`;
    })
    .join('\n\n');

  const retrySection = retryHint
    ? `\n[이전 시도 피드백]\n${retryHint}\n위 사유를 반드시 반영해서 다시 작성하세요.\n`
    : '';

  return `당신은 한국 수능/모의고사 수학 해설 전문 작성자입니다.
이 문제를 **깊게 생각해서(step-by-step reasoning)** 아래 "수학비서 스타일 예시"를 참고해 동일한 논리 흐름·깊이·단계 구분으로 새 문제의 해설을 작성하세요.

[작성 전 생각 과정]
- 주어진 조건을 먼저 완전히 분석하라 (숨겨진 제약 찾기)
- 여러 풀이 경로를 생각해보고 가장 명확한 길 선택
- 각 단계의 수학적 정당성을 확인
- 마지막에 정답이 조건을 모두 만족하는지 검증

[작성 규칙]
1. 반드시 다음 JSON 형식으로만 응답할 것 (마크다운 코드펜스 금지):
   {
     "answer": "<최종 정답>",
     "explanation_steps": [
       {"text": "<단계별 풀이>", "equation": "<해당 식 LaTeX, 없으면 빈 문자열>"},
       ...
     ],
     "summary": "<한 줄 결론>"
   }
2. **객관식 (보기 ① ② ③ ④ ⑤)** 인 경우:
   - "answer" 에는 **반드시** 일치하는 보기 번호만 (예: "③" 또는 "3"). 단답 값(예: 96, 45) 만 적지 말 것.
   - 보기 중 하나가 정답과 일치하지 않으면 "확인 필요" 로 표기하고 사유를 explanation_steps 마지막에.
   - 보기를 못 찾으면 (이미지에서 잘려 안 보이면) "answer" 에 계산값 + 「(보기 미식별)」 표기.
3. **단답형/주관식** 인 경우: "answer" 에 계산된 숫자나 식 그대로 (예: "96", "x=2", "\\frac{2}{5}").
4. 모든 수식은 LaTeX 표기 사용 (\\frac, \\sqrt, \\theta 등). 한글 문장 안 인라인 수식도 LaTeX.
5. **풀이 길이**: 3~5 단계 권장. 한 단계는 한 가지 변형만 다루고 한 줄로 요약. 길게 늘어진 산문 금지.
   - 너무 자명한 정의·기호 설명은 생략. 학생이 이미 아는 내용은 압축.
   - 각 step.text 는 1~3 문장 이내. 길면 다음 step 으로 분리.
6. "예시"의 결론 어조("따라서", "이다", "이므로")와 변수 도입("~라 하자")을 그대로 따라할 것.
7. 정답이 명백하지 않으면 정답 칸에 "확인 필요"라고 쓰고 explanation_steps 마지막에 그 이유를 명시.
${retrySection}
[참고 예시 (수학비서 스타일)]
${fewShot}

[새 문제]
${questionText.trim()}

위 형식의 JSON만 출력하세요.`;
}

// 수학비서 HWP 수식 스크립트는 LLM 프롬프트에 그대로 넣어도 OK (참고용이므로).
// 다만 \u0001 같은 분리자가 남아 있으면 제거.
function cleanForPrompt(s: string): string {
  return s.replace(/[\u0001\u0002]/g, '').slice(0, 1500);
}
