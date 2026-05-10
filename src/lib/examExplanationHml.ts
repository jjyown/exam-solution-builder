/**
 * examExplanationHml.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  ParsedExplanation → 한컴 한글 .hml 문서 빌드.
 *
 *  HML 은 한컴 마크업 (XML 텍스트 포맷). 한컴 한글에서 .hml 더블클릭 시
 *  자동으로 .hwp/.hwpx 로 변환·표시되며, 사용자는 그대로 편집·저장 가능.
 *
 *  구조 (단순화):
 *    <?xml ...?>
 *    <HWPML Version="2.7" SubVersion="...">
 *      <HEAD ...>
 *      <BODY>
 *        <SECTION>
 *          <P>...</P>      <- 문단 (헤더, 본문, 빠른정답, 단계)
 *          <P>...</P>
 *        </SECTION>
 *      </BODY>
 *    </HWPML>
 *
 *  수식:
 *    <P>
 *      <TEXT><CHAR>1단계: 식을 정리하면 </CHAR></TEXT>
 *      <EQUATION Align="Center"><SCRIPT>x^2 + 1 = 0</SCRIPT></EQUATION>
 *    </P>
 *
 *  단순화/한계:
 *   - 폰트·여백·표 같은 정밀 레이아웃은 한컴 한글 기본값 사용 (사용자 편집 가능)
 *   - 그래프·도형은 matplotlib 코드 블록을 텍스트로만 (실행은 사용자가 별도)
 *   - DOCX OMML 빌더(examExplanationDocx.ts) 와 같은 입력 → 다른 포맷 출력
 * ────────────────────────────────────────────────────────────────────────────
 */
import { buildHmlEquationXml } from "./hmlEquationBuilder";

export type HmlInput = {
  examName?: string;
  questionNo?: string;
  questionText?: string;
  parsed: {
    answer: string;
    explanation_steps: Array<{ text: string; equation?: string }>;
    summary?: string;
  };
};

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

function escXml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * text 안에 인라인 수식 ($...$, $$...$$) 가 섞여 있으면 분리해서
 * <CHAR> ↔ <EQUATION> 으로 교차 배치.
 *
 * 단순화 휴리스틱:
 *  - $$...$$ 디스플레이, $...$ 인라인
 *  - 수식 안 \$ escape 는 미지원 (시중교재 OCR 결과엔 거의 없음)
 */
function buildPText(text: string): string {
  if (!text) return "<TEXT><CHAR></CHAR></TEXT>";
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    // $$...$$ 우선
    const dd = text.indexOf("$$", i);
    const sd = text.indexOf("$", i);
    let next = -1;
    let isDisplay = false;
    if (dd >= 0 && (sd < 0 || dd <= sd)) {
      next = dd;
      isDisplay = true;
    } else if (sd >= 0) {
      next = sd;
      isDisplay = false;
    }
    if (next < 0) {
      // 남은 평문 전부
      const rest = text.slice(i);
      if (rest) parts.push(`<TEXT><CHAR>${escXml(rest)}</CHAR></TEXT>`);
      break;
    }
    // next 이전 평문
    if (next > i) {
      parts.push(`<TEXT><CHAR>${escXml(text.slice(i, next))}</CHAR></TEXT>`);
    }
    // 수식 본문 끝 찾기
    const closer = isDisplay ? "$$" : "$";
    const endIdx = text.indexOf(closer, next + closer.length);
    if (endIdx < 0) {
      // 닫는 $ 못 찾음 — 평문 처리
      parts.push(`<TEXT><CHAR>${escXml(text.slice(next))}</CHAR></TEXT>`);
      break;
    }
    const eqLatex = text.slice(next + closer.length, endIdx);
    const eqXml = buildHmlEquationXml(eqLatex, { display: isDisplay });
    if (eqXml) parts.push(eqXml);
    i = endIdx + closer.length;
  }
  return parts.join("");
}

/** 한 줄 문단 빌드 — 일반 텍스트 + 인라인 수식 */
function paragraph(text: string): string {
  return `<P><TEXT><CHAR></CHAR></TEXT>${buildPText(text)}</P>`;
}

/** 디스플레이 수식 단독 문단 */
function displayEquation(latex: string): string {
  if (!latex) return "";
  const eq = buildHmlEquationXml(latex, { display: true });
  return `<P>${eq}</P>`;
}

/**
 * ParsedExplanation → HML 문서 문자열.
 * UTF-8 텍스트로 fs.writeFile 하거나 HTTP 응답으로 반환.
 */
export function buildExamExplanationHml(input: HmlInput): string {
  const { examName, questionNo, questionText, parsed } = input;
  const sections: string[] = [];

  if (examName) {
    sections.push(paragraph(examName));
    sections.push(paragraph(""));  // 빈 줄
  }
  if (questionNo) {
    sections.push(paragraph(`[문항 ${questionNo}]`));
  }
  if (questionText) {
    sections.push(paragraph("[문제]"));
    // 문제 본문 — 줄바꿈 보존
    for (const line of questionText.split(/\n/)) {
      sections.push(paragraph(line));
    }
    sections.push(paragraph(""));
  }
  sections.push(paragraph(`[빠른 정답] ${parsed.answer}`));
  sections.push(paragraph(""));
  sections.push(paragraph("[해설]"));
  parsed.explanation_steps.forEach((step, idx) => {
    const num = idx + 1;
    sections.push(paragraph(`${num}단계. ${step.text}`));
    if (step.equation) {
      sections.push(displayEquation(step.equation));
    }
  });
  if (parsed.summary) {
    sections.push(paragraph(""));
    sections.push(paragraph(`[결론] ${parsed.summary}`));
  }

  // HML 구조
  const head = `<HEAD SecCnt="1"><BEGINNUM Page="1" Footnote="1" Endnote="1" Pic="1" Tbl="1" Equation="1"/><FACENAMELIST><FONTFACE Lang="HANGUL" Count="1"><FONT Id="0" Type="TTF" Name="함초롬바탕"/></FONTFACE></FACENAMELIST></HEAD>`;
  const body = `<BODY><SECTION>${sections.join("")}</SECTION></BODY>`;
  return `${XML_HEADER}\n<HWPML Version="2.81" SubVersion="2.81">${head}${body}</HWPML>`;
}

/** Buffer 로도 받을 수 있게 — 다운로드 응답에서 직접 사용 */
export function buildExamExplanationHmlBuffer(input: HmlInput): Buffer {
  return Buffer.from(buildExamExplanationHml(input), "utf8");
}
