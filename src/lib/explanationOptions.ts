/**
 * src/lib/explanationOptions.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  /auto · /crop 가 공유하는 「풀이 옵션」 영속화.
 *
 *  설계 의도:
 *   - 두 페이지는 모두 같은 /api/auto-pipeline 코어를 호출하므로 옵션이 같으면
 *     결과 파이프라인도 같다. 사용자가 한 페이지에서 모델·profile 등을 바꾸면
 *     다른 페이지에서도 즉시 동일하게 적용되도록 옵션만 공유한다.
 *   - 폼 데이터(시험명·문항번호·questionText·선택문항)는 각 페이지가 별도로
 *     관리한다 — 페이지 간 의도가 달라 잘못 덮어쓰면 혼란만 야기.
 *
 *  키 분리 이유: /auto 의 기존 DRAFT_KEY 는 폼+옵션이 한 묶음으로 들어 있어
 *  옮길 수 없다. 새 키로 「옵션만」 따로 저장하고, 양쪽 페이지가 마운트/변경
 *  시점에 이 키를 동기화한다.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type SharedExplanationOptions = {
  model: 'gemini' | 'openai';
  profile: 'auto' | 'easy' | 'balanced' | 'killer';
  topK: number;
  maxRetries: number;
  /** /crop 에는 의미 없음(개별 크롭 = partial). /auto 에서만 사용. */
  explanationMode: 'full' | 'partial';
  savedAt: number;
};

export const SHARED_OPTIONS_KEY = 'highroad:explanation-options:v1';

export const SHARED_OPTIONS_DEFAULT: SharedExplanationOptions = {
  model: 'openai', // 비용 절감 — 둘 다 기본 OpenAI (필요 시 사용자가 변경)
  profile: 'auto',
  topK: 3,
  maxRetries: 2,
  explanationMode: 'full',
  savedAt: 0,
};

export function readSharedOptions(): SharedExplanationOptions | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SHARED_OPTIONS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SharedExplanationOptions>;
    return normalize(parsed);
  } catch {
    return null;
  }
}

export function writeSharedOptions(opts: Omit<SharedExplanationOptions, 'savedAt'>): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: SharedExplanationOptions = { ...normalize(opts), savedAt: Date.now() };
    window.localStorage.setItem(SHARED_OPTIONS_KEY, JSON.stringify(payload));
    // 다른 탭/페이지가 즉시 반응하도록 storage 이벤트는 자동 발생.
    // 같은 탭 내에서는 별도 커스텀 이벤트로 알린다.
    window.dispatchEvent(new CustomEvent('highroad:options-changed', { detail: payload }));
  } catch {
    /* QuotaExceeded 등 — 조용히 무시 */
  }
}

/**
 * 잘못된 값을 안전한 기본값으로 정규화 — 다른 페이지에서 잘못 저장된 값이
 * 들어와도 페이지가 깨지지 않게.
 */
function normalize(input: Partial<SharedExplanationOptions>): SharedExplanationOptions {
  const model: SharedExplanationOptions['model'] =
    input.model === 'gemini' || input.model === 'openai' ? input.model : SHARED_OPTIONS_DEFAULT.model;
  const profile: SharedExplanationOptions['profile'] =
    input.profile === 'easy' ||
    input.profile === 'balanced' ||
    input.profile === 'killer' ||
    input.profile === 'auto'
      ? input.profile
      : SHARED_OPTIONS_DEFAULT.profile;
  const topK =
    typeof input.topK === 'number' && input.topK > 0 && input.topK <= 20
      ? Math.floor(input.topK)
      : SHARED_OPTIONS_DEFAULT.topK;
  const maxRetries =
    typeof input.maxRetries === 'number' && input.maxRetries >= 0 && input.maxRetries <= 10
      ? Math.floor(input.maxRetries)
      : SHARED_OPTIONS_DEFAULT.maxRetries;
  const explanationMode: SharedExplanationOptions['explanationMode'] =
    input.explanationMode === 'partial' ? 'partial' : 'full';
  return {
    model,
    profile,
    topK,
    maxRetries,
    explanationMode,
    savedAt: typeof input.savedAt === 'number' ? input.savedAt : 0,
  };
}
