/**
 * [빠른 정답] 한 줄과 [해설] 말미의 **부등식 구간 형태**가 어긋나면 경고한다.
 * (지수함수·그래프 문항에서 교점 사이 vs 바깥을 뒤집는 전형적 오류 방지)
 */

function stripTexForScan(s: string): string {
  return s
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/\\le\b/gi, "≤")
    .replace(/\\ge\b/gi, "≥")
    .replace(/\\leq\b/gi, "≤")
    .replace(/\\geq\b/gi, "≥");
}

/** ⋯≤x≤⋯ 한 구간으로 읽히는지(교점 사이 등) */
function looksLikeSingleChainedInterval(s: string): boolean {
  const t = stripTexForScan(s).replace(/\s+/g, "");
  return (
    /≤x≤|≤\s*x\s*≤|<=\s*x\s*<=|≦x≦/.test(t) ||
    /[−-]?\d+[≤<].*x.*[≤<][−-]?\d+/.test(t.replace(/≤/g, "≤"))
  );
}

/** 「⋯ 또는 ⋯」로 두 개의 x 부등식 구간을 합친 형태인지 */
function looksLikeUnionOfTwoXRays(s: string): boolean {
  const t = stripTexForScan(s);
  if (!/또는/.test(t)) return false;
  const parts = t.split(/또는/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  let hits = 0;
  for (const p of parts) {
    if (/x\s*[≤≥]|≤\s*x|≥\s*x|[≤≥]\s*x/.test(p.replace(/\s+/g, " "))) hits += 1;
  }
  return hits >= 2;
}

/** $\left(\frac{1}{3}\right)^{f(x)}$ 류 지수부등식 + 그래프 힌트가 같이 있을 때만 엄격히 본다 */
function looksLikeGraphExponentInequalityChunk(answerText: string, explBody: string): boolean {
  const pack = `${answerText}\n${explBody}`;
  const hasExp =
    /\(\\frac\{1\}\{3\}\)|\\left\(\\frac\{1\}\{3\}\)|\(\s*1\s*\/\s*3\s*\)/.test(pack) ||
    /\(\s*1\/3\s*\)\s*\^\{?f\(x\)/.test(pack);
  const hasGraphCue =
    /그래프|교점|포물선|직선|f\s*\(\s*x\s*\)|g\s*\(\s*x\s*\)/.test(explBody) ||
    /f\s*\(\s*x\s*\)|g\s*\(\s*x\s*\)/.test(answerText);
  return hasExp && hasGraphCue;
}

/**
 * @returns 경고 문구(비어 있으면 통과)
 */
export function warningsForQuickVsExplanationInequality(
  answerText: string,
  explBody: string,
  displayLabel: string,
): string[] {
  const out: string[] = [];
  const ans = answerText.trim();
  const expl = explBody.trim();
  if (!ans || !expl) return out;

  if (!looksLikeGraphExponentInequalityChunk(ans, expl)) return out;

  const tailLines = expl.split("\n").filter((l) => l.trim().length > 0);
  const tail = tailLines.slice(-3).join("\n");

  const quickInterval = looksLikeSingleChainedInterval(ans);
  const quickUnion = looksLikeUnionOfTwoXRays(ans);
  const tailInterval = looksLikeSingleChainedInterval(tail);
  const tailUnion = looksLikeUnionOfTwoXRays(tail);

  if (quickInterval && tailUnion && !tailInterval) {
    out.push(
      `${displayLabel}: [빠른 정답]은 한 구간(⋯≤x≤⋯)인데 [해설] 말미는 두 구간 합(⋯ 또는 ⋯)처럼 보입니다. 밑이 $0<a<1$이면 $\\left(\\frac{1}{3}\\right)^{f(x)}\\ge\\left(\\frac{1}{3}\\right)^{g(x)}\\Leftrightarrow f(x)\\le g(x)$ 이고, 그래프에서 $f\\le g$가 교점 **사이**인지 **바깥**인지 구별해 [빠른 정답]과 해설 마지막 결론을 맞추세요.`,
    );
  }
  if (quickUnion && tailInterval && !tailUnion) {
    out.push(
      `${displayLabel}: [빠른 정답]에 「또는」(두 부분 합)이 있는데 [해설] 말미는 한 구간(⋯≤x≤⋯)로 끝납니다. 단조성·그래프 위·아래 관계를 다시 확인하세요.`,
    );
  }
  return out;
}
