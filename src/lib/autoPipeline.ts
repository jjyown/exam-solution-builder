/**
 * autoPipeline.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  엔드투엔드 자동 라인. 한 문제(텍스트 또는 이미지+OCR결과)를 받아:
 *   1) 참고 예시 K개 검색
 *   2) 프롬프트 조립
 *   3) Gemini/OpenAI 호출
 *   4) 검증 → 실패시 retryHint와 함께 최대 N회 자동 재시도
 *   5) 최종 ParsedExplanation 반환
 *
 *  외부 IDE 채팅 검수를 거치지 않고도 스스로 교정·재생성을 수행한다.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { ReferenceRetriever } from './referenceRetriever';
import { buildExplanationPrompt } from './promptBuilder';
import {
  validateExplanation,
  type ParsedExplanation,
} from './explanationValidator';

export interface PipelineConfig {
  retriever: ReferenceRetriever;
  llmCall: (prompt: string) => Promise<string>; // 모델 호출 추상화
  topK?: number;        // 참고 예시 수 (기본 3)
  maxRetries?: number;  // 자동 재시도 횟수 (기본 2)
  onTrace?: (e: TraceEvent) => void;
}

export type TraceEvent =
  | { stage: 'retrieve'; refIds: string[] }
  | { stage: 'llm_call'; attempt: number; promptChars: number }
  | { stage: 'validate'; attempt: number; ok: boolean; errors: string[] }
  | { stage: 'success'; attempts: number }
  | { stage: 'give_up'; attempts: number; lastErrors: string[] };

export interface PipelineResult {
  ok: boolean;
  attempts: number;
  parsed: ParsedExplanation | null;
  errors: string[];
  trace: TraceEvent[];
}

export async function runAutoPipeline(
  questionText: string,
  cfg: PipelineConfig
): Promise<PipelineResult> {
  const topK = cfg.topK ?? 3;
  const maxRetries = cfg.maxRetries ?? 2;
  const trace: TraceEvent[] = [];
  const emit = (e: TraceEvent) => {
    trace.push(e);
    cfg.onTrace?.(e);
  };

  // 1) 참고 예시 검색
  const refs = cfg.retriever.search(questionText, topK);
  emit({ stage: 'retrieve', refIds: refs.map((r) => r.id) });

  let lastErrors: string[] = [];
  let lastHint: string | undefined;

  // 2~4) 자동 재시도 루프
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const prompt = buildExplanationPrompt({
      questionText,
      references: refs,
      retryHint: lastHint,
    });
    emit({ stage: 'llm_call', attempt, promptChars: prompt.length });

    let raw: string;
    try {
      raw = await cfg.llmCall(prompt);
    } catch (e) {
      lastErrors = [`LLM 호출 실패: ${(e as Error).message}`];
      lastHint = undefined; // 호출 실패는 프롬프트 문제 아님 — 그대로 재시도
      emit({ stage: 'validate', attempt, ok: false, errors: lastErrors });
      continue;
    }

    const v = validateExplanation(raw);
    emit({ stage: 'validate', attempt, ok: v.ok, errors: v.errors });

    if (v.ok && v.parsed) {
      emit({ stage: 'success', attempts: attempt });
      return {
        ok: true,
        attempts: attempt,
        parsed: v.parsed,
        errors: [],
        trace,
      };
    }
    lastErrors = v.errors;
    lastHint = v.retryHint || undefined;
  }

  emit({ stage: 'give_up', attempts: maxRetries + 1, lastErrors });
  return {
    ok: false,
    attempts: maxRetries + 1,
    parsed: null,
    errors: lastErrors,
    trace,
  };
}
