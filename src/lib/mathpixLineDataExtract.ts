/**
 * mathpixLineDataExtract.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  Mathpix PDF lines.json 결과를 받아 좌표(bbox) 기반으로 문항 segment 를
 *  분리하고, 표준 헤더(`[문항 N]`, `[정답 및 해설]`, `[해설 N]`) 를 강제로
 *  부여한 텍스트로 다시 조립한다.
 *
 *  목적:
 *   - 페어링률 <40% PDF 의 자동 폴백 ─ scripts/textbook_page_split_mathpix.py
 *     의 핵심 분할 로직을 Python·Pillow 의존성 없이 Node 에서 재현.
 *   - 결과 텍스트를 driveAnalysisLearner.parseProblemSolutionPairs 에 다시
 *     입력해 페어링률을 재측정 → 향상되면 records 교체.
 *
 *  단순화 (Python 대비 생략):
 *   - 이미지 PNG 크롭은 하지 않음 (텍스트 segment 만 분리).
 *   - 페이지 내 단조 증가 검사·foreign-answer-split·소형 조각 병합 같은
 *     세부 휴리스틱은 일부만 적용 (오버피팅 방지).
 *
 *  결과: rebuildTextFromLineData() 가 표준 헤더가 박힌 한 덩어리 텍스트 반환.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type { MathpixPdfLinesJson } from "./mathpixV3Pdf";

type Bbox = [number, number, number, number]; // x0, y0, x1, y1

type LineLite = {
  text: string;
  type?: string;
  bbox: Bbox | null;
  pageIndex: number; // pages[] 의 인덱스 (0-based)
};

type Segment = {
  number: number | null; // 인쇄된 문항 번호 (또는 null = 풀이/머리말)
  pageIndex: number;
  lines: LineLite[];
  isSolutionHeader: boolean; // 「[정답 및 해설]」/「해설」 단독 줄 detected
};

/** 「12.」 「7)」 같은 문항 시작 헤더 매칭. 한 줄의 시작에서만 인정. */
const RE_PROBLEM_HEADER = /^\s*(\d{1,3})\s*[.)]\s/;
/** 「[문항 12]」 / 「예제 7」 같은 명시 헤더. */
const RE_LABELED_HEADER = /^\s*(?:\[문항\s*(\d{1,3})\]|예제\s*(\d{1,3})|유형\s*(\d{1,3}))/;
/** 풀이 섹션 시작 마커 (단독 줄). */
const RE_SOLUTION_SECTION =
  /^\s*(?:\[정답\s*및\s*해설\]|\[해설\]|정답\s*및\s*해설|해설|풀이)\s*$/;

/** cnt 다각형 → bbox(x0,y0,x1,y1). 점이 부족하면 null. */
function cntToBbox(cnt: number[][] | undefined): Bbox | null {
  if (!Array.isArray(cnt) || cnt.length < 2) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of cnt) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) return null;
  return [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)];
}

/** lines.json 의 한 페이지 → 좌표 정렬된 LineLite[]. */
function flattenPageLines(
  page: MathpixPdfLinesJson["pages"][number],
  pageIndex: number,
): LineLite[] {
  const out: LineLite[] = [];
  for (const l of page.lines ?? []) {
    if (l.type === "page_info") continue; // 페이지 번호/머리글 등은 segment 신호 안 됨
    const text = (l.text ?? "").trim();
    if (!text) continue;
    out.push({
      text,
      type: l.type,
      bbox: cntToBbox(l.cnt),
      pageIndex,
    });
  }
  // y 오름차순 → x 오름차순 (다단/표 무시 — 페어링 폴백 한정)
  out.sort((a, b) => {
    const ay = a.bbox ? a.bbox[1] : Number.MAX_SAFE_INTEGER;
    const by = b.bbox ? b.bbox[1] : Number.MAX_SAFE_INTEGER;
    if (ay !== by) return ay - by;
    const ax = a.bbox ? a.bbox[0] : 0;
    const bx = b.bbox ? b.bbox[0] : 0;
    return ax - bx;
  });
  return out;
}

/** 한 줄이 문항 시작 헤더인지 판정 + 번호 반환. */
function detectProblemHeader(text: string): number | null {
  const m1 = RE_PROBLEM_HEADER.exec(text);
  if (m1) {
    const n = Number(m1[1]);
    if (n > 0 && n <= 200) return n;
  }
  const m2 = RE_LABELED_HEADER.exec(text);
  if (m2) {
    const n = Number(m2[1] ?? m2[2] ?? m2[3]);
    if (n > 0 && n <= 200) return n;
  }
  return null;
}

/** 줄을 X 좌표로 「왼쪽 끝에서 시작했는지」 확인 (오른쪽 본문 도중 「12.」 같은 오탐 차단). */
function startsAtLeftMargin(line: LineLite, pageWidth: number | undefined): boolean {
  if (!line.bbox) return true; // bbox 없으면 통과 (보수적)
  if (!pageWidth || pageWidth <= 0) return true;
  return line.bbox[0] <= pageWidth * 0.45; // 페이지 절반보다 왼쪽
}

/**
 * 좌표 기반으로 페이지를 segment 들로 분할.
 *
 * 알고리즘 (단순화):
 *  1) 페이지 내 줄을 y 오름차순 정렬 (flattenPageLines)
 *  2) 줄을 순회하며 「문항 시작 헤더」 발견 → 새 segment 시작
 *  3) 「풀이 섹션 시작」 단독 줄 발견 → isSolutionHeader=true segment 로 마킹
 *  4) 그 외 줄은 현재 열려 있는 segment 의 lines 에 누적
 *  5) 단조 증가 검증 (이전 number 보다 너무 멀거나 역행하면 헤더로 안 보고 본문으로)
 */
function segmentPage(
  lines: LineLite[],
  pageWidth: number | undefined,
  pageIndex: number,
): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  let prevNumber: number | null = null;
  let prevMarkerY: number | null = null;

  for (const line of lines) {
    // 풀이 섹션 시작
    if (RE_SOLUTION_SECTION.test(line.text)) {
      if (current) segments.push(current);
      current = {
        number: null,
        pageIndex,
        lines: [],
        isSolutionHeader: true,
      };
      prevNumber = null; // 풀이 섹션 들어가면 번호 리셋
      prevMarkerY = null;
      continue;
    }

    const headerNo = detectProblemHeader(line.text);
    const isHeader =
      headerNo !== null &&
      startsAtLeftMargin(line, pageWidth) &&
      // 단조 증가 검증 — 너무 동떨어진 번호는 본문으로
      (prevNumber === null ||
        (headerNo > prevNumber && headerNo - prevNumber <= 10) ||
        (prevNumber >= 20 && headerNo <= 3)) && // 페이지 넘김에서 번호 리셋 허용
      // 이전 마커와 너무 가까우면 같은 문항 본문일 수 있음
      (prevMarkerY === null || !line.bbox || line.bbox[1] - prevMarkerY >= 12);

    if (isHeader) {
      if (current) segments.push(current);
      current = {
        number: headerNo,
        pageIndex,
        lines: [line],
        isSolutionHeader: false,
      };
      prevNumber = headerNo;
      prevMarkerY = line.bbox ? line.bbox[1] : null;
    } else {
      if (!current) {
        // 페이지 머리에 머리말/문항 번호 없는 줄 → 노이즈 segment 로 시작
        current = {
          number: null,
          pageIndex,
          lines: [],
          isSolutionHeader: false,
        };
      }
      current.lines.push(line);
    }
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * lines.json → 표준 헤더 텍스트.
 *
 * 결과 예:
 *   [문항 1]
 *   다음 …
 *   [문항 2]
 *   …
 *   [정답 및 해설]
 *   [해설 1]
 *   …
 *   [해설 2]
 *   …
 *
 * 이걸 driveAnalysisLearner.parseProblemSolutionPairs 에 입력하면
 * 기존 페어링 알고리즘이 그대로 작동한다 — 자동 폴백의 핵심.
 */
export function rebuildTextFromLineData(linesJson: MathpixPdfLinesJson): string {
  const allSegments: Segment[] = [];
  let solutionSectionStartedAt = -1; // allSegments[] 안 인덱스
  for (let pi = 0; pi < linesJson.pages.length; pi += 1) {
    const page = linesJson.pages[pi];
    const lines = flattenPageLines(page, pi);
    const segs = segmentPage(lines, page.page_width, pi);
    for (const s of segs) {
      if (s.isSolutionHeader && solutionSectionStartedAt < 0) {
        solutionSectionStartedAt = allSegments.length;
      }
      allSegments.push(s);
    }
  }

  // 풀이 섹션 마커가 안 잡혔으면 — 페이지 후반의 「[정답]」 빈도로 추정 (단순 휴리스틱).
  // 이 자동 폴백에선 일단 시도하지 않고 마커 없으면 그대로 둠.

  const out: string[] = [];
  for (let i = 0; i < allSegments.length; i += 1) {
    const s = allSegments[i];
    if (s.isSolutionHeader) {
      out.push("[정답 및 해설]");
      continue;
    }
    if (s.number === null) {
      // 머리말/노이즈 — 풀이 섹션 시작 전이면 무시, 후면 마지막 [해설 N] 본문으로 흡수
      if (solutionSectionStartedAt >= 0 && i > solutionSectionStartedAt) {
        const body = s.lines.map((l) => l.text).join("\n").trim();
        if (body) out.push(body);
      }
      continue;
    }
    const isInSolution =
      solutionSectionStartedAt >= 0 && i > solutionSectionStartedAt;
    const header = isInSolution ? `[해설 ${s.number}]` : `[문항 ${s.number}]`;
    // 헤더 줄에서 「12.」 / 「12)」 prefix 는 제거 — 표준 헤더로 대체
    const linesText = s.lines.map((l) => l.text).join("\n");
    const cleaned = linesText
      .replace(RE_PROBLEM_HEADER, "")
      .replace(RE_LABELED_HEADER, "")
      .trim();
    out.push(header);
    if (cleaned) out.push(cleaned);
  }

  return out.join("\n\n").trim();
}

/**
 * lines.json 진단 — 폴백을 시도할지 결정하는 데 도움.
 * 한 PDF 에서 「문항 헤더로 보이는 줄」이 충분히 많으면 폴백 효과 가능성↑.
 */
export function diagnoseLineData(linesJson: MathpixPdfLinesJson): {
  totalLines: number;
  problemHeaderCount: number;
  hasSolutionSection: boolean;
} {
  let totalLines = 0;
  let problemHeaderCount = 0;
  let hasSolutionSection = false;
  for (const page of linesJson.pages) {
    for (const l of page.lines ?? []) {
      const text = (l.text ?? "").trim();
      if (!text) continue;
      totalLines += 1;
      if (detectProblemHeader(text) !== null) problemHeaderCount += 1;
      if (RE_SOLUTION_SECTION.test(text)) hasSolutionSection = true;
    }
  }
  return { totalLines, problemHeaderCount, hasSolutionSection };
}
