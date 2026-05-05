/**
 * UI 입력: "1, 5, 7-9, 18" → 정수 배열. 빈 문자열·공백만 → null (「전체 자동」).
 */
export function parseQuestionNumbersSpec(raw: string): number[] | null {
  const t = raw.trim();
  if (!t) return null;

  const out = new Set<number>();
  const parts = t.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);

  for (const p of parts) {
    if (/^\d+$/.test(p)) {
      out.add(Number.parseInt(p, 10));
      continue;
    }
    const range = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = Number.parseInt(range[1]!, 10);
      const b = Number.parseInt(range[2]!, 10);
      if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const cap = 200;
        if (hi - lo > cap) continue;
        for (let i = lo; i <= hi; i += 1) out.add(i);
      }
    }
  }

  const list = [...out].filter((n) => n > 0 && n < 1000).sort((a, b) => a - b);
  return list.length > 0 ? list : null;
}
