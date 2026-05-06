/**
 * explanationValidator.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  LLM 출력의 품질을 자동 검증한다. 이전 워크플로에서 "수동으로 매번 손보던"
 *  대표 실패 케이스 5종을 기계적으로 잡아 자동 재시도 트리거를 만든다.
 *
 *  검증 대상:
 *   (V1) JSON 파싱 실패
 *   (V2) 필수 필드 누락 (answer, explanation_steps)
 *   (V3) explanation_steps가 너무 짧음 (단계 수 < 2 → 풀이 부실)
 *   (V4) 문제 본문 누락 시그널 (전체 응답이 너무 짧고 정답만 있음)
 *   (V5) 마크다운 코드펜스/잡음 혼입
 *   (V6) 미렌더 LaTeX 노출 (수식이 평문에 그대로 남음 — 사용자가 호소한 문제)
 *
 *  반환값에 retryHint를 담아 promptBuilder에 다시 넘기면 자동 교정됨.
 * ────────────────────────────────────────────────────────────────────────────
 */
export interface ParsedExplanation {
  answer: string;
  explanation_steps: { text: string; equation: string }[];
  summary?: string;
}

export interface ValidationResult {
  ok: boolean;
  parsed: ParsedExplanation | null;
  errors: string[];
  retryHint: string | null;
}

export function validateExplanation(rawOutput: string): ValidationResult {
  const errors: string[] = [];

  // V5: 마크다운 코드펜스 제거
  const cleaned = stripCodeFences(rawOutput);

  // V1: JSON 파싱
  let parsed: ParsedExplanation | null = null;
  try {
    parsed = JSON.parse(cleaned) as ParsedExplanation;
  } catch (e) {
    errors.push(`JSON 파싱 실패: ${(e as Error).message}`);
    return {
      ok: false,
      parsed: null,
      errors,
      retryHint:
        '응답이 유효한 JSON이 아닙니다. 마크다운 코드펜스(```)를 사용하지 말고, 순수 JSON 객체만 출력하세요.',
    };
  }

  // V2: 필수 필드
  if (typeof parsed.answer !== 'string' || !parsed.answer.trim()) {
    errors.push('answer 필드 누락 또는 빈 값');
  }
  if (!Array.isArray(parsed.explanation_steps)) {
    errors.push('explanation_steps 배열 누락');
  }

  // V3: 단계 수 부족
  if (
    Array.isArray(parsed.explanation_steps) &&
    parsed.explanation_steps.length < 2
  ) {
    errors.push(
      `explanation_steps가 ${parsed.explanation_steps.length}단계로 너무 부실 (최소 3단계 필요)`
    );
  }

  // V4: 풀이 본문 길이 검증
  const totalText = (parsed.explanation_steps || [])
    .map((s) => s.text || '')
    .join(' ');
  if (totalText.length < 50) {
    errors.push('풀이 본문 길이가 50자 미만 — 정답만 있고 설명이 없는 응답');
  }

  // V6: 텍스트에 미렌더 LaTeX가 평문으로 노출됐는지 확인
  // 문제: 사용자가 호소한 "해설의 수식이 라텍스로 계속 나온다" 케이스
  const latexLeak = detectRawLatex(totalText);
  if (latexLeak.length > 0) {
    errors.push(
      `수식이 평문에 LaTeX 그대로 노출됨 (${latexLeak.length}건): "${latexLeak[0]}". equation 필드로 분리해야 함.`
    );
  }

  if (errors.length === 0) {
    return { ok: true, parsed, errors: [], retryHint: null };
  }

  // 재시도 힌트 조립
  const retryHint = errors
    .map((e, i) => `${i + 1}) ${e}`)
    .join('\n');

  return { ok: false, parsed, errors, retryHint };
}

function stripCodeFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

// 평문 안에 \frac{}, \sqrt{}, \theta 등 LaTeX 명령이 raw로 남아 있는지 검사
function detectRawLatex(text: string): string[] {
  const patterns = [
    /\\frac\s*\{/g,
    /\\sqrt(?:\[[^\]]*\])?\s*\{/g,
    /\\(?:sin|cos|tan|log|ln|exp)\b/g,
    /\\(?:theta|alpha|beta|gamma|pi|infty|sum|int|lim)\b/g,
    /\\left[(\[|]/g,
    /\\right[)\]|]/g,
  ];
  const hits: string[] = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push(m[0]);
      if (hits.length >= 5) return hits;
    }
  }
  return hits;
}
