/**
 * DOCX·합본 내보내기 전 **이중 검수 게이트** (구조 + 정밀 LaTeX 잔존 + 고교 표기).
 * - 1차: [문제] → [빠른 정답] → [해설] 순서·존재
 * - 2차: **정밀 LaTeX 잔존** — 인라인·표시 달러 수식·마크다운 코드 펜스 밖의 \\frac·\\begin·\\[·미닫힌 달러 등(`explanationLatexArtifactScan`)
 * - 3차: 집합·구간 표기(∈, \\in[ … ])로 값의 범위를 적는 문장 — 고교 교재에서는 부등식 사슬로 바꿈
 * - 4차: 수식만 끝나는 줄·블록의 마침표(소수점 오인) — 문장형 한글 술어가 있을 때만 `.` 허용
 * - 5차(경고): [해설] 안에 마크다운 그림 줄 — HML 동선상 발문 아래([문제] 블록)로 두는 것이 규칙
 * - 6차: `<보기>`…`</보기>` 짝·빈 블록·과도하게 긴 한 줄(2단 DOCX 보기 박스 눌림 유발 가능)
 * - DOCX: [문제] 안의 `![문제 원본](…)` 등 **타이핑 참고용 크롭**은 삽입 생략(그래프·도형만 유지). `examExplanationDocx` + `docxMarkdownImage.isDocxOmittedTypingReferenceCropAlt`
 */
import { splitLabeledQuestionChunks } from "@/lib/explanationBlocks";
import {
  findPreciseLatexArtifactsOutsideMath,
  stripTexMathZonesLegacy,
} from "@/lib/explanationLatexArtifactScan";
import { validateMergedExplanationMarkdown, type MergedStructureCheckResult } from "@/lib/mergedExplanationStructureCheck";

/** @deprecated 검수는 `findPreciseLatexArtifactsOutsideMath` 사용. 외부 호환용(구간 제거만). */
export const stripTexMathZones = stripTexMathZonesLegacy;

export type StrayLatexHit = { section: string; lineOffset: number; line: string; match: string };

function linesOf(s: string): string[] {
  return s.replace(/\r\n/g, "\n").split("\n");
}

/**
 * chunk 일부(문제 본문·해설 본문 등)에서 수식·코드 펜스 밖 LaTeX 잔존·미닫힘 검사.
 * `section` 은 로그용 라벨.
 */
export function findStrayLatexOutsideMath(text: string, section: string): StrayLatexHit[] {
  return findPreciseLatexArtifactsOutsideMath(text, section);
}

/**
 * 고등 교과서·수능 톤: `sin θ ∈ [-1,1]` / `$\\sin\\theta\\in[-1,1]$` 처럼 **원소·구간**으로 범위를 쓰지 않는다.
 * `-1 \\leq \\sin\\theta \\leq 1` 등 **부등식**으로 고친다.
 */
/** 수식 전용 한 줄 끝의 `.` 또는 `$$….$$` 안쪽 끝 `.` — 전문가 편집 규칙 위반 */
export function lineViolatesEquationPeriodRule(line: string): boolean {
  const t = line.trim();
  if (!t || t.startsWith("![")) return false;
  if (/^\$[^$\n]+\$\s*\.\s*$/.test(t)) return true;
  if (/^\$\$[\s\S]*\$\$\s*\.\s*$/.test(t)) return true;
  const dm = t.match(/^\$\$([\s\S]*)\$\$$/);
  if (dm && /[0-9\)}]\s*\.\s*$/.test(dm[1].trimEnd())) return true;
  return false;
}

/** `![](…)` 가 [해설] 본문에 있으면 배치 규칙 위반 가능 */
export function findFigureMarkdownInExplanation(
  explText: string,
  displayLabel: string,
): string[] {
  const w: string[] = [];
  linesOf(explText).forEach((line, i) => {
    if (/^\s*!\[[^\]]*]\([^)]+\)\s*$/.test(line)) {
      w.push(
        `${displayLabel}: [해설] ${i + 1}행에 그림(![](…))이 있습니다. 참고 HML·DOCX는 그림을 해당 문항 [문제] 블록(발문·선지 바로 아래)에 둡니다.`,
      );
    }
  });
  return w;
}

export function findEquationPeriodViolations(
  text: string,
  section: string,
): Array<{ section: string; lineOffset: number; line: string }> {
  const hits: Array<{ section: string; lineOffset: number; line: string }> = [];
  linesOf(text).forEach((line, i) => {
    if (lineViolatesEquationPeriodRule(line)) {
      hits.push({ section, lineOffset: i + 1, line: line.trim().slice(0, 120) });
    }
  });
  return hits;
}

export function findMembershipIntervalNotation(text: string, section: string): StrayLatexHit[] {
  const hits: StrayLatexHit[] = [];
  const ls = linesOf(text);
  ls.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("![")) return;
    const hasUnicode = /∈\s*[\[〔［]/.test(line);
    const hasTex = /\\in\s*\[/.test(line);
    if (hasUnicode || hasTex) {
      hits.push({
        section,
        lineOffset: i + 1,
        line: trimmed.slice(0, 120),
        match: hasUnicode ? "∈[" : String.raw`\in[`,
      });
    }
  });
  return hits;
}

const RE_PROBLEM = /\[문제(?:\s+\d+)?\]/i;
const RE_QUICK = /\[빠른\s*정답\]/i;
const RE_EXPL = /\[해설\]/i;
const RE_LEGACY_ANS = /\[정답\]/i;

export type TripleSectionResult = { errors: string[]; warnings: string[] };

/**
 * 문항 chunk당 **반드시** [문제] → [빠른 정답] → [해설] 순서.
 * `[정답]` 단독은 오류(빠른 정답 헤더로 통일).
 */
export function validateTripleSectionHeaders(chunk: string, displayLabel: string): TripleSectionResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = chunk.search(RE_PROBLEM);
  const q = chunk.search(RE_QUICK);
  const leg = chunk.search(RE_LEGACY_ANS);
  const e = chunk.search(RE_EXPL);

  if (p === -1) {
    errors.push(`${displayLabel}: [문제] 헤더가 없습니다. (내보내기 규칙: [문항 n] 다음에 [문제]를 두세요.)`);
  }
  if (q === -1) {
    if (leg !== -1) {
      errors.push(
        `${displayLabel}: [빠른 정답] 헤더가 없습니다. [정답]만 있으면 안 됩니다 — 동일 줄을 [빠른 정답]으로 바꾸세요.`,
      );
    } else {
      errors.push(`${displayLabel}: [빠른 정답] 블록이 없습니다.`);
    }
  }
  if (e === -1) errors.push(`${displayLabel}: [해설] 블록이 없습니다.`);

  if (p !== -1 && q !== -1 && e !== -1 && !(p < q && q < e)) {
    errors.push(
      `${displayLabel}: 섹션 순서가 올바르지 않습니다. 반드시 [문제] → [빠른 정답] → [해설] 순이어야 합니다.`,
    );
  }

  if (leg !== -1 && q !== -1 && leg < q) {
    warnings.push(`${displayLabel}: [정답] 문자열이 [빠른 정답] 앞에 있습니다. 레거시 조각을 삭제했는지 확인하세요.`);
  }

  return { errors, warnings };
}

/**
 * `<보기>` 테두리 박스용 마크다운 구조 검사(보내기 직전).
 * — 짝 맞는 닫는 태그, 빈 보기, 한 줄 과다 길이(가로 눌림 완화를 위한 편집 힌트).
 */
export function findBogiBlockStructureIssues(problemBody: string, displayLabel: string): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const opens = (problemBody.match(/<보기>/gi) ?? []).length;
  const closes = (problemBody.match(/<\/보기>/gi) ?? []).length;
  if (opens === 0) {
    if (closes > 0) {
      errors.push(`${displayLabel}: [문제] 안에 </보기>만 있고 여는 <보기>가 없습니다.`);
    }
    return { errors, warnings };
  }
  if (opens !== closes) {
    errors.push(
      `${displayLabel}: <보기>(${opens})와 </보기>(${closes}) 개수가 같지 않습니다. DOCX 보기 테두리 박스가 비정상으로 나올 수 있습니다.`,
    );
    return { errors, warnings };
  }
  const blockRe = /<보기>\s*([\s\S]*?)<\/보기>/gi;
  let m: RegExpExecArray | null;
  let parsedBlocks = 0;
  while ((m = blockRe.exec(problemBody)) !== null) {
    parsedBlocks += 1;
    const inner = m[1] ?? "";
    const nonEmpty = inner
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (nonEmpty.length === 0) {
      warnings.push(`${displayLabel}: <보기> 블록 ${parsedBlocks}번 안에 선지 줄이 없습니다(빈 보기).`);
    }
    for (const line of nonEmpty) {
      if (line.length > 200) {
        warnings.push(
          `${displayLabel}: <보기> 블록 ${parsedBlocks}번에 한 줄이 매우 깁니다(${line.length}자). 2단 DOCX에서 보기 박스가 가로로 눌려 보일 수 있으니, 항목별로 줄을 나누거나 수식을 $...$로 짧게 나누세요.`,
        );
      }
    }
  }
  if (parsedBlocks !== opens) {
    errors.push(
      `${displayLabel}: <보기>는 ${opens}개인데, 닫는 </보기>로 구분된 블록은 ${parsedBlocks}개입니다. 태그 순서·누락을 확인하세요.`,
    );
  }
  return { errors, warnings };
}

function problemAndExplanationBodies(chunk: string): { problemBody: string; explBody: string } {
  let problemBody = "";
  const pm = chunk.match(/\[문제(?:\s+\d+)?\]\s*([\s\S]*?)(?=\n\s*\[빠른\s*정답\]|\[빠른\s*정답\])/i);
  if (pm) problemBody = pm[1] ?? "";
  const em = chunk.match(/\[해설\]\s*([\s\S]*)/i);
  const explBody = em?.[1] ?? "";
  return { problemBody, explBody };
}

/**
 * 내보내기 준비도 검사: 기존 merged 검사 + 삼중 헤더 + 정밀 LaTeX 잔존(2차) + ∈·구간(3차) + 수식 끝 마침표(4차).
 */
export function validateExportReadiness(rawInput: string): MergedStructureCheckResult {
  const base = validateMergedExplanationMarkdown(rawInput);
  const errors = [...base.errors];
  const warnings = [...base.warnings];

  const raw = rawInput.replace(/\r\n/g, "\n").trim();
  const items = splitLabeledQuestionChunks(raw);

  const runChunk = (label: string, chunk: string) => {
    const disp = `문항 ${label}`;
    const triple = validateTripleSectionHeaders(chunk, disp);
    errors.push(...triple.errors);
    warnings.push(...triple.warnings);

    const { problemBody, explBody } = problemAndExplanationBodies(chunk);
    const bogi = findBogiBlockStructureIssues(problemBody, disp);
    errors.push(...bogi.errors);
    warnings.push(...bogi.warnings);
    for (const h of findStrayLatexOutsideMath(problemBody, `${disp} [문제] 본문`)) {
      errors.push(
        `${disp}: LaTeX 잔존·구분자 오류 (${h.section} ${h.lineOffset}행 근처 «${h.match}»). 수식은 $...$ 또는 $$...$$ 안에만 두고, 미닫힌 $·\`\`\` 가 없는지 확인하세요.`,
      );
    }
    for (const h of findStrayLatexOutsideMath(explBody, `${disp} [해설] 본문`)) {
      errors.push(
        `${disp}: [해설] LaTeX 잔존·구분자 오류 (${h.section} ${h.lineOffset}행 근처 «${h.match}»). 수식은 $...$ 또는 $$...$$ 안에만 두고, 미닫힌 $·\`\`\` 가 없는지 확인하세요.`,
      );
    }
    for (const h of findMembershipIntervalNotation(problemBody, `${disp} [문제] 본문`)) {
      errors.push(
        `${disp}: 고교 표기 위반 (${h.section} ${h.lineOffset}행 근처 «${h.match}»). 범위는 ∈·대괄호 구간 대신 부등식으로 쓰세요(예: $-1\\leq\\sin\\theta\\leq 1$, $-2\\leq\\sin\\theta-\\cos\\theta\\leq 2$).`,
      );
    }
    for (const h of findMembershipIntervalNotation(explBody, `${disp} [해설] 본문`)) {
      errors.push(
        `${disp}: 고교 표기 위반 (${h.section} ${h.lineOffset}행 근처 «${h.match}»). 범위는 ∈·대괄호 구간 대신 부등식으로 쓰세요(예: $-1\\leq\\sin\\theta\\leq 1$, $-2\\leq\\sin\\theta-\\cos\\theta\\leq 2$).`,
      );
    }
    for (const h of findEquationPeriodViolations(problemBody, `${disp} [문제] 본문`)) {
      errors.push(
        `${disp}: 수식 끝 마침표 위반 (${h.section} ${h.lineOffset}행). 수식만 있는 줄·표시 수식 블록 안에서는 마침표를 쓰지 마세요(숫자 뒤 마침표는 소수점으로 오인됩니다). 문장을 맺을 때만 한글과 함께 마침표를 쓰세요.`,
      );
    }
    for (const h of findEquationPeriodViolations(explBody, `${disp} [해설] 본문`)) {
      errors.push(
        `${disp}: 수식 끝 마침표 위반 (${h.section} ${h.lineOffset}행). 수식만 있는 줄·표시 수식 블록 안에서는 마침표를 쓰지 마세요(숫자 뒤 마침표는 소수점으로 오인됩니다). 문장을 맺을 때만 한글과 함께 마침표를 쓰세요.`,
      );
    }
    warnings.push(...findFigureMarkdownInExplanation(explBody, disp));
  };

  if (items.length > 0) {
    for (const { label, chunk } of items) runChunk(label, chunk);
  } else if (raw.length) {
    runChunk("단일", raw);
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function formatExportGateReport(result: MergedStructureCheckResult): string {
  const lines: string[] = [];
  lines.push("══ 검수(구조 + 정밀 LaTeX 잔존 + 고교 표기 + 수식 마침표 + 보기 블록 + 그림 배치 경고) ══");
  if (result.errors.length > 0) {
    lines.push("■ 오류(내보내기 중단)");
    result.errors.forEach((e, i) => lines.push(`  ${i + 1}. ${e}`));
  }
  if (result.warnings.length > 0) {
    lines.push("■ 경고");
    result.warnings.forEach((w, i) => lines.push(`  ${i + 1}. ${w}`));
  }
  if (result.ok && result.warnings.length === 0) {
    lines.push("■ 통과: 삼중 헤더·정밀 LaTeX 잔존·∈/구간·수식 끝 마침표·보기 블록 검사를 통과했습니다.");
  } else if (result.ok) {
    lines.push("■ 통과(경고만 있음) — 내용 확인 후 내보내기를 권장합니다.");
  }
  return lines.join("\n");
}
