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
