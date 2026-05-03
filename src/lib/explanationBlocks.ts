/** `[문항 n]` 기준으로 라벨·본문 chunk 쌍 (DOCX 파서·검증 공용) */
export function splitLabeledQuestionChunks(raw: string): Array<{ label: string; chunk: string }> {
  const re = /\[문항\s*(\d+)\]\s*/gi;
  const matches = [...raw.matchAll(re)];
  if (matches.length === 0) return [];
  const out: Array<{ label: string; chunk: string }> = [];
  for (let i = 0; i < matches.length; i += 1) {
    const label = matches[i][1] ?? String(i + 1);
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
    const chunk = raw.slice(start, end).trim();
    if (chunk) out.push({ label, chunk });
  }
  return out;
}

/**
 * `[문항 n]` 헤더 기준으로 마크다운을 나눈다. 합본 미리보기에서 구간별 지연 렌더링에 사용.
 * 헤더가 2개 미만이면 분할하지 않고 원문 1덩어리를 반환한다.
 */
export function splitLabeledQuestionMarkdownChunks(source: string): string[] {
  const re = /\[문항\s*\d+\]/gi;
  const matches = [...source.matchAll(re)];
  if (matches.length <= 1) {
    return [source];
  }
  const out: string[] = [];
  const firstIdx = matches[0]!.index ?? 0;
  if (firstIdx > 0) {
    const intro = source.slice(0, firstIdx).trim();
    if (intro) out.push(intro);
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index ?? 0;
    const end =
      i + 1 < matches.length ? (matches[i + 1]!.index ?? source.length) : source.length;
    out.push(source.slice(start, end).trim());
  }
  return out.filter(Boolean);
}

/**
 * [방법 n] 다중 풀이 블록 분리 (page.tsx·Markdown 미리보기 공용)
 */
export function splitMethodBlocks(text: string) {
  const methodRegex = /(\[방법\s*\d+\][\s\S]*?)(?=\n\s*\[방법\s*\d+\]|$)/g;
  const methods = text.match(methodRegex) ?? [];
  if (methods.length === 0) {
    return { intro: text.trim(), methods: [] as string[] };
  }

  const firstMethodIndex = text.search(/\[방법\s*\d+\]/);
  const intro = firstMethodIndex > 0 ? text.slice(0, firstMethodIndex).trim() : "";
  return { intro, methods: methods.map((item) => item.trim()) };
}

export function buildSelectedExplanationBody(
  text: string,
  selectedMethodIndexes: number[],
  representativeMethodIndex: number | null,
) {
  const blocks = splitMethodBlocks(text);
  if (blocks.methods.length === 0) {
    return text;
  }

  const selectedIndexes =
    selectedMethodIndexes.length > 0 ? selectedMethodIndexes : [0];
  const orderedIndexes = [...selectedIndexes];
  if (
    representativeMethodIndex !== null &&
    selectedIndexes.includes(representativeMethodIndex)
  ) {
    const others = orderedIndexes.filter((idx) => idx !== representativeMethodIndex);
    orderedIndexes.splice(0, orderedIndexes.length, representativeMethodIndex, ...others);
  }

  const safeSelected = orderedIndexes
    .map((index) => blocks.methods[index])
    .filter((item): item is string => typeof item === "string");
  return [blocks.intro, ...safeSelected].filter(Boolean).join("\n\n");
}
