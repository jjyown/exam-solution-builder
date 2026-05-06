/**
 * autoPipelineChecklist.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  자동 파이프라인 결과를 사람이 한 번 더 봐야 할 부분으로 압축한다.
 *  (구 Cursor `postToolUse` 훅 + 「중재 검수 체크리스트」 자동화)
 *
 *  검사 항목:
 *   1) JSON 파싱·검증 실패 → 사람 개입 필요
 *   2) 자동 재시도가 있었음 → 첫 응답 품질 확인
 *   3) 풀이 단계 부족(<3) → 비약 가능성
 *   4) 회피·근사 표현 ("≈", "어림", "대충", "가장 가까운")
 *   5) 객관식 보기 번호와 정답 형식 불일치 (①~⑤ vs 숫자만)
 *   6) 평문에 raw LaTeX 잔재 (\frac, \sqrt, \theta 등)
 *   7) 정답·해설 마지막 결론 불일치 의심
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { PipelineResult } from "./autoPipeline";

const APPROX_PATTERNS = /(≈|≅|어림|대충|가장\s*가까운|약\s*-?\d|참\s*정도로|근사적으로)/;
const RAW_LATEX_PATTERNS = /\\(?:frac|sqrt|theta|alpha|beta|gamma|pi|infty|sum|int|times|div|cdot|leq|geq|neq|approx|left|right)\b/;
const CHOICE_NUMBER_HINT = /[①②③④⑤⑥⑦⑧⑨⑩]/;

export function buildAutoChecklist(result: PipelineResult): string[] {
  const out: string[] = [];

  if (!result.ok || !result.parsed) {
    out.push(
      `[전체 실패] ${result.attempts}회 시도 후 실패 — 마지막 오류: ${result.errors.join(" / ")}`,
    );
    return out;
  }

  if (result.attempts > 1) {
    out.push(`[자동 재시도] ${result.attempts}회 만에 통과 — 첫 응답 품질 확인 권장`);
  }

  const { answer, explanation_steps, summary } = result.parsed;
  const fullText = [
    answer,
    summary ?? "",
    ...explanation_steps.map((s) => `${s.text} ${s.equation}`),
  ].join("\n");

  if (explanation_steps.length < 3) {
    out.push(
      `[풀이 단계 부족] ${explanation_steps.length}단계 — 비약 가능성 검토`,
    );
  }

  if (APPROX_PATTERNS.test(fullText)) {
    out.push(
      "[근사·회피 표현] ≈/어림/가장 가까운 등 결론을 흐리는 표현 — 교과서형 단일 결론으로 교체 검토",
    );
  }

  for (const step of explanation_steps) {
    if (step.text && RAW_LATEX_PATTERNS.test(step.text)) {
      out.push(
        "[평문에 raw LaTeX] 풀이 텍스트에 \\frac·\\sqrt 등이 남음 — equation 필드로 분리 필요",
      );
      break;
    }
  }

  // 객관식 정답 형식 체크 — 풀이에 ①~⑤가 보이는데 정답이 숫자식만이면 보기 번호로 통일 필요
  const explanationHasChoiceMarker = explanation_steps.some(
    (s) => CHOICE_NUMBER_HINT.test(s.text) || CHOICE_NUMBER_HINT.test(s.equation),
  );
  const answerHasChoiceMarker = CHOICE_NUMBER_HINT.test(answer);
  if (explanationHasChoiceMarker && !answerHasChoiceMarker) {
    out.push(
      "[객관식 표기] 풀이에 보기 번호(①~⑤)가 보이는데 정답엔 숫자/식만 — 보기 번호로 통일 검토",
    );
  }

  // 정답이 비어있거나 너무 짧으면
  if (!answer || answer.trim().length < 1) {
    out.push("[정답 누락] answer 필드 비어 있음 — 재생성 필요");
  }

  return out;
}
