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
  /**
   * 과거 비슷한 문제에서 사용자가 낮은 평점·부정 피드백을 남겼을 때, 그 피드백을
   * 한 줄씩 모아 전달. LLM 이 같은 실수를 반복하지 않게 「검토 메모」 로 주입한다.
   * 비어 있으면 해당 섹션 자체가 프롬프트에서 빠진다 — 기존 동선과 동일.
   */
  cautionNotes?: string[];
}

export function buildExplanationPrompt({
  questionText,
  references,
  retryHint,
  cautionNotes,
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

  const cautionSection =
    cautionNotes && cautionNotes.length > 0
      ? `\n[과거 비슷한 문제 검토 메모 — 같은 실수 반복 금지]\n${cautionNotes
          .map((c, i) => `(${i + 1}) ${c}`)
          .join('\n')}\n위 메모는 사용자가 과거 낮은 평점과 함께 남긴 피드백입니다. 같은 종류의 오류·누락을 반복하지 마세요.\n`
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
4. **필드 분리 (엄격)**:
   - "text": **순수 한국어 평문만**. 변수·수식·LaTeX 명령어 (\`$...$\`, \`\\\\\`, \`\\implies\`, \`\\quad\` 등) **절대 금지**. 핵심 줄거리 1~2문장.
   - "equation": 그 단계의 모든 수식을 LaTeX로 (\\frac, \\sqrt, \\theta, =, \\implies 등). 없으면 빈 문자열.
   - 변수·수식이 들어가야 하면 무조건 equation 필드. text에는 절대 \\, $, ^, _ 같은 LaTeX 기호 쓰지 말 것.
5. **풀이 톤**: 수식 위주, 한글은 줄거리만.
   - 3~5 단계. 한 단계는 한 가지 변형만 다룬다.
   - 자명한 부분(예: "양변을 정리하면")은 text 생략하고 equation만 두어도 좋음.
   - 각 step.text는 최대 2문장. 길면 step 분리.
6. "예시"의 표현 방식·기호 사용·논리 흐름만 참고하고 풀이 내용은 독립적으로 생성. 예시를 그대로 베끼지 말 것.
7. 정답이 명백하지 않으면 정답 칸에 "확인 필요"라고 쓰고 explanation_steps 마지막에 그 이유를 명시.
${retrySection}${cautionSection}
[스타일 가이드 — 표현·정렬 참고용. 풀이 내용 복사 금지]
${fewShot}

[새 문제]
${questionText.trim()}

위 형식의 JSON만 출력하세요.`;
}

// 수학비서 수식 스크립트는 LLM 프롬프트에 그대로 넣어도 OK (참고용이므로).
// 다만 \u0001 같은 분리자가 남아 있으면 제거.
function cleanForPrompt(s: string): string {
  return s.replace(/[\u0001\u0002]/g, '').slice(0, 1500);
}
