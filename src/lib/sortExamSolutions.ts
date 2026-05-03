/** 문항 번호 순(1,2,…10) · 합본은 맨 뒤 */
export function sortExamSolutionItemsByQuestionNo<T extends { question_no: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.question_no === "합본") return 1;
    if (b.question_no === "합본") return -1;
    const na = Number.parseInt(a.question_no, 10);
    const nb = Number.parseInt(b.question_no, 10);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.question_no.localeCompare(b.question_no, "ko");
  });
}
