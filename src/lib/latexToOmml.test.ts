/**
 * src/lib/latexToOmml.test.ts
 *
 * LaTeX → docx OMML 변환기 unit test 30건 (PR-1 Commit 3, solution-writer 권고).
 *
 * 단원 5종 × 난이도 3종 × 2 = 24 (지원 케이스) + 6 (미지원 fallback) = 30
 *
 * 실행:
 *   cd "c:\Users\mirun\Desktop\시험지 해설 제작\highroad-math-solution"
 *   npx tsx --test src/lib/latexToOmml.test.ts
 *
 * Memory 정합:
 *   - `feedback_output_quality_weighted_check` — 표본 ≥10 + 사전 baseline
 *   - `feedback_no_hallucination` — 각 case 는 docx 시그니처 실재 확인 후 작성
 *   - `feedback_grading_llm_prompt_hints` — LLM 룰 없이 순수 코드 검증
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  MathFraction,
  MathIntegral,
  MathRadical,
  MathRoundBrackets,
  MathRun,
  MathSquareBrackets,
  MathSubScript,
  MathSubSuperScript,
  MathSum,
  MathSuperScript,
} from "docx";
import { latexToOmmlChildren } from "./latexToOmml";

/** 지원 case: throw 안 함 + 결과 길이 ≥ 1 + 첫 atom 의 클래스 일치 확인. */
function expectSupported(
  latex: string,
  expectedFirstClass: new (...args: never[]) => unknown,
): void {
  const result = latexToOmmlChildren(latex);
  assert.ok(result.length >= 1, `[${latex}] 결과가 비어있음`);
  assert.ok(
    result[0] instanceof expectedFirstClass,
    `[${latex}] 첫 atom 이 ${expectedFirstClass.name} 아님 (받은 클래스: ${result[0]?.constructor?.name})`,
  );
}

/** 미지원 case: throw "unsupported token: ..." 확인. */
function expectUnsupported(latex: string): void {
  assert.throws(
    () => latexToOmmlChildren(latex),
    /unsupported token/i,
    `[${latex}] throw 안 함 — 미지원으로 처리돼야 함`,
  );
}

// ── 카테고리 1: 분수 (수1/수2 기초) ──────────────────────────────────
test("01. 단순 분수 \\frac{1}{2}", () => {
  expectSupported("\\frac{1}{2}", MathFraction);
});
test("02. 다항 분자 분수 \\frac{a+b}{c-d}", () => {
  expectSupported("\\frac{a+b}{c-d}", MathFraction);
});
test("03. \\dfrac{x^2}{y} (display 형 동등)", () => {
  expectSupported("\\dfrac{x^2}{y}", MathFraction);
});
test("04. \\tfrac{1}{3} (text 형 동등)", () => {
  expectSupported("\\tfrac{1}{3}", MathFraction);
});
test("05. 그리스 분자 \\frac{\\pi}{4}", () => {
  expectSupported("\\frac{\\pi}{4}", MathFraction);
});

// ── 카테고리 2: 루트 (수1/미적분) ─────────────────────────────────
test("06. 단순 루트 \\sqrt{3}", () => {
  expectSupported("\\sqrt{3}", MathRadical);
});
test("07. 식 루트 \\sqrt{x^2+1}", () => {
  expectSupported("\\sqrt{x^2+1}", MathRadical);
});
test("08. 세제곱근 \\sqrt[3]{x}", () => {
  expectSupported("\\sqrt[3]{x}", MathRadical);
});
test("09. 네제곱근 \\sqrt[4]{2y}", () => {
  expectSupported("\\sqrt[4]{2y}", MathRadical);
});

// ── 카테고리 3: 위첨자/아래첨자 (수1/수2/수열) ────────────────────
test("10. 위첨자 x^{2}", () => {
  expectSupported("x^{2}", MathSuperScript);
});
test("11. 아래첨자 a_{n}", () => {
  expectSupported("a_{n}", MathSubScript);
});
test("12. 위+아래 a_{i}^{2}", () => {
  expectSupported("a_{i}^{2}", MathSubSuperScript);
});
test("13. 다항 위첨자 x^{n+1}", () => {
  expectSupported("x^{n+1}", MathSuperScript);
});
test("14. 위+아래 순서 반전 x^{2}_{1}", () => {
  expectSupported("x^{2}_{1}", MathSubSuperScript);
});

// ── 카테고리 4: 시그마/적분 (미적분) ──────────────────────────────
test("15. 시그마 \\sum_{k=1}^{n}", () => {
  expectSupported("\\sum_{k=1}^{n}", MathSum);
});
test("16. 정적분 \\int_{0}^{1}", () => {
  expectSupported("\\int_{0}^{1}", MathIntegral);
});
test("17. 무한 시그마 \\sum_{k=0}^{\\infty}", () => {
  expectSupported("\\sum_{k=0}^{\\infty}", MathSum);
});
test("18. 변수 적분 \\int_{a}^{b}", () => {
  expectSupported("\\int_{a}^{b}", MathIntegral);
});

// ── 카테고리 5: 괄호 (기하·확통) ─────────────────────────────────
test("19. \\left(x+1\\right) 큰 둥근 괄호", () => {
  expectSupported("\\left(x+1\\right)", MathRoundBrackets);
});
test("20. 단순 (a+b) 둥근 괄호", () => {
  expectSupported("(a+b)", MathRoundBrackets);
});
test("21. \\left[\\alpha\\right] 큰 대괄호", () => {
  expectSupported("\\left[\\alpha\\right]", MathSquareBrackets);
});
test("22. 단순 [x] 대괄호", () => {
  expectSupported("[x]", MathSquareBrackets);
});

// ── 카테고리 6: 그리스/연산자 (전 단원) ──────────────────────────
test("23. \\pi 단독 → MathRun", () => {
  expectSupported("\\pi", MathRun);
});
test("24. \\alpha + \\beta 그리스 결합", () => {
  expectSupported("\\alpha + \\beta", MathRun);
});

// ── 미지원 (fallback 발동, throw 확인) ─────────────────────────
test("25. \\begin{cases} 환경 미지원", () => {
  expectUnsupported("\\begin{cases} x>0 \\\\ x<0 \\end{cases}");
});
test("26. \\overset{X}{Y} 미지원", () => {
  expectUnsupported("\\overset{a}{b}");
});
test("27. \\binom{n}{k} 미지원", () => {
  expectUnsupported("\\binom{n}{k}");
});
test("28. \\lim_{x \\to 0} 미지원", () => {
  expectUnsupported("\\lim_{x \\to 0}");
});
test("29. \\overline{x} 미지원", () => {
  expectUnsupported("\\overline{x}");
});
test("30. 알 수 없는 \\foobar 미지원", () => {
  expectUnsupported("\\foobar");
});
