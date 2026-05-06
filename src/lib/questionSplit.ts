/**
 * questionSplit.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  추출된 시험지 텍스트에서 문항 단위를 분리한다.
 *
 *  지원 패턴 (한국 수학 시험지):
 *    "1.  ...",  "1) ...",  "1번 ...",  "1  [3점]  ...",  "(1) ..."
 *  보기 ①~⑤는 문항 본문에 그대로 포함된다.
 *
 *  설계 메모:
 *  - PDF/OCR로 추출한 텍스트는 줄바꿈이 불규칙해서 단순히 줄 단위로 split할 수 없음.
 *    "문항 시작" 신호는 줄 시작에서 1~50 사이 숫자 + 구분자(`.`/`)`/`번`/공백+`[N점]`).
 *  - 다음 문항 시작 직전까지를 한 문항의 본문으로 묶는다.
 *  - 시험지 헤더/페이지 번호는 1번 앞에 붙거나 마지막 문항 뒤에 붙을 수 있음 → 별도 분리.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type ExtractedQuestion = {
  /** 시험지에 적힌 문항 번호 (1, 2, …, 30 등) */
  number: number;
  /** 문항 본문 (보기 포함) */
  content: string;
  /** 본문 안에 `[N점]` 표시가 있으면 점수 */
  points?: number;
};

/**
 * 문항 헤더 패턴.
 * - 줄 시작 또는 충분한 공백 뒤(PDF가 한 줄로 합쳐진 경우)에서 매칭.
 * - 음수/소수점/버전 번호 같은 숫자는 거르기 위해 lookbehind로 직전 문자가 숫자/점이면 제외.
 */
const QUESTION_HEAD_RE =
  /(?:(?:^|\n)\s*|(?<=[\s　])(?<![\d.]))(?:\(?\s*(\d{1,2})\s*[\.\)]|(\d{1,2})\s*번\s)\s*(?:\[\s*(\d+)\s*점\s*\])?/gm;

/** 본문에서 문항 번호 표지를 다 모은 뒤 본문을 그 사이로 자른다. */
export function extractQuestionsFromText(rawText: string): ExtractedQuestion[] {
  if (!rawText || rawText.trim().length === 0) return [];

  // 정규화: 윈도/맥 줄바꿈 통일, 연속 공백 줄이기 (단, 줄바꿈 자체는 보존)
  const text = rawText
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");

  const heads: { number: number; points?: number; start: number; headEnd: number }[] = [];
  let m: RegExpExecArray | null;
  QUESTION_HEAD_RE.lastIndex = 0;
  while ((m = QUESTION_HEAD_RE.exec(text))) {
    const num = parseInt(m[1] ?? m[2] ?? "", 10);
    if (!Number.isFinite(num) || num < 1 || num > 50) continue;
    const points = m[3] ? parseInt(m[3], 10) : undefined;
    const startInMatch = m.index + (m[0].match(/^\s*\n?/)?.[0].length ?? 0);
    heads.push({
      number: num,
      points,
      start: startInMatch,
      headEnd: m.index + m[0].length,
    });
  }

  if (heads.length === 0) return [];

  // 단조 증가하는 번호 시퀀스만 골라낸다 — 잘못된 매칭(예: 본문 안 "3번 시도" 같은 표현)은 버린다.
  const filtered = filterMonotonic(heads);
  if (filtered.length === 0) return [];

  const out: ExtractedQuestion[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const cur = filtered[i];
    const next = filtered[i + 1];
    const bodyEnd = next ? next.start : text.length;
    const body = text.slice(cur.headEnd, bodyEnd).trim();
    if (body.length === 0) continue;
    out.push({ number: cur.number, content: body, points: cur.points });
  }
  return out;
}

/**
 * 헤드 후보에서 가장 긴 "연속 증가" 시퀀스(예: 1,2,3,4 또는 5,6,7)를 추출한다.
 * 본문 안에 끼어든 잡음(예: "3번을 시도했다", "7번 정답이")을 제거.
 *
 * 알고리즘: 각 위치 i에서 그 이후로 number가 +1씩 증가하는 가장 긴 체인을 잰 뒤 최댓값 채택.
 * 두 위치에서 같은 번호가 등장하면 첫 번째 것 우선.
 */
function filterMonotonic(
  heads: { number: number; points?: number; start: number; headEnd: number }[],
): typeof heads {
  if (heads.length <= 1) return heads;

  let best: typeof heads = [];
  for (let i = 0; i < heads.length; i++) {
    const chain: typeof heads = [heads[i]];
    let expected = heads[i].number + 1;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].number === expected) {
        chain.push(heads[j]);
        expected++;
      }
    }
    if (chain.length > best.length) best = chain;
  }
  // 길이 1짜리(즉 연속 시퀀스가 없음)면 fallback
  return best.length >= 2 ? best : heads;
}

/** 한 문항 본문에서 보기(①~⑤)를 분리. UI에서 활용 가능. */
export function splitChoices(content: string): { stem: string; choices: string[] } {
  const choiceMarker = /[①②③④⑤⑥⑦⑧⑨⑩]/g;
  const markers: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = choiceMarker.exec(content))) markers.push(m.index);

  if (markers.length < 2) return { stem: content.trim(), choices: [] };

  const stem = content.slice(0, markers[0]).trim();
  const choices: string[] = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i] + 1;
    const end = i + 1 < markers.length ? markers[i + 1] : content.length;
    choices.push(content.slice(start, end).trim());
  }
  return { stem, choices };
}
