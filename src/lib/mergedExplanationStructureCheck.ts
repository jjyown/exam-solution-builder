/**
 * 합본(또는 단일) 해설 마크다운이 DOCX 파이프라인과 맞는지 내보내기 전 검사한다.
 * 문제(발문) + [빠른 정답](또는 레거시 [정답]) + [해설] 구조를 전제로 한다.
 *
 * **해설지 최종본(DOCX) 대역 순서(전문가 합의 기준):**
 * 문항 번호 순 **문제 전체** → **`[빠른정답]`** 대역(문항마다 `N.`·`[정답]`·값) → **`[해설]`** 대역(문항마다 `N.`·`[정답]`·값·`[해설]`·풀이).
 * 크롭 그림: **그래프·도형**은 원고에서 **해당 문항 [문제] 블록 안·발문 바로 아래**에 둔다([해설]에만 두지 않는다). `![문제 원본]` 등 타이핑 참고 크롭은 DOCX에서 생략(`docxMarkdownImage.isDocxOmittedTypingReferenceCropAlt`).
 */
import { splitLabeledQuestionChunks } from "@/lib/explanationBlocks";
import { parseMarkdownImageLine } from "@/lib/docxMarkdownImage";
import { warningsForQuickVsExplanationInequality } from "@/lib/quickAnswerExplanationConsistency";

const MD_IMAGE_LINE = /^\s*!\[[^\]]*]\([^)]+\)\s*$/;
const MIN_EXPL_BODY_LEN = 20;
const MIN_PROBLEM_HINT_LEN = 8;

function stripLeadingMdImages(text: string): string {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && MD_IMAGE_LINE.test(lines[i] ?? "")) i += 1;
  return lines.slice(i).join("\n").trim();
}

const ANSWER_HEADER_RE = /\[(?:빠른\s*정답|정답)\]/i;

function checkQuestionChunk(chunk: string, displayLabel: string) {
  const errors: string[] = [];
  const warnings: string[] = [];

  const idxAns = chunk.search(ANSWER_HEADER_RE);
  const idxExpl = chunk.search(/\[해설\]/i);

  if (idxAns < 0) errors.push(`${displayLabel}: [빠른 정답] 또는 [정답] 블록이 없습니다.`);
  if (idxExpl < 0) errors.push(`${displayLabel}: [해설] 블록이 없습니다.`);

  if (idxAns >= 0 && idxExpl >= 0 && idxExpl < idxAns) {
    warnings.push(
      `${displayLabel}: [해설]이 [빠른 정답]/[정답]보다 앞에 있습니다. 권장 순서: 발문 → [빠른 정답] → [해설].`,
    );
  }

  if (!/\[빠른\s*정답\]/i.test(chunk) && /\[정답\]/i.test(chunk)) {
    warnings.push(
      `${displayLabel}: 내보내기 규칙상 [빠른 정답] 헤더로 통일하는 것이 좋습니다. (현재 [정답]만 있음)`,
    );
  }

  const answerLineMatch = chunk.match(/\[(?:빠른\s*정답|정답)\]\s*\n\s*([^\n\r]+)/i);
  const answerSameLine = chunk.match(/\[(?:빠른\s*정답|정답)\]\s*([^\n\r]+)/i);
  const answerText =
    (answerLineMatch?.[1] ?? answerSameLine?.[1] ?? "").trim() ||
    (idxAns >= 0 ? "" : "-");
  if (idxAns >= 0 && !answerText) {
    errors.push(`${displayLabel}: [빠른 정답]/[정답] 다음에 정답(한 줄)이 비어 있습니다.`);
  }
  if (/\\[a-z]+/i.test(answerText) || /\$[^$]+\$/.test(answerText)) {
    warnings.push(
      `${displayLabel}: 빠른 정답 줄에 LaTeX·$…$가 있습니다. Word 정답 한 줄은 평문(①~⑤ 등)만 권장합니다.`,
    );
  }

  const explM = chunk.match(/\[해설\]\s*([\s\S]*)/i);
  const explBody = (explM?.[1] ?? "").trim();
  if (answerText && explBody) {
    warnings.push(...warningsForQuickVsExplanationInequality(answerText, explBody, displayLabel));
  }
  if (idxExpl >= 0) {
    if (explBody.length < MIN_EXPL_BODY_LEN) {
      errors.push(`${displayLabel}: [해설] 본문이 너무 짧거나 비어 있습니다.`);
    }
    if (/해설 생성 버튼을 누르면|이 영역에 결과가 표시됩니다/i.test(explBody)) {
      errors.push(`${displayLabel}: [해설]에 UI 안내 문구가 남아 있습니다. 실제 풀이로 바꿔 주세요.`);
    }
  }

  if (idxAns >= 0) {
    const before = chunk.slice(0, idxAns);
    const problemHint = stripLeadingMdImages(before)
      .replace(/^\s*(?:\d+\)\s*)?\[문제(?:\s+\d+)?\]\s*/i, "")
      .trim();
    const firstProbLine =
      problemHint
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? "";
    if (
      /^[0-9]가 아닌 양수/u.test(firstProbLine) &&
      (/\\log|\\ln|log_/u.test(problemHint) || /\blog\b/i.test(problemHint))
    ) {
      warnings.push(
        `${displayLabel}: 발문이 '${firstProbLine.slice(0, 24)}…'처럼 **숫자+가 아닌 양수**로 시작합니다. 시험지의 **문항 번호(1. 2. …)** 가 줄바꿈 없이 붙어 조건의 **1이 아닌**으로 잘못 들어간 전형적 오타인지 원본과 대조하세요(로그의 밑·진수는 보통 1이 아닌 양수).`,
      );
    }
    const hasProblemHeader = /^\s*(?:\d+\)\s*)?\[문제(?:\s+\d+)?\]/im.test(before);
    if (problemHint.length < MIN_PROBLEM_HINT_LEN && !hasProblemHeader) {
      warnings.push(
        `${displayLabel}: [빠른 정답] 앞에 발문·선지 텍스트가 거의 없습니다. DOCX 「문제」 단락이 비어 보일 수 있습니다. ([문제] 헤더 아래에 발문을 두세요.)`,
      );
    }
    const lines = before
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    let imageLines = 0;
    let typedLen = 0;
    for (const line of lines) {
      if (parseMarkdownImageLine(line)) {
        imageLines += 1;
      } else if (!/^\s*(?:\d+\)\s*)?\[문제(?:\s+\d+)?\]/i.test(line)) {
        const stripMath = line
          .replace(/\$\$[\s\S]*?\$\$/g, " ")
          .replace(/\$[^$\n]+\$/g, " ");
        typedLen += stripMath.replace(/\s+/g, " ").trim().length;
      }
    }
    if (imageLines >= 1 && typedLen < 40) {
      warnings.push(
        `${displayLabel}: 문제 파트에 그림 줄은 있으나 타이핑 발문·선지가 매우 짧습니다. 교재형처럼 발문은 글로, 그래프만 크롭으로 조합하는 편을 권장합니다.`,
      );
    }
  }

  return { errors, warnings };
}

export type MergedStructureCheckResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

/**
 * @param rawInput 합본_편집용.md 전체 문자열
 */
export function validateMergedExplanationMarkdown(rawInput: string): MergedStructureCheckResult {
  const raw = rawInput.replace(/\r\n/g, "\n").trim();
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!raw) {
    return { ok: false, errors: ["본문이 비어 있습니다."], warnings: [] };
  }

  const dollarCount = (raw.match(/\$/g) ?? []).length;
  if (dollarCount % 2 !== 0) {
    warnings.push("`$` 개수가 홀수입니다. 인라인 수식 `…$…$…` 짝이 맞는지 확인하세요.");
  }

  const firstLabelM = raw.match(/\[문항\s*\d+\]/i);
  const firstLabelIdx = firstLabelM?.index ?? -1;
  if (firstLabelIdx > 0) {
    const intro = raw.slice(0, firstLabelIdx).trim();
    if (intro.length > 40) {
      warnings.push(
        "첫 `[문항 n]` 앞에 긴 텍스트가 있습니다. 합본이면 보통 문항별로 `[문항 1]`부터 시작하는지 확인하세요.",
      );
    }
  }

  const items = splitLabeledQuestionChunks(raw);
  if (items.length > 0) {
    const seen = new Set<string>();
    for (const { label, chunk } of items) {
      if (seen.has(label)) {
        warnings.push(`문항 번호 ${label}이(가) 두 번 이상 나옵니다. 중복 헤더를 정리하세요.`);
      }
      seen.add(label);
      const r = checkQuestionChunk(chunk, `문항 ${label}`);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    }
  } else {
    if (/\[문항\s*\d+\]/i.test(raw)) {
      errors.push("[문항 n] 헤더는 있으나 본문 chunk가 비어 있습니다.");
    } else {
      const r = checkQuestionChunk(raw, "본문");
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function formatStructureCheckReport(result: MergedStructureCheckResult): string {
  const lines: string[] = [];
  if (result.errors.length > 0) {
    lines.push("■ 오류(수정 후 다시 내보내기)");
    result.errors.forEach((e, i) => lines.push(`  ${i + 1}. ${e}`));
  }
  if (result.warnings.length > 0) {
    lines.push("■ 경고(가능하면 반영)");
    result.warnings.forEach((w, i) => lines.push(`  ${i + 1}. ${w}`));
  }
  if (result.ok && result.warnings.length === 0) {
    lines.push("■ 구성 검사: 통과(문제·[빠른 정답]/[정답]·[해설] 흐름 확인됨).");
  } else if (result.ok) {
    lines.push("■ 구성 검사: 오류 없음 — 경고만 확인하세요.");
  }
  return lines.join("\n");
}
