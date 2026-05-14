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
 *          <P>...</P>
 *        </SECTION>
 *      </BODY>
 *      <TAIL>                  ← 이미지가 있을 때만
 *        <BINDATASTORAGE>
 *          <BINDATA ...>...
 *        </BINDATASTORAGE>
 *      </TAIL>
 *    </HWPML>
 *
 *  수식:
 *    <P>
 *      <TEXT><CHAR>1단계: 식을 정리하면 </CHAR></TEXT>
 *      <EQUATION Align="Center"><SCRIPT>x^2 + 1 = 0</SCRIPT></EQUATION>
 *    </P>
 *
 *  이미지 (![alt](data:image/png;base64,...) 패턴):
 *    HEAD/MAPPINGTABLE/BINDATALIST 에 BINITEM 등록
 *    BODY 에 <PICTURE BinItem="N"/> 삽입
 *    TAIL/BINDATASTORAGE 에 BINDATA 기록
 *
 *  단순화/한계:
 *   - 폰트·여백·표 같은 정밀 레이아웃은 한컴 한글 기본값 사용 (사용자 편집 가능)
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
 */
function buildPText(text: string): string {
  if (!text) return "<TEXT><CHAR></CHAR></TEXT>";
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
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
      const rest = text.slice(i);
      if (rest) parts.push(`<TEXT><CHAR>${escXml(rest)}</CHAR></TEXT>`);
      break;
    }
    if (next > i) {
      parts.push(`<TEXT><CHAR>${escXml(text.slice(i, next))}</CHAR></TEXT>`);
    }
    const closer = isDisplay ? "$$" : "$";
    const endIdx = text.indexOf(closer, next + closer.length);
    if (endIdx < 0) {
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
  const content = buildPText(text);
  return `<P>${content || "<TEXT><CHAR></CHAR></TEXT>"}</P>`;
}

/** 디스플레이 수식 단독 문단 */
function displayEquation(latex: string): string {
  if (!latex) return "";
  const eq = buildHmlEquationXml(latex, { display: true });
  return `<P>${eq}</P>`;
}

// ── PNG 크기 파싱 ─────────────────────────────────────────────────────────────
/** PNG IHDR 헤더에서 width/height 추출. 실패 시 400×300 fallback. */
function readPngDimensions(base64: string): { w: number; h: number } {
  try {
    const buf = Buffer.from(base64, "base64");
    // PNG 시그니처 8바이트 + IHDR 청크: offset 16 = width, offset 20 = height (uint32BE)
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return { w: 400, h: 300 };
  }
}

// ── HWPML PICTURE 태그 생성 ───────────────────────────────────────────────────
/**
 * HWPML 2.8 <PICTURE> 요소 생성. 실제 샘플 HML 파일 역분석 결과.
 *  wH, hH: HWP 단위 (1/100mm). 150 DPI PNG 기준: 1px = 9600/150 = 64 HWP units.
 */
function buildPictureXml(binId: number, wH: number, hH: number): string {
  const instId = 100000 + binId;
  const instId2 = 200000 + binId;
  const cx = Math.round(wH / 2);
  const cy = Math.round(hH / 2);
  return (
    `<PICTURE Reverse="false">` +
    `<SHAPEOBJECT InstId="${instId}" Lock="false" NumberingType="Figure" ZOrder="${binId}">` +
    `<SIZE Width="${wH}" Height="${hH}" WidthRelTo="Absolute" HeightRelTo="Absolute" Protect="false"/>` +
    `<POSITION TreatAsChar="true" FlowWithText="true" HorzRelTo="Para" VertRelTo="Para"` +
    ` HorzAlign="Left" VertAlign="Top" HorzOffset="0" VertOffset="0"` +
    ` AffectLSpacing="false" AllowOverlap="false" HoldAnchorAndSO="false"/>` +
    `<OUTSIDEMARGIN Left="0" Right="0" Top="0" Bottom="0"/>` +
    `</SHAPEOBJECT>` +
    `<SHAPECOMPONENT InstID="${instId2}" CurWidth="${wH}" CurHeight="${hH}"` +
    ` OriWidth="${wH}" OriHeight="${hH}" GroupLevel="0" HorzFlip="false" VertFlip="false" XPos="0" YPos="0">` +
    `<ROTATIONINFO Angle="0" CenterX="${cx}" CenterY="${cy}" Rotate="1"/>` +
    `<RENDERINGINFO>` +
    `<TRANSMATRIX E1="1.00000" E2="0.00000" E3="0.00000" E4="0.00000" E5="1.00000" E6="0.00000"/>` +
    `<SCAMATRIX E1="1.00000" E2="0.00000" E3="0.00000" E4="0.00000" E5="1.00000" E6="0.00000"/>` +
    `<ROTMATRIX E1="1.00000" E2="0.00000" E3="0.00000" E4="0.00000" E5="1.00000" E6="0.00000"/>` +
    `</RENDERINGINFO>` +
    `</SHAPECOMPONENT>` +
    `<IMAGERECT X0="0" Y0="0" X1="${wH}" Y1="0" X2="${wH}" Y2="${hH}" X3="0" Y3="${hH}"/>` +
    `<IMAGECLIP Left="0" Top="0" Right="${wH}" Bottom="${hH}"/>` +
    `<INSIDEMARGIN Left="0" Right="0" Top="0" Bottom="0"/>` +
    `<IMAGEDIM Width="${wH}" Height="${hH}"/>` +
    `<IMAGE BinItem="${binId}" Effect="RealPic" Alpha="0" Bright="0" Contrast="0"/>` +
    `<EFFECTS/>` +
    `</PICTURE>`
  );
}

/**
 * ParsedExplanation → HML 문서 문자열 (단일 문항).
 * UTF-8 텍스트로 fs.writeFile 하거나 HTTP 응답으로 반환.
 */
export function buildExamExplanationHml(input: HmlInput): string {
  const { examName, questionNo, questionText, parsed } = input;
  const sections: string[] = [];

  if (examName) {
    sections.push(paragraph(examName));
    sections.push(paragraph(""));
  }
  if (questionNo) {
    sections.push(paragraph(`[문항 ${questionNo}]`));
  }
  if (questionText) {
    sections.push(paragraph("[문제]"));
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

  const head = `<HEAD SecCnt="1"><BEGINNUM Page="1" Footnote="1" Endnote="1" Pic="1" Tbl="1" Equation="1"/><FACENAMELIST><FONTFACE Lang="HANGUL" Count="1"><FONT Id="0" Type="TTF" Name="함초롬바탕"/></FONTFACE></FACENAMELIST></HEAD>`;
  const body = `<BODY><SECTION>${sections.join("")}</SECTION></BODY>`;
  return `${XML_HEADER}\n<HWPML Version="2.81" SubVersion="2.81">${head}${body}</HWPML>`;
}

/** Buffer 로도 받을 수 있게 — 다운로드 응답에서 직접 사용 */
export function buildExamExplanationHmlBuffer(input: HmlInput): Buffer {
  return Buffer.from(buildExamExplanationHml(input), "utf8");
}

// ── 멀티 문항 — PDF 구조(문제 전체 → 빠른정답 전체 → 해설 전체) 빌더 ───────

function pageBreakParagraph(): string {
  return `<P PageBreak="true"><TEXT><CHAR></CHAR></TEXT></P>`;
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
 *
 * 이미지 지원:
 *  - questionText 또는 explanation_steps.text 에 ![alt](data:image/png;base64,...) 패턴이 있으면
 *    HWPML <PICTURE> 요소로 임베드하고, HEAD MAPPINGTABLE 과 TAIL BINDATASTORAGE 에 등록.
 */
export function buildExamExplanationHmlMulti(input: HmlMultiInput): string {
  const examName = input.examName || "해설지";
  const valid = input.runs.filter((r) => r.parsed);

  // ── 이미지 binary 상태 ───────────────────────────────────────────────────
  type BinEntry = { id: number; format: "png" | "jpg"; base64: string; wH: number; hH: number };
  const bins: BinEntry[] = [];
  let nextBinId = 1;
  const DPI = 150; // matplotlib 기본 출력 DPI
  const HUP_PER_PX = Math.round(9600 / DPI); // 64 HWP units/px

  function registerImage(dataUrl: string): string {
    const m = dataUrl.match(/^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!m) return "";
    const fmt: "png" | "jpg" = m[1].startsWith("jp") ? "jpg" : "png";
    const b64 = m[2].replace(/\s/g, "");
    const dims = fmt === "png" ? readPngDimensions(b64) : { w: 400, h: 300 };
    const wH = Math.max(1, dims.w * HUP_PER_PX);
    const hH = Math.max(1, dims.h * HUP_PER_PX);
    const id = nextBinId++;
    bins.push({ id, format: fmt, base64: b64, wH, hH });
    return buildPictureXml(id, wH, hH);
  }

  // ── 로컬 paragraph — 이미지 패턴 우선 처리 ─────────────────────────────
  function par(text: string): string {
    if (!text) return `<P><TEXT><CHAR></CHAR></TEXT></P>`;
    // 전체 텍스트가 단일 마크다운 이미지 (data URL) 인 경우
    const imgM = text.match(/^!\[[^\]]*\]\((data:image\/[^\s)]+)\)$/);
    if (imgM) {
      const pic = registerImage(imgM[1]);
      if (pic) return `<P>${pic}</P>`;
    }
    const content = buildPText(text);
    return `<P>${content || "<TEXT><CHAR></CHAR></TEXT>"}</P>`;
  }

  function dispEq(latex: string): string {
    if (!latex) return "";
    return `<P>${buildHmlEquationXml(latex, { display: true })}</P>`;
  }

  // ── 문항 구분 여백 (3줄) ─────────────────────────────────────────────────
  function separator(): string[] {
    return [par(""), par(""), par("")];
  }

  // ── [문제] 한 문항 ──────────────────────────────────────────────────────
  function problemEntry(questionNo: string, questionText: string): string[] {
    const out: string[] = [];
    const heading = `${questionNo}. `;
    const lines = (questionText || "").split(/\r?\n/);
    const first = lines.shift() ?? "";
    out.push(par(`${heading}${first}`));
    for (const line of lines) out.push(par(line));
    out.push(...separator());
    return out;
  }

  // ── [빠른 정답] 한 줄 ───────────────────────────────────────────────────
  function quickAnswerEntry(questionNo: string, answer: string): string {
    return par(`${questionNo}. [정답] ${answer || "-"}`);
  }

  // ── [해설] 한 문항 ──────────────────────────────────────────────────────
  function explanationEntry(
    questionNo: string,
    parsed: {
      answer: string;
      explanation_steps: Array<{ text: string; equation?: string }>;
      summary?: string;
    },
  ): string[] {
    const out: string[] = [];
    out.push(par(`${questionNo}) [정답] ${parsed.answer || "-"}`));
    out.push(par("[해설]"));
    parsed.explanation_steps.forEach((step, idx) => {
      const num = idx + 1;
      if (step.text) out.push(par(`${num}단계. ${step.text}`));
      if (step.equation) out.push(dispEq(step.equation));
    });
    if (parsed.summary) {
      out.push(par(""));
      out.push(par(`[결론] ${parsed.summary}`));
    }
    out.push(...separator());
    return out;
  }

  // ── 섹션 조립 ────────────────────────────────────────────────────────────
  const parts: string[] = [];

  // 표지
  parts.push(par("수학영역"));
  parts.push(par(`${examName}(해설)`));
  const now = new Date();
  const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  parts.push(par(dateStr));
  parts.push(par(""));
  parts.push(pageBreakParagraph());

  // [문제] 섹션
  parts.push(par("[문제]"));
  parts.push(par(""));
  for (const r of valid) {
    parts.push(...problemEntry(r.questionNo, r.questionText || ""));
  }
  parts.push(pageBreakParagraph());

  // [빠른 정답] 섹션
  parts.push(par("[빠른 정답]"));
  parts.push(par(""));
  for (const r of valid) {
    parts.push(quickAnswerEntry(r.questionNo, r.parsed!.answer));
  }
  parts.push(pageBreakParagraph());

  // [해설] 섹션
  parts.push(par("[해설]"));
  parts.push(par(""));
  for (const r of valid) {
    parts.push(...explanationEntry(r.questionNo, r.parsed!));
  }

  // ── HEAD / BODY / TAIL 조립 ───────────────────────────────────────────────
  const bindataListXml =
    bins.length > 0
      ? `<BINDATALIST Count="${bins.length}">${bins.map((e) => `<BINITEM BinData="${e.id}" Format="${e.format}" Type="Embedding"/>`).join("")}</BINDATALIST>`
      : "";

  const faceNameList = `<FACENAMELIST><FONTFACE Lang="HANGUL" Count="1"><FONT Id="0" Type="TTF" Name="함초롬바탕"/></FONTFACE></FACENAMELIST>`;

  const head =
    bins.length > 0
      ? `<HEAD SecCnt="1"><BEGINNUM Page="1" Footnote="1" Endnote="1" Pic="1" Tbl="1" Equation="1"/><MAPPINGTABLE>${bindataListXml}${faceNameList}</MAPPINGTABLE></HEAD>`
      : `<HEAD SecCnt="1"><BEGINNUM Page="1" Footnote="1" Endnote="1" Pic="1" Tbl="1" Equation="1"/>${faceNameList}</HEAD>`;

  const body = `<BODY><SECTION>${parts.join("")}</SECTION></BODY>`;

  const tail =
    bins.length > 0
      ? `<TAIL><BINDATASTORAGE>${bins
          .map((e) => {
            const wrapped = (e.base64.match(/.{1,76}/g) ?? []).join("\n");
            return `<BINDATA Id="${e.id}" Format="${e.format}" Encoding="Base64" Compress="false" Size="${e.base64.length}">\n${wrapped}\n</BINDATA>`;
          })
          .join("")}</BINDATASTORAGE></TAIL>`
      : "";

  return `${XML_HEADER}\n<HWPML Version="2.81" SubVersion="2.81">${head}${body}${tail}</HWPML>`;
}

export function buildExamExplanationHmlMultiBuffer(input: HmlMultiInput): Buffer {
  return Buffer.from(buildExamExplanationHmlMulti(input), "utf8");
}
