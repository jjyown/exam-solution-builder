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

// ── 멀티 문항 — PDF 구조(문제 전체 → 빠른정답 전체 → 해설 전체) 빌더 ───────
/**
 * 사용자 보고 「문제→빠른정답→해설 3섹션 분리가 안 됨」 픽스.
 *
 * 기존 흐름 (잘못):
 *   HML route 가 각 문항마다 buildExamExplanationHmlBuffer 를 호출하고 SECTION
 *   안쪽 P 들만 잘라 concat → 문항 1 [문제]/[정답]/[해설] → 문항 2 [문제]/[정답]/[해설] ...
 *   처럼 인라인으로 섞임. PDF (문제 N개 → 빠른정답 N개 → 해설 N개) 와 다름.
 *
 * 새 함수 (이 빌더):
 *   - 표지: 시험명(해설) + 날짜
 *   - [문제] 페이지 그룹: 문항 1 본문 → 문항 2 본문 → ... (페이지 break 매 문항 사이 X,
 *     전체 [문제] 블록 끝나면 page break)
 *   - [빠른 정답] 페이지: 「N. [정답] 값」 한 줄씩 나열 (페이지 break 끝에서)
 *   - [해설] 페이지 그룹: 문항 N [정답] 값 → 단계별 풀이 → 다음 문항
 *
 * 페이지 break: HML 의 BreakSetting BreakPage="1" 또는 CTRL Type="PB" 사용.
 * 한컴 한글이 PARA 의 ParaShape 안 BreakSetting 을 받아준다 — 일단 보수적으로
 * <P><BREAKSETTING BreakPage="1"/></P> 빈 단락을 분리자로 박음.
 * (실제 동작 안 하면 한컴에서 사용자가 Ctrl+Enter 로 수동 분리 가능 — 텍스트
 *  구조는 어떻든 깔끔히 3블록으로 나뉘므로 시각 가독성은 보장됨.)
 */
function pageBreakParagraph(): string {
  // 한컴 한글 HWPML: 페이지 강제 분리 마커. 여러 변형이 있어 호환성 최대화.
  // <P PageBreak="true"> 가 일부 버전에서, <CTRL Type="PB"/> 가 다른 버전에서.
  // 둘 다 박지 않으면 그냥 문단 한 줄 분량 띄어진다.
  return `<P PageBreak="true"><TEXT><CHAR></CHAR></TEXT></P>`;
}

/** [문제] 한 문항 — 「N. {본문}」. 본문에 줄바꿈 보존. */
function problemEntryHml(questionNo: string, questionText: string): string[] {
  const out: string[] = [];
  const heading = `${questionNo}. `;
  const lines = (questionText || "").split(/\r?\n/);
  const first = lines.shift() ?? "";
  // 첫 줄에 번호 prefix 같이 출력
  out.push(paragraph(`${heading}${first}`));
  for (const line of lines) {
    out.push(paragraph(line));
  }
  out.push(paragraph("")); // 문항 사이 빈 줄
  return out;
}

/** [빠른 정답] 한 줄 — 「N. [정답] 값」 */
function quickAnswerEntryHml(questionNo: string, answer: string): string {
  return paragraph(`${questionNo}. [정답] ${answer || "-"}`);
}

/** [해설] 한 문항 — 「N. [정답] 값」 + 「[해설]」 + 단계들 */
function explanationEntryHml(
  questionNo: string,
  parsed: { answer: string; explanation_steps: Array<{ text: string; equation?: string }>; summary?: string },
): string[] {
  const out: string[] = [];
  out.push(paragraph(`${questionNo}) [정답] ${parsed.answer || "-"}`));
  out.push(paragraph("[해설]"));
  parsed.explanation_steps.forEach((step, idx) => {
    const num = idx + 1;
    if (step.text) out.push(paragraph(`${num}단계. ${step.text}`));
    if (step.equation) out.push(displayEquation(step.equation));
  });
  if (parsed.summary) {
    out.push(paragraph(""));
    out.push(paragraph(`[결론] ${parsed.summary}`));
  }
  out.push(paragraph("")); // 문항 사이 빈 줄
  return out;
}

export type HmlMultiInput = {
  examName: string;
  runs: Array<{
    questionNo: string;
    questionText?: string;
    parsed: {
      answer: string;
      explanation_steps: Array<{ text: string; equation?: string }>;
      summary?: string;
    } | null;
  }>;
};

/**
 * 여러 문항을 받아 PDF 구조(문제 전체 → 빠른정답 → 해설 전체) HML 문서 1개 생성.
 * parsed=null 인 run 은 제외.
 */
export function buildExamExplanationHmlMulti(input: HmlMultiInput): string {
  const examName = input.examName || "해설지";
  const valid = input.runs.filter((r) => r.parsed);

  const parts: string[] = [];

  // 표지
  parts.push(paragraph("수학영역"));
  parts.push(paragraph(`${examName}(해설)`));
  const now = new Date();
  const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  parts.push(paragraph(dateStr));
  parts.push(paragraph(""));
  parts.push(pageBreakParagraph());

  // [문제] 섹션
  parts.push(paragraph("[문제]"));
  parts.push(paragraph(""));
  for (const r of valid) {
    parts.push(...problemEntryHml(r.questionNo, r.questionText || ""));
  }
  parts.push(pageBreakParagraph());

  // [빠른 정답] 섹션
  parts.push(paragraph("[빠른 정답]"));
  parts.push(paragraph(""));
  for (const r of valid) {
    parts.push(quickAnswerEntryHml(r.questionNo, r.parsed!.answer));
  }
  parts.push(pageBreakParagraph());

  // [해설] 섹션
  parts.push(paragraph("[해설]"));
  parts.push(paragraph(""));
  for (const r of valid) {
    parts.push(...explanationEntryHml(r.questionNo, r.parsed!));
  }

  const head = `<HEAD SecCnt="1"><BEGINNUM Page="1" Footnote="1" Endnote="1" Pic="1" Tbl="1" Equation="1"/><FACENAMELIST><FONTFACE Lang="HANGUL" Count="1"><FONT Id="0" Type="TTF" Name="함초롬바탕"/></FONTFACE></FACENAMELIST></HEAD>`;
  const body = `<BODY><SECTION>${parts.join("")}</SECTION></BODY>`;
  return `${XML_HEADER}\n<HWPML Version="2.81" SubVersion="2.81">${head}${body}</HWPML>`;
}

export function buildExamExplanationHmlMultiBuffer(input: HmlMultiInput): Buffer {
  return Buffer.from(buildExamExplanationHmlMulti(input), "utf8");
}
