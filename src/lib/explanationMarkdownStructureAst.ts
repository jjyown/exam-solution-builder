/**
 * 합본 마크다운의 **구조 토큰**(문항 경계·헤더)을 단순 AST 형태로 올리고,
 * `--strict-numbered-headers` 모드에서 `n) [문제]` / `n) [빠른 정답]` / `[해설]` 순서를 강제한다.
 * (full remark AST 대신 줄 단위 파싱 — 의존성·속도·DOCX 파이프라인과 동일 기준)
 */
import { splitLabeledQuestionChunks } from "./explanationBlocks";

export type LineKind =
  | "blank"
  | "문항"
  | "문제_일반"
  | "문제_번호접두"
  | "빠른정답_일반"
  | "빠른정답_번호접두"
  | "해설"
  | "md_image"
  | "other";

const RE_MUN = /^\[문항\s*(\d+)\]\s*$/i;
const RE_PROB = /^\[문제(?:\s+\d+)?\]\s*$/i;
const RE_PROB_NUM = /^\s*(\d+)\)\s*\[문제\]\s*$/i;
const RE_QUICK = /^\[빠른\s*정답\]\s*$/i;
const RE_QUICK_NUM = /^\s*(\d+)\)\s*\[빠른\s*정답\]\s*$/i;
const RE_EXPL = /^\[해설\]\s*$/i;
const RE_IMG = /^\s*!\[[^\]]*]\([^)]+\)\s*$/;

export function classifyExplanationLine(line: string): LineKind {
  const t = line.trim();
  if (!t) return "blank";
  if (RE_IMG.test(line)) return "md_image";
  if (RE_MUN.test(t)) return "문항";
  if (RE_PROB_NUM.test(t)) return "문제_번호접두";
  if (RE_PROB.test(t)) return "문제_일반";
  if (RE_QUICK_NUM.test(t)) return "빠른정답_번호접두";
  if (RE_QUICK.test(t)) return "빠른정답_일반";
  if (RE_EXPL.test(t)) return "해설";
  return "other";
}

export type StructureAstIssue = { level: "error" | "warning"; message: string };

/**
 * 각 `[문항 n]` chunk에서 (선택) **번호 접두** 형식만 허용.
 */
export function validateStrictNumberedTripleChunks(markdown: string): StructureAstIssue[] {
  const issues: StructureAstIssue[] = [];
  const raw = markdown.replace(/\r\n/g, "\n").trim();
  const items = splitLabeledQuestionChunks(raw);
  if (items.length === 0) {
    issues.push({
      level: "error",
      message: "AST 검사: [문항 n] 헤더가 없어 문항별 엄격 모드를 적용할 수 없습니다.",
    });
    return issues;
  }

  for (const { label, chunk } of items) {
    const lines = chunk.split("\n");
    let pIdx = 0;
    while (pIdx < lines.length && classifyExplanationLine(lines[pIdx] ?? "") === "blank") pIdx += 1;
    while (pIdx < lines.length && classifyExplanationLine(lines[pIdx] ?? "") === "md_image") pIdx += 1;

    const k = classifyExplanationLine(lines[pIdx] ?? "");
    if (k !== "문제_번호접두") {
      issues.push({
        level: "error",
        message: `문항 ${label}: 엄격 모드 — 첫 본문 헤더는 반드시 \"n) [문제]\" 한 줄이어야 합니다. (현재: ${k})`,
      });
    } else {
      const m = (lines[pIdx] ?? "").trim().match(RE_PROB_NUM);
      const num = m?.[1];
      if (num && num !== label) {
        issues.push({
          level: "warning",
          message: `문항 ${label}: \"${lines[pIdx]?.trim()}\" 의 번호와 [문항] 라벨이 다릅니다.`,
        });
      }
    }

    const qIdx = lines.findIndex((L) => classifyExplanationLine(L) === "빠른정답_번호접두");
    const eIdx = lines.findIndex((L) => classifyExplanationLine(L) === "해설");
    if (qIdx === -1) {
      issues.push({
        level: "error",
        message: `문항 ${label}: 엄격 모드 — \"n) [빠른 정답]\" 헤더가 없습니다.`,
      });
    }
    if (eIdx === -1) {
      issues.push({
        level: "error",
        message: `문항 ${label}: \"[해설]\" 헤더가 없습니다.`,
      });
    }
    if (qIdx !== -1 && eIdx !== -1 && k === "문제_번호접두" && !(pIdx < qIdx && qIdx < eIdx)) {
      issues.push({
        level: "error",
        message: `문항 ${label}: 엄격 모드 — 순서는 \"n) [문제]\" → \"n) [빠른 정답]\" → \"[해설]\" 이어야 합니다.`,
      });
    }
  }

  return issues;
}
