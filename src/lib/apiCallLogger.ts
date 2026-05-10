/**
 * src/lib/apiCallLogger.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  외부(과금) API 호출 단건 로그 — 비용 체크 대시보드 데이터 소스.
 *
 *  목적:
 *   - auto_pipeline_runs(메인 풀이) · analysis_records(학습 OCR) 가 커버하지 못하는
 *     「짧고 잦은 호출」(사진편집 박스 감지·시험명 추천, 페어 정제, BBox 폴백 등)을
 *     라우트별로 영속 기록하여 비용 페이지가 「어디서 무슨 용도로 얼마」를 보여줄 수
 *     있게 한다.
 *
 *  설계 원칙:
 *   - **Best-effort, fire-and-forget**: 로깅 실패는 본 호출 실패가 아니다.
 *     Supabase 미설정·테이블 미적용 시에도 본 라우트는 정상 동작.
 *   - **이중 계산 방지**: auto-pipeline 메인 호출은 auto_pipeline_runs 가 이미 기록.
 *     이 로거는 그 외 라우트만 기록한다.
 *   - **보수적 단가**: 모델별 평균 단가 (cost-tracker route 와 동일) — ±50% 오차.
 *
 *  사용:
 *    await logApiCall({
 *      route: '/api/photo-edit/detect-box',
 *      purpose: '사진 편집기 박스 자동감지',
 *      vendor: 'gemini',
 *      model: 'gemini-2.5-flash-lite',
 *      ok: true,
 *      meta: { fileSize: 1234 },
 *    });
 *  → est_cost_usd 는 vendor·model 로부터 자동 추정.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { getSupabaseServiceClient } from './supabaseServiceClient';

export type ApiVendor = 'gemini' | 'openai' | 'mathpix' | 'other';

export type ApiCallLogInput = {
  /** Next.js route 경로 (예: '/api/photo-edit/detect-box'). 통계 그룹 키. */
  route: string;
  /** 사람이 읽을 한국어 라벨 (예: '사진 편집기 박스 자동감지'). UI 표시. */
  purpose: string;
  vendor: ApiVendor;
  /** 모델 식별자 — 단가 추정에 사용. 없으면 'unknown'. */
  model?: string | null;
  /** 호출 성공 여부 (실패해도 호출 자체는 발생 → 로그). 기본 true. */
  ok?: boolean;
  /** 1회 호출이 아니라 여러 단위(PDF 페이지 N장)인 경우 보정. 기본 1. */
  units?: number;
  /** 단가 자동 추정을 무시하고 직접 지정하고 싶을 때만. */
  estCostUsdOverride?: number;
  /** 자유 메타 — 라우트별 디버깅용. UI 미표시. */
  meta?: Record<string, unknown>;
};

/**
 * 모델별 호출당 평균 추정 단가 (USD).
 *
 *  cost-tracker/route.ts 와 같은 표를 공유 — 한쪽 바꾸면 양쪽 일치하게.
 *  값은 input·output 토큰 평균을 잡은 보수적 추정. 정확 청구액은 ±50% 오차.
 *
 *  Mathpix 는 호출당이 아닌 페이지/이미지 단위로 과금되므로 units 가 페이지 수.
 */
const COST_PER_CALL_USD: Record<string, number> = {
  // ── Gemini ──
  'gemini-2.5-pro': 0.019,
  'gemini-2.5-flash': 0.005,
  'gemini-2.5-flash-lite': 0.0008,
  'gemini-2.0-flash': 0.001,
  'gemini-2.0-flash-lite': 0.0005,
  // ── OpenAI ──
  'gpt-4o': 0.030,
  'gpt-4o-mini': 0.001,
  'gpt-4.1': 0.020,
  'gpt-4.1-mini': 0.002,
  // ── Mathpix (per page/image) ──
  'mathpix-v3-text': 0.004,
  'mathpix-v3-pdf': 0.005,
};

/** 기본값(모델 식별 실패) — 0.005 USD/call (Gemini Flash 평균) */
const FALLBACK_COST_USD = 0.005;

export function inferUnitCostUsd(model: string | null | undefined): number {
  if (!model) return FALLBACK_COST_USD;
  const m = model.toLowerCase();
  if (COST_PER_CALL_USD[m] !== undefined) return COST_PER_CALL_USD[m];
  // 부분 일치 — 'gemini-2.5-pro-001' 같은 변형 흡수
  for (const [key, val] of Object.entries(COST_PER_CALL_USD)) {
    if (m.includes(key)) return val;
  }
  return FALLBACK_COST_USD;
}

/**
 * 호출 1건을 api_call_logs 에 기록한다.
 * - Supabase 미설정/테이블 없으면 조용히 패스 (본 호출 흐름 방해 X)
 * - await 권장이지만 fire-and-forget (`void logApiCall(...)`) 도 안전.
 */
export async function logApiCall(input: ApiCallLogInput): Promise<void> {
  try {
    const client = getSupabaseServiceClient();
    if (!client) return;
    const model = input.model || 'unknown';
    const units = input.units && input.units > 0 ? Math.floor(input.units) : 1;
    const estCostUsd =
      typeof input.estCostUsdOverride === 'number'
        ? input.estCostUsdOverride
        : inferUnitCostUsd(model) * units;
    await client
      .from('api_call_logs')
      .insert({
        route: input.route,
        purpose: input.purpose,
        vendor: input.vendor,
        model,
        units,
        ok: input.ok !== false,
        est_cost_usd: Number(estCostUsd.toFixed(6)),
        meta: input.meta ?? null,
      })
      // best-effort — 테이블 없거나 RLS 막혀도 본 흐름 영향 없음
      .then(() => undefined, () => undefined);
  } catch {
    /* swallow — 로깅이 본 호출을 깨뜨리면 안 됨 */
  }
}
