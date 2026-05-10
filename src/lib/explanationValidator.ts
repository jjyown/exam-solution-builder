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
 *   (V6) 미렌더 LaTeX 노출 — V6a 자동 분리 후 잔존하는 경우만 실패시킴.
 *        ① text 안의 $…$ / \frac{a}{b} 같은 LaTeX 블록을 자동으로 equation 필드로 이동
 *        ② equation 이미 채워진 경우 text 의 LaTeX 명령을 자연어(√, π, θ, a/b)로 정규화
 *        ③ 그래도 raw \frac{ 등이 남으면 비로소 V6 실패 처리 → 재시도 힌트
 *
 *  반환값에 retryHint를 담아 promptBuilder에 다시 넘기면 자동 교정됨.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { simplifyLatexContent } from "./latexToPlainText";

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

  // V6a: 자동 분리 — text 안의 LaTeX 블록을 equation 필드로 옮긴다.
  // LLM 이 instruction 무시하고 평문에 LaTeX 섞어 보내도, 사용자 의도 보존하면서 통과시킴.
  if (Array.isArray(parsed.explanation_steps)) {
    parsed.explanation_steps = parsed.explanation_steps.map(autoSplitLatexFromText);
  }

  // V4: 풀이 본문 길이 검증 (V6a 적용 후 다시 측정)
  const totalText = (parsed.explanation_steps || [])
    .map((s) => s.text || '')
    .join(' ');
  if (totalText.length < 50) {
    errors.push('풀이 본문 길이가 50자 미만 — 정답만 있고 설명이 없는 응답');
  }

  // V6: 그래도 raw LaTeX 명령이 남아 있으면 실패 (자동 분리도 못 살린 케이스만)
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

/**
 * step.text 안에 섞여 들어온 LaTeX을 자동으로 equation 필드로 이동시키고,
 * 잔존하는 명령은 자연어(√, π, θ, a/b)로 정규화한다.
 *
 * 정책:
 *  1) text 안에 $…$ / $$…$$ 블록이 있으면 → 가장 긴 것을 equation 으로 추출.
 *     (equation 비어있을 때만 옮김. 이미 채워져 있으면 본문에서 평문화.)
 *  2) text 안에 raw \frac{a}{b}, \sqrt{x} 등이 한 덩어리로 있으면 → equation 으로 옮김.
 *  3) 위 둘로 못 옮긴 잔존 LaTeX 명령은 simplifyLatexContent 로 자연어 변환.
 *     → text 는 자연어, equation 은 LaTeX 으로 깔끔히 분리.
 */
function autoSplitLatexFromText(step: { text?: string; equation?: string }): { text: string; equation: string } {
  const original = String(step?.text ?? '');
  const equationIn = String(step?.equation ?? '').trim();
  if (!original) return { text: '', equation: equationIn };

  let text = original;
  const collected: string[] = [];

  // 1) $$…$$ → 추출
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner: string) => {
    const t = inner.trim();
    if (t) collected.push(t);
    return ' ';
  });
  // 2) $…$ → 추출 (개행 없는 경우만)
  text = text.replace(/\$([^$\n]+?)\$/g, (_, inner: string) => {
    const t = inner.trim();
    if (t) collected.push(t);
    return ' ';
  });
  // 3) raw \frac{a}{b} 단일 토큰 추출 (중첩 없는 단순 케이스)
  text = text.replace(/\\(?:d|t)?frac\s*\{[^{}]+\}\s*\{[^{}]+\}/g, (m) => {
    collected.push(m);
    return ' ';
  });
  // 4) raw \sqrt[n]{x} / \sqrt{x} 추출
  text = text.replace(/\\sqrt(?:\[[^\]]+\])?\s*\{[^{}]+\}/g, (m) => {
    collected.push(m);
    return ' ';
  });

  // 5) equation 결정
  let equationOut = equationIn;
  if (collected.length > 0) {
    if (!equationOut) {
      // 가장 긴 블록을 equation 으로, 나머지는 text 에 자연어로 합침
      collected.sort((a, b) => b.length - a.length);
      equationOut = collected[0];
      const rest = collected.slice(1).map((c) => simplifyLatexContent(c)).filter(Boolean);
      if (rest.length > 0) text = `${text} ${rest.join(' ')}`;
    } else {
      // equation 이 이미 있으면 추출분은 본문에 자연어로 환원
      const rest = collected.map((c) => simplifyLatexContent(c)).filter(Boolean);
      if (rest.length > 0) text = `${text} ${rest.join(' ')}`;
    }
  }

  // 6) text 잔존 LaTeX 명령 자연어 변환 (\theta → θ, \pi → π, \sin → sin 등)
  if (/\\[a-zA-Z]+|\\frac\{|\\sqrt\{/.test(text)) {
    text = simplifyLatexContent(text);
  }

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    equation: equationOut,
  };
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
