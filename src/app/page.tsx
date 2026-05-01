"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactCrop, {
  type Crop,
  type PixelCrop,
} from "react-image-crop";
import { InlineMath, BlockMath } from "react-katex";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import "react-image-crop/dist/ReactCrop.css";
import "katex/dist/katex.min.css";

type ParsedExplanation = {
  quickAnswer: string;
  body: string;
};

type ExamListResponse = {
  files: string[];
  error?: string;
};

type QueuedProblem = {
  id: string;
  questionNo: string;
  pageLabel: string;
  imageBase64: string;
  imageMimeType: string;
  diagramImages?: Array<{ imageBase64: string; mimeType: string }>;
  crop: PixelCrop;
  diagramCrops?: PixelCrop[];
};

type BatchResult = {
  questionNo: string;
  quickAnswer: string;
  status: "success" | "error";
  message: string;
};

type VisionPrecheckResponse = {
  pass: boolean;
  score: number;
  missing?: string[];
  reasons?: string[];
  error?: string;
  details?: string[];
  model?: string;
};

type DiagramAidRecommendation = {
  recommended: boolean;
  score: number;
  reasons: string[];
};

type QuestionVersionEntry = {
  id: string;
  label: string;
  modelLabel: string;
  sourceType: "single" | "batch" | "manual";
  runId: string;
  createdAt: number;
  rawResponse: string;
  quickAnswer: string;
  explanationBody: string;
  selectedMethodIndexes: number[];
  representativeMethodIndex: number | null;
  workflowStep: ExplanationWorkflowStep;
};

type QuestionVersionState = {
  selectedVersionId: string;
  versions: QuestionVersionEntry[];
};

type ExamSourceKind = "image" | "pdf" | "hml" | "hwp" | "unknown";

const HIGH_VISIBILITY_CROSSHAIR_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M12 1v22M1 12h22' stroke='white' stroke-width='3'/%3E%3Cpath d='M12 1v22M1 12h22' stroke='black' stroke-width='1'/%3E%3C/svg%3E\") 12 12, crosshair";

function getExamSourceKind(fileName: string): ExamSourceKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".hml")) return "hml";
  if (lower.endsWith(".hwp") || lower.endsWith(".hwpx")) return "hwp";
  if (/\.(png|jpg|jpeg|webp|gif)$/i.test(lower)) return "image";
  return "unknown";
}

function parsePageSelection(value: string, maxPage: number) {
  const out = new Set<number>();
  for (const token of value.split(",")) {
    const part = token.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Math.min(Number(range[1]), Number(range[2]));
      const to = Math.max(Number(range[1]), Number(range[2]));
      for (let n = from; n <= to; n += 1) {
        if (n >= 1 && n <= Math.max(1, maxPage)) out.add(n);
      }
      continue;
    }
    const no = Number(part);
    if (Number.isFinite(no) && no >= 1 && no <= Math.max(1, maxPage)) out.add(no);
  }
  return [...out].sort((a, b) => a - b);
}

type ExtractionPrecheck = {
  ok: boolean;
  messages: string[];
};

type PageDraft = {
  dividerMarkers: DividerMarker[];
  verticalGuides: VerticalGuide[];
  diagramBoxes: DiagramBox[];
};

type DividerMarker = {
  id: string;
  labelNo: number;
  xRatio: number;
  yRatio: number;
  segmentIndex: number;
};

type DiagramBox = {
  id: string;
  labelNo: number;
  crop: PixelCrop;
  imageBase64: string;
  mimeType: string;
};

type DividerDragState = {
  id: string;
  startMouseX: number;
  startMouseY: number;
  startXRatio: number;
  startYRatio: number;
};

type DiagramDragState = {
  id: string;
  startMouseX: number;
  startMouseY: number;
  startX: number;
  startY: number;
};

type DiagramResizeState = {
  id: string;
  startMouseX: number;
  startMouseY: number;
  startWidth: number;
  startHeight: number;
  startX: number;
  startY: number;
};

type VerticalGuide = {
  id: string;
  labelNo: number;
  xRatio: number;
};

type ExplanationWorkflowStep =
  | "solve"
  | "select_explanation"
  | "confirm_quick_answer"
  | "generate_sheet";

const DEFAULT_BODY = `해설 생성 버튼을 누르면 이 영역에 결과가 표시됩니다.

[해설]
문제의 핵심 개념과 단계별 풀이를 학생 눈높이에 맞게 작성합니다.`;

function extractSection(text: string, header: string, nextHeaders: string[]) {
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedNext = nextHeaders.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const lookahead =
    escapedNext.length > 0 ? `(?=\\n\\s*\\[(?:${escapedNext.join("|")})\\]|$)` : `(?=$)`;
  const pattern = new RegExp(`\\[${escapedHeader}\\]\\s*:?\\s*([\\s\\S]*?)${lookahead}`, "i");
  const match = text.match(pattern);

  return match?.[1]?.trim() ?? "";
}

function normalizeQuickAnswer(rawQuick: string, fullText: string) {
  const quick = rawQuick.replace(/\s+/g, " ").trim();
  if (!quick) return "-";
  if (/이미지[^.\n]{0,20}(없|누락|미제공)/.test(quick)) return "-";

  const toDigit = (value: string) =>
    value
      .replace("①", "1")
      .replace("②", "2")
      .replace("③", "3")
      .replace("④", "4")
      .replace("⑤", "5");
  const objectiveHint =
    /(①|②|③|④|⑤|\b1\)|\b2\)|\b3\)|\b4\)|\b5\)|객관식|보기|선택지)/.test(fullText);

  const quickOption = quick.match(/[①②③④⑤]|(?<!\d)[1-5](?!\d)/);
  if (objectiveHint && quickOption) {
    return toDigit(quickOption[0]);
  }
  if (objectiveHint) {
    return "-";
  }

  const compact = quick
    .replace(/^정답은\s*/i, "")
    .replace(/^따라서\s*/i, "")
    .replace(/\s*입니다\.?$/i, "")
    .trim();
  return compact || "-";
}

function parseExplanation(raw: string): ParsedExplanation {
  const normalized = raw.trim();
  if (!normalized) {
    return { quickAnswer: "-", body: DEFAULT_BODY };
  }

  // 신규 양식 우선 파싱: [정답], [해설]
  const answerBlocks = [...normalized.matchAll(/\[정답\]\s*([^\n\r]*)/gi)];
  const firstAnswer = answerBlocks[0]?.[1]?.trim() ?? "";
  const firstExplanation = extractSection(normalized, "해설", []);
  if (answerBlocks.length > 0 && firstExplanation) {
    const sanitizedExplanation = firstExplanation.replace(/^\s*\d+\s*[.)]\s*/g, "").trim();
    return {
      quickAnswer: normalizeQuickAnswer(firstAnswer || "-", normalized),
      body: `[해설]\n${sanitizedExplanation}`,
    };
  }

  // 기존 양식 하위 호환: [빠른 정답], [출제 의도 및 개념] ...
  const quickAnswer = extractSection(normalized, "빠른 정답", [
    "출제 의도 및 개념",
    "조건 분석",
    "단계별 풀이",
    "최종 정답 확인",
  ]);
  const concept = extractSection(normalized, "출제 의도 및 개념", [
    "조건 분석",
    "단계별 풀이",
    "최종 정답 확인",
  ]);
  const condition = extractSection(normalized, "조건 분석", [
    "단계별 풀이",
    "최종 정답 확인",
  ]);
  const steps = extractSection(normalized, "단계별 풀이", ["최종 정답 확인"]);
  const finalAnswer = extractSection(normalized, "최종 정답 확인", []);
  const legacyBody = [
    `[출제 의도 및 개념] : ${concept || "내용이 제공되지 않았습니다."}`,
    `[조건 분석] : ${condition || "내용이 제공되지 않았습니다."}`,
    `[단계별 풀이] : ${steps || "내용이 제공되지 않았습니다."}`,
    `[최종 정답 확인] : ${finalAnswer || "내용이 제공되지 않았습니다."}`,
  ].join("\n\n");

  return {
    quickAnswer: normalizeQuickAnswer(quickAnswer || "-", normalized),
    body: legacyBody,
  };
}

function renderWithMath(text: string) {
  const parts = text.split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+\$)/g);

  return parts.map((part, index) => {
    if (part.startsWith("$$") && part.endsWith("$$")) {
      const expression = part.slice(2, -2).trim();
      return <BlockMath key={`block-${index}`}>{expression}</BlockMath>;
    }

    if (part.startsWith("$") && part.endsWith("$")) {
      const expression = part.slice(1, -1).trim();
      return <InlineMath key={`inline-${index}`}>{expression}</InlineMath>;
    }

    return (
      <span key={`text-${index}`} className="whitespace-pre-wrap">
        {part}
      </span>
    );
  });
}

function renderMethodBlocks(text: string) {
  const methodRegex = /(\[방법\s*\d+\][\s\S]*?)(?=\n\s*\[방법\s*\d+\]|$)/g;
  const methods = text.match(methodRegex);
  if (!methods || methods.length === 0) {
    return <div className="whitespace-pre-wrap">{renderWithMath(text)}</div>;
  }

  return (
    <div className="space-y-3">
      {methods.map((methodText, idx) => (
        <section
          key={`method-${idx}`}
          className="break-inside-avoid rounded-md border border-slate-200 bg-slate-50 p-3"
        >
          {renderWithMath(methodText.trim())}
        </section>
      ))}
    </div>
  );
}

function splitMethodBlocks(text: string) {
  const methodRegex = /(\[방법\s*\d+\][\s\S]*?)(?=\n\s*\[방법\s*\d+\]|$)/g;
  const methods = text.match(methodRegex) ?? [];
  if (methods.length === 0) {
    return { intro: text.trim(), methods: [] as string[] };
  }

  const firstMethodIndex = text.search(/\[방법\s*\d+\]/);
  const intro = firstMethodIndex > 0 ? text.slice(0, firstMethodIndex).trim() : "";
  return { intro, methods: methods.map((item) => item.trim()) };
}

function buildSelectedExplanationBody(
  text: string,
  selectedMethodIndexes: number[],
  representativeMethodIndex: number | null,
) {
  const blocks = splitMethodBlocks(text);
  if (blocks.methods.length === 0) {
    return text;
  }

  const selectedIndexes =
    selectedMethodIndexes.length > 0 ? selectedMethodIndexes : [0];
  const orderedIndexes = [...selectedIndexes];
  if (
    representativeMethodIndex !== null &&
    selectedIndexes.includes(representativeMethodIndex)
  ) {
    const others = orderedIndexes.filter((idx) => idx !== representativeMethodIndex);
    orderedIndexes.splice(0, orderedIndexes.length, representativeMethodIndex, ...others);
  }

  const safeSelected = orderedIndexes.map((index) => blocks.methods[index]);
  return [blocks.intro, ...safeSelected].filter(Boolean).join("\n\n");
}

function toBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("이미지를 읽을 수 없습니다."));
        return;
      }
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(new Error("이미지 인코딩에 실패했습니다."));
    reader.readAsDataURL(file);
  });
}

function cropImageToBase64(
  image: HTMLImageElement,
  crop: PixelCrop,
  mimeType: string,
) {
  const canvas = document.createElement("canvas");
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;
  const rawWidth = Math.max(1, Math.floor(crop.width * scaleX));
  const rawHeight = Math.max(1, Math.floor(crop.height * scaleY));
  const maxEdge = 2048;
  const resizeRatio = Math.min(1, maxEdge / Math.max(rawWidth, rawHeight));
  canvas.width = Math.max(1, Math.floor(rawWidth * resizeRatio));
  canvas.height = Math.max(1, Math.floor(rawHeight * resizeRatio));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("이미지 캔버스를 생성하지 못했습니다.");
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    crop.x * scaleX,
    crop.y * scaleY,
    rawWidth,
    rawHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const normalizedMimeType =
    mimeType && mimeType.startsWith("image/") ? mimeType : "image/png";
  return canvas.toDataURL(normalizedMimeType, 0.92).split(",")[1] ?? "";
}

function normalizeCrop(candidate?: Crop | PixelCrop | null): PixelCrop | null {
  if (!candidate) return null;
  const width = Number(candidate.width ?? 0);
  const height = Number(candidate.height ?? 0);
  const x = Number(candidate.x ?? 0);
  const y = Number(candidate.y ?? 0);
  if (width <= 1 || height <= 1) return null;
  return {
    unit: "px",
    x,
    y,
    width,
    height,
  };
}

function getNextQuestionNo(current: string) {
  const parsed = Number.parseInt(current.trim(), 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return "1";
  }
  return String(parsed + 1);
}

/** 화면에 맞춰 축소된 img 좌표계 crop → 실제 비트맵(natural) 픽셀 crop */
function pixelCropToNatural(crop: PixelCrop, image: HTMLImageElement): PixelCrop {
  const sx = image.naturalWidth / Math.max(1, image.width);
  const sy = image.naturalHeight / Math.max(1, image.height);
  return {
    unit: "px",
    x: crop.x * sx,
    y: crop.y * sy,
    width: crop.width * sx,
    height: crop.height * sy,
  };
}

/**
 * 추출 품질 사전검증. crop·image 크기는 같은 좌표계(보통 natural 픽셀)여야 합니다.
 * 임계값은 고정 픽셀만 쓰지 않고 페이지 크기 비율을 함께 써서, 미리보기 축소 시 오탐을 줄입니다.
 */
function runExtractionPrecheck(
  crop: PixelCrop,
  imageWidth: number,
  imageHeight: number,
): ExtractionPrecheck {
  const messages: string[] = [];
  const safeImageWidth = Math.max(1, imageWidth);
  const safeImageHeight = Math.max(1, imageHeight);

  const minWidth = Math.max(200, Math.round(safeImageWidth * 0.024));
  const minHeight = Math.max(72, Math.round(safeImageHeight * 0.02));
  const minArea = Math.max(22000, Math.round(minWidth * minHeight * 0.35));
  const minHeightRatio = 0.045;
  const maxAspectRatio = 4.8;

  if (crop.width < minWidth) {
    messages.push("문제 영역 가로가 너무 좁습니다.");
  }
  if (crop.height < minHeight) {
    messages.push("문제 영역 세로가 너무 짧습니다.");
  }
  if (crop.width * crop.height < minArea) {
    messages.push("문제/선택지/조건이 누락될 수 있는 작은 영역입니다.");
  }
  if (crop.height / safeImageHeight < minHeightRatio) {
    messages.push("선택지 또는 조건 영역이 잘렸을 가능성이 높습니다.");
  }
  if (crop.width / Math.max(1, crop.height) > maxAspectRatio) {
    messages.push("영역이 너무 가로로 길어 문항 하단 정보가 누락될 수 있습니다.");
  }
  if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > imageWidth + 1 || crop.y + crop.height > imageHeight + 1) {
    messages.push("선택 영역이 이미지 경계를 벗어났습니다.");
  }

  return { ok: messages.length === 0, messages };
}

function runExtractionPrecheckForDisplayedCrop(
  crop: PixelCrop,
  image: HTMLImageElement | null,
): ExtractionPrecheck {
  if (!image || image.naturalWidth < 1 || image.naturalHeight < 1) {
    return runExtractionPrecheck(crop, Math.max(1, crop.x + crop.width), Math.max(1, crop.y + crop.height));
  }
  const naturalCrop = pixelCropToNatural(crop, image);
  return runExtractionPrecheck(naturalCrop, image.naturalWidth, image.naturalHeight);
}

export default function Home() {
  const resultRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dividerOverlayRef = useRef<HTMLDivElement | null>(null);
  const dividerIdRef = useRef(1);
  const verticalGuideIdRef = useRef(1);
  const diagramIdRef = useRef(1);
  const suppressOverlayClickRef = useRef(false);
  const dividerDragMovedRef = useRef(false);
  const pdfJsRef = useRef<any>(null);
  const pdfDocRef = useRef<any>(null);
  const pdfDocKeyRef = useRef("");
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);
  const [isLoadingSelectedFile, setIsLoadingSelectedFile] = useState(false);
  const [examFiles, setExamFiles] = useState<string[]>([]);
  const [selectedExam, setSelectedExam] = useState("");
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [isPdfSource, setIsPdfSource] = useState(false);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [pdfPageNo, setPdfPageNo] = useState(1);
  const [sourceImage, setSourceImage] = useState<string>("");
  const [renderImageSize, setRenderImageSize] = useState({ width: 0, height: 0 });
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [questionNo, setQuestionNo] = useState("1");
  const [questionText, setQuestionText] = useState("");
  const [useTextInput, setUseTextInput] = useState(false);
  const [includeDiagramExplanation, setIncludeDiagramExplanation] = useState(true);
  const [generationMode, setGenerationMode] = useState<"test" | "final">("test");
  const [explanationSelectionMode, setExplanationSelectionMode] = useState<
    "all" | "core"
  >("all");
  const [showAllMethods, setShowAllMethods] = useState(true);
  const [quickAnswer, setQuickAnswer] = useState("-");
  const [workflowStep, setWorkflowStep] = useState<ExplanationWorkflowStep>("solve");
  const [methodSelectionPolicy, setMethodSelectionPolicy] = useState<"all" | "selected">("all");
  const [explanationBody, setExplanationBody] = useState(DEFAULT_BODY);
  const [rawResponse, setRawResponse] = useState("");
  const [qualityWarnings, setQualityWarnings] = useState<string[]>([]);
  const [diagramAidRecommendation, setDiagramAidRecommendation] =
    useState<DiagramAidRecommendation | null>(null);
  const [questionVersionMap, setQuestionVersionMap] = useState<
    Record<string, QuestionVersionState>
  >({});
  const [hmlFile, setHmlFile] = useState<File | null>(null);
  const [hmlManualQuestionSelection, setHmlManualQuestionSelection] = useState("1-30");
  const [hmlExecutionMode, setHmlExecutionMode] = useState<"manual" | "auto_assist">("manual");
  const [quickAnswerPageSelection, setQuickAnswerPageSelection] = useState("");
  const [explanationRefPageSelection, setExplanationRefPageSelection] = useState("");
  const [noQuickAnswerPage, setNoQuickAnswerPage] = useState(false);
  const [noExplanationRefPage, setNoExplanationRefPage] = useState(false);
  const [isProcessingHml, setIsProcessingHml] = useState(false);
  const [isLoadingExams, setIsLoadingExams] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  const [queuedProblems, setQueuedProblems] = useState<QueuedProblem[]>([]);
  const [savedPageNumbers, setSavedPageNumbers] = useState<number[]>([]);
  const [excludedPageNumbers, setExcludedPageNumbers] = useState<number[]>([]);
  const [savedPageWorks, setSavedPageWorks] = useState<Record<number, QueuedProblem[]>>({});
  const [pageDrafts, setPageDrafts] = useState<Record<number, PageDraft>>({});
  const [pendingLineCrop, setPendingLineCrop] = useState<PixelCrop | null>(null);
  const [dividerMarkers, setDividerMarkers] = useState<DividerMarker[]>([]);
  const [verticalGuides, setVerticalGuides] = useState<VerticalGuide[]>([]);
  const [dividerDragState, setDividerDragState] = useState<DividerDragState | null>(null);
  const [diagramDragState, setDiagramDragState] = useState<DiagramDragState | null>(null);
  const [diagramResizeState, setDiagramResizeState] = useState<DiagramResizeState | null>(null);
  const [linePlacementMode] = useState(false);
  const [verticalGuideMode, setVerticalGuideMode] = useState(false);
  const [pendingDiagramBoxes, setPendingDiagramBoxes] = useState<DiagramBox[]>([]);
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [selectedMethodIndexes, setSelectedMethodIndexes] = useState<number[]>([]);
  const [representativeMethodIndex, setRepresentativeMethodIndex] = useState<number | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const hasImage = Boolean(sourceImage && sourceFile);
  const selectedExamKind = selectedExam ? getExamSourceKind(selectedExam) : "unknown";
  const questionNoOptions = useMemo(
    () => [...new Set(queuedProblems.map((item) => item.questionNo))].sort((a, b) => Number(a) - Number(b)),
    [queuedProblems],
  );
  const currentQuestionVersionState = questionVersionMap[questionNo] || null;
  const selectedQuestionVersion =
    currentQuestionVersionState?.versions.find(
      (item) => item.id === currentQuestionVersionState.selectedVersionId,
    ) || null;
  const hasGeneratedResult = rawResponse.trim().length > 0;
  const canGenerate = hasImage && !isGenerating && !isLoadingExams;
  const sortedVerticalGuides = useMemo(
    () => [...verticalGuides].sort((a, b) => a.xRatio - b.xRatio),
    [verticalGuides],
  );
  const sortedDividerMarkers = useMemo(
    () => [...dividerMarkers].sort((a, b) => a.yRatio - b.yRatio),
    [dividerMarkers],
  );
  const currentPageDividerRange = useMemo(() => {
    if (dividerMarkers.length === 0) return null;
    const labels = dividerMarkers.map((item) => item.labelNo);
    return { start: Math.min(...labels), end: Math.max(...labels) };
  }, [dividerMarkers]);
  const nextDividerLabelNo = useMemo(() => {
    const allLabels = Object.values(pageDrafts).flatMap((draft) =>
      draft.dividerMarkers.map((item) => item.labelNo),
    );
    return (allLabels.length > 0 ? Math.max(...allLabels) : 0) + 1;
  }, [pageDrafts]);
  const totalPageCount = isPdfSource ? pdfPageCount : 1;
  const quickAnswerPages = useMemo(
    () => (isPdfSource && !noQuickAnswerPage ? parsePageSelection(quickAnswerPageSelection, totalPageCount) : []),
    [isPdfSource, noQuickAnswerPage, quickAnswerPageSelection, totalPageCount],
  );
  const explanationRefPages = useMemo(
    () =>
      isPdfSource && !noExplanationRefPage
        ? parsePageSelection(explanationRefPageSelection, totalPageCount)
        : [],
    [isPdfSource, noExplanationRefPage, explanationRefPageSelection, totalPageCount],
  );
  const referenceOnlyPages = useMemo(
    () => [...new Set([...quickAnswerPages, ...explanationRefPages])].sort((a, b) => a - b),
    [quickAnswerPages, explanationRefPages],
  );
  const hasQuickAnswerSelectionInput = !noQuickAnswerPage && quickAnswerPageSelection.trim().length > 0;
  const hasExplanationRefSelectionInput =
    !noExplanationRefPage && explanationRefPageSelection.trim().length > 0;
  const invalidQuickAnswerSelection = hasQuickAnswerSelectionInput && quickAnswerPages.length === 0;
  const invalidExplanationRefSelection = hasExplanationRefSelectionInput && explanationRefPages.length === 0;
  const requiredPageNumbers = useMemo(
    () =>
      Array.from({ length: totalPageCount }, (_, idx) => idx + 1).filter(
        (pageNo) =>
          !excludedPageNumbers.includes(pageNo) && !referenceOnlyPages.includes(pageNo),
      ),
    [totalPageCount, excludedPageNumbers, referenceOnlyPages],
  );
  const completedRequiredPageCount = useMemo(
    () => requiredPageNumbers.filter((pageNo) => savedPageNumbers.includes(pageNo)).length,
    [requiredPageNumbers, savedPageNumbers],
  );
  const isCurrentPageSaved = savedPageNumbers.includes(isPdfSource ? pdfPageNo : 1);
  const isCurrentPageExcluded = excludedPageNumbers.includes(isPdfSource ? pdfPageNo : 1);
  const canEnterStep3 =
    totalPageCount > 0 &&
    requiredPageNumbers.length > 0 &&
    requiredPageNumbers.every((pageNo) => savedPageNumbers.includes(pageNo));
  const methodBlocks = useMemo(() => splitMethodBlocks(explanationBody), [explanationBody]);
  const selectedExplanationBody = useMemo(
    () =>
      buildSelectedExplanationBody(
        explanationBody,
        methodSelectionPolicy === "all"
          ? methodBlocks.methods.map((_, index) => index)
          : selectedMethodIndexes,
        representativeMethodIndex,
      ),
    [
      explanationBody,
      methodSelectionPolicy,
      methodBlocks.methods,
      selectedMethodIndexes,
      representativeMethodIndex,
    ],
  );

  const applyVersionToEditor = useCallback((version: QuestionVersionEntry) => {
    setRawResponse(version.rawResponse);
    setQuickAnswer(version.quickAnswer);
    setExplanationBody(version.explanationBody);
    setSelectedMethodIndexes(
      version.selectedMethodIndexes.length > 0 ? version.selectedMethodIndexes : [0],
    );
    setRepresentativeMethodIndex(version.representativeMethodIndex);
    setWorkflowStep(version.workflowStep);
  }, []);

  const pushQuestionVersion = useCallback(
    (
      targetQuestionNo: string,
      payload: {
        rawResponse: string;
        quickAnswer: string;
        explanationBody: string;
        selectedMethodIndexes: number[];
        representativeMethodIndex: number | null;
        workflowStep: ExplanationWorkflowStep;
        modelLabel: string;
        sourceType: "single" | "batch" | "manual";
        runId: string;
      },
      activate = true,
    ) => {
      setQuestionVersionMap((prev) => {
        const prevState = prev[targetQuestionNo];
        const nextIndex = (prevState?.versions.length || 0) + 1;
        const version: QuestionVersionEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label: `v${nextIndex}`,
          modelLabel: payload.modelLabel,
          sourceType: payload.sourceType,
          runId: payload.runId,
          createdAt: Date.now(),
          rawResponse: payload.rawResponse,
          quickAnswer: payload.quickAnswer,
          explanationBody: payload.explanationBody,
          selectedMethodIndexes: payload.selectedMethodIndexes,
          representativeMethodIndex: payload.representativeMethodIndex,
          workflowStep: payload.workflowStep,
        };
        const versions = [...(prevState?.versions || []), version];
        return {
          ...prev,
          [targetQuestionNo]: {
            selectedVersionId:
              activate || !prevState?.selectedVersionId
                ? version.id
                : prevState.selectedVersionId,
            versions,
          },
        };
      });
    },
    [],
  );

  const selectQuestionVersion = useCallback(
    (targetQuestionNo: string, versionId: string) => {
      setQuestionVersionMap((prev) => {
        const state = prev[targetQuestionNo];
        if (!state) return prev;
        return {
          ...prev,
          [targetQuestionNo]: {
            ...state,
            selectedVersionId: versionId,
          },
        };
      });
      const state = questionVersionMap[targetQuestionNo];
      const version = state?.versions.find((item) => item.id === versionId);
      if (version) {
        applyVersionToEditor(version);
      }
    },
    [applyVersionToEditor, questionVersionMap],
  );

  const syncRenderImageSize = useCallback(() => {
    if (!imageRef.current) return;
    setRenderImageSize({
      width: imageRef.current.clientWidth,
      height: imageRef.current.clientHeight,
    });
  }, []);

  const getSegmentBounds = (segmentIndex: number) => {
    const boundaries = [0, ...sortedVerticalGuides.map((g) => g.xRatio), 1];
    const safeIndex = Math.max(0, Math.min(segmentIndex, boundaries.length - 2));
    return {
      left: boundaries[safeIndex],
      right: boundaries[safeIndex + 1],
    };
  };

  const getSegmentIndexByXRatio = (xRatio: number) => {
    let idx = 0;
    for (const guide of sortedVerticalGuides) {
      if (xRatio > guide.xRatio) idx += 1;
    }
    return idx;
  };

  const clampMarkersToSegments = (
    markers: DividerMarker[],
    guides: VerticalGuide[],
  ): DividerMarker[] => {
    const sortedGuides = [...guides].sort((a, b) => a.xRatio - b.xRatio);
    const boundaries = [0, ...sortedGuides.map((g) => g.xRatio), 1];
    return markers.map((marker) => {
      const inferredSegment =
        typeof marker.segmentIndex === "number" && Number.isFinite(marker.segmentIndex)
          ? marker.segmentIndex
          : getSegmentIndexByXRatio(marker.xRatio);
      const safeSegment = Math.max(0, Math.min(inferredSegment, boundaries.length - 2));
      const left = boundaries[safeSegment];
      const right = boundaries[safeSegment + 1];
      const minX = Math.min(right, left + 0.002);
      const maxX = Math.max(left, right - 0.002);
      return {
        ...marker,
        segmentIndex: safeSegment,
        xRatio: Math.max(minX, Math.min(maxX, marker.xRatio)),
      };
    });
  };

  const updateImageSource = (blob: Blob, fileName: string) => {
    const objectUrl = URL.createObjectURL(blob);
    setSourceImage(objectUrl);
    setSourceFile(
      new File([blob], fileName.replace(/\.pdf$/i, ".png"), { type: "image/png" }),
    );
    setDividerMarkers([]);
    setVerticalGuides([]);
  };

  const renderPdfPageToImage = async (file: File, pageNo: number) => {
    if (!pdfJsRef.current) {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      (pdfjs.GlobalWorkerOptions as { workerSrc: string }).workerSrc =
        `https://unpkg.com/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;
      pdfJsRef.current = pdfjs;
    }
    const pdfjs = pdfJsRef.current;
    const docKey = `${file.name}:${file.size}:${file.lastModified}`;
    if (!pdfDocRef.current || pdfDocKeyRef.current !== docKey) {
      const arrayBuffer = await file.arrayBuffer();
      pdfDocRef.current = await pdfjs.getDocument({
        data: arrayBuffer,
      } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
      pdfDocKeyRef.current = docKey;
    }
    const pdf = pdfDocRef.current;
    const safePageNo = Math.max(1, Math.min(pageNo, pdf.numPages));
    const page = await pdf.getPage(safePageNo);
    const viewport = page.getViewport({ scale: 1.7 });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("PDF 렌더링 캔버스를 생성하지 못했습니다.");
    }
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (!result) {
          reject(new Error("PDF 페이지를 이미지로 변환하지 못했습니다."));
          return;
        }
        resolve(result);
      }, "image/png");
    });
    updateImageSource(blob, file.name);
    setPdfPageCount(pdf.numPages);
    setPdfPageNo(safePageNo);
  };

  const loadSourceFile = async (file: File) => {
    const sourceKind = getExamSourceKind(file.name);
    if (sourceKind === "hml" || sourceKind === "hwp") {
      throw new Error(
        "한글 원본 파일은 이미지 작업 단계가 아닙니다. 1단계의 '원본 HML 기반 해설 붙이기'를 사용해 주세요.",
      );
    }

    setOriginalFile(file);
    setSelectedExam(file.name);
    setCrop(undefined);
    setCompletedCrop(undefined);
    setDividerMarkers([]);
    setVerticalGuides([]);
    setVerticalGuideMode(false);
    clearPendingSelection();
    setErrorMessage("");
    setSuccessMessage("");
    setDiagramAidRecommendation(null);
    setQueuedProblems([]);
    setSavedPageNumbers([]);
    setExcludedPageNumbers([]);
    setSavedPageWorks({});
    setPageDrafts({});
    setQuestionNo("1");
    setBatchResults([]);
    setWorkflowStep("solve");
    setMethodSelectionPolicy("all");
    pdfDocRef.current = null;
    pdfDocKeyRef.current = "";

    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      setIsPdfSource(true);
      await renderPdfPageToImage(file, 1);
      setCurrentStep(2);
      return;
    }

    setIsPdfSource(false);
    setPdfPageCount(0);
    setPdfPageNo(1);
    const objectUrl = URL.createObjectURL(file);
    setSourceImage(objectUrl);
    setSourceFile(file);
    setCurrentStep(2);
  };

  const loadExamFiles = useCallback(async () => {
    try {
      setIsLoadingExams(true);
      setErrorMessage("");
      const response = await fetch("/api/exams", { cache: "no-store" });
      const data = (await response.json()) as ExamListResponse;
      if (!response.ok) {
        throw new Error(data.error || "시험지 목록 조회에 실패했습니다.");
      }
      setExamFiles(data.files);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "시험지 목록 조회 중 오류가 발생했습니다.";
      setErrorMessage(message);
    } finally {
      setIsLoadingExams(false);
    }
  }, []);

  useEffect(() => {
    if (currentStep !== 1) return;
    void loadExamFiles();
  }, [currentStep, loadExamFiles]);

  useEffect(() => {
    if (methodBlocks.methods.length === 0) return;
    if (methodSelectionPolicy === "all") {
      const all = methodBlocks.methods.map((_, index) => index);
      setSelectedMethodIndexes(all);
      if (representativeMethodIndex === null && all.length > 0) {
        setRepresentativeMethodIndex(all[0]);
      }
      return;
    }
    if (selectedMethodIndexes.length === 0) {
      setSelectedMethodIndexes([0]);
      if (representativeMethodIndex === null) setRepresentativeMethodIndex(0);
    }
  }, [
    methodBlocks.methods,
    methodSelectionPolicy,
    representativeMethodIndex,
    selectedMethodIndexes.length,
  ]);

  useEffect(() => {
    if (!imageRef.current) return;
    const target = imageRef.current;
    syncRenderImageSize();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        syncRenderImageSize();
      });
      observer.observe(target);
    }
    const handleWindowResize = () => {
      syncRenderImageSize();
    };
    window.addEventListener("resize", handleWindowResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [sourceImage, syncRenderImageSize]);

  useEffect(() => {
    const state = questionVersionMap[questionNo];
    if (!state) return;
    const selected =
      state.versions.find((item) => item.id === state.selectedVersionId) || state.versions[0];
    if (!selected) return;
    applyVersionToEditor(selected);
  }, [applyVersionToEditor, questionNo, questionVersionMap]);

  const loadExamImage = async (fileName: string) => {
    try {
      setSelectedExam(fileName);
      const sourceKind = getExamSourceKind(fileName);
      if (sourceKind === "hwp" || sourceKind === "hml") {
        setErrorMessage(
          "`.hml/.hwp/.hwpx`는 현재 이미지 편집 기반 처리에서 직접 열 수 없습니다. PDF 또는 이미지(png/jpg)로 변환한 뒤 진행해 주세요.",
        );
        setSuccessMessage("");
        return;
      }
      setIsLoadingSelectedFile(true);
      setErrorMessage("");
      setSuccessMessage("");
      const response = await fetch(
        `/api/exams/file?name=${encodeURIComponent(fileName)}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "시험지 이미지를 불러오지 못했습니다.");
      }
      const blob = await response.blob();
      const file = new File([blob], fileName, {
        type: blob.type || "application/octet-stream",
      });
      await loadSourceFile(file);
      setSuccessMessage("시험지를 불러왔습니다. 다음 단계에서 영역을 지정하세요.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "시험지 선택 중 오류가 발생했습니다.";
      setErrorMessage(message);
    }
    finally {
      setIsLoadingSelectedFile(false);
    }
  };

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsLoadingSelectedFile(true);
    void loadSourceFile(file)
      .then(() => {
        setSuccessMessage("파일을 불러왔습니다. 다음 단계에서 영역을 지정하세요.");
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "파일 로딩 중 오류가 발생했습니다.";
        setErrorMessage(message);
      })
      .finally(() => {
        setIsLoadingSelectedFile(false);
      });
  };

  const handleHmlAppendSolution = async () => {
    if (!hmlFile) {
      setErrorMessage("먼저 .hml 원본 파일을 선택해 주세요.");
      return;
    }
    try {
      setIsProcessingHml(true);
      setErrorMessage("");
      setSuccessMessage("");
      const formData = new FormData();
      formData.append("hmlFile", hmlFile);
      formData.append("mode", hmlExecutionMode);
      if (hmlManualQuestionSelection.trim()) {
        formData.append("manualQuestionSelection", hmlManualQuestionSelection.trim());
      }
      const response = await fetch("/api/hml/append-solution", {
        method: "POST",
        body: formData,
      });
      const data = (await response.json()) as {
        error?: string;
        message?: string;
        fileName?: string;
        questionCount?: number;
        parsingDiagnostics?: {
          strategy?: string;
          paragraphQuestionCount?: number;
          autonumBlockQuestionCount?: number;
          bodyFallbackQuestionCount?: number;
          fallbackQuestionCount?: number;
          quickAnswerSource?: string;
          sourceProfile?: string;
          aiExtractedQuestionCount?: number;
          openAiFallbackCount?: number;
          noisyQuestionCount?: number;
          notes?: string[];
        };
        parsingQuality?: {
          pass?: boolean;
          warnings?: string[];
          coverageRatio?: number;
          mismatchRatio?: number;
        };
        quickAnswerStats?: {
          verifiedCount?: number;
          filledCount?: number;
          mismatchCount?: number;
        };
        manualSelectionApplied?: number[] | null;
        mode?: "manual" | "auto_assist";
        requiresManualReview?: boolean;
        assistGuidance?: string | null;
      };
      if (!response.ok) {
        throw new Error(data.error || "원본 기반 해설 생성에 실패했습니다.");
      }
      setSuccessMessage(
        `${data.message || "원본 기반 해설 생성 완료"} (${data.questionCount || 0}문항)${
          data.quickAnswerStats
            ? ` | 검증 ${data.quickAnswerStats.verifiedCount || 0} / 보완 ${
                data.quickAnswerStats.filledCount || 0
              } / 불일치 ${data.quickAnswerStats.mismatchCount || 0}`
            : ""
        }${
          data.manualSelectionApplied?.length
            ? ` | 수동문항 ${data.manualSelectionApplied.join(", ")}`
            : ""
        }${
          data.mode ? ` | 모드 ${data.mode === "manual" ? "수동메인" : "자동보조"}` : ""
        }${
          data.parsingDiagnostics
            ? ` | 파싱 ${
                data.parsingDiagnostics.strategy === "paragraph-priority" ? "문단우선" : "텍스트대체"
              } / 문단추출 ${data.parsingDiagnostics.paragraphQuestionCount || 0} / 구조추출 ${
                data.parsingDiagnostics.autonumBlockQuestionCount || 0
              } / 대체추출 ${
                data.parsingDiagnostics.bodyFallbackQuestionCount ||
                data.parsingDiagnostics.fallbackQuestionCount ||
                0
              } / 정답원천 ${
                data.parsingDiagnostics.quickAnswerSource === "hml-endnote" ? "원본정답표" : "본문추출"
              } / 프로필 ${
                data.parsingDiagnostics.sourceProfile === "core-request-set" ? "대표샘플" : "기본"
              } / AI추출 ${data.parsingDiagnostics.aiExtractedQuestionCount || 0} / GPT백업 ${
                data.parsingDiagnostics.openAiFallbackCount || 0
              } / 노이즈문항 ${
                data.parsingDiagnostics.noisyQuestionCount || 0
              }`
            : ""
        }${
          data.parsingQuality
            ? ` | 품질 ${data.parsingQuality.pass ? "PASS" : "CHECK"} (커버리지 ${Math.round(
                (data.parsingQuality.coverageRatio || 0) * 100,
              )}%, 불일치 ${Math.round((data.parsingQuality.mismatchRatio || 0) * 100)}%)`
            : ""
        } ${data.fileName ? `- ${data.fileName}` : ""}`,
      );
      if (data.parsingDiagnostics?.notes?.length) {
        console.info("HML 파싱 보정 노트:", data.parsingDiagnostics.notes);
      }
      if (data.requiresManualReview && data.assistGuidance) {
        setErrorMessage(`자동 보조 경고: ${data.assistGuidance}`);
      }
      if (data.parsingQuality?.warnings?.length) {
        setErrorMessage(`HML 품질 점검 경고: ${data.parsingQuality.warnings.join(" / ")}`);
      }
      setHmlFile(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "원본 기반 해설 처리 중 오류가 발생했습니다.";
      setErrorMessage(message);
    } finally {
      setIsProcessingHml(false);
    }
  };

  const handleGenerateExplanation = async () => {
    if (!sourceFile) {
      setErrorMessage("문제 이미지를 먼저 업로드해 주세요.");
      return;
    }
    if (!imageRef.current) {
      setErrorMessage("이미지 로딩이 완료된 뒤 다시 시도해 주세요.");
      return;
    }
    if (isPdfSource && !requiredPageNumbers.includes(pdfPageNo)) {
      setErrorMessage(
        "현재 페이지는 빠른정답/해설참고로 지정되어 풀이 대상에서 제외된 페이지입니다. 문제 페이지로 이동해 주세요.",
      );
      return;
    }
    try {
      setIsGenerating(true);
      const singleRunId = `single-${Date.now()}`;
      setErrorMessage("");
      setSuccessMessage("");
      setQualityWarnings([]);

      const mimeType = sourceFile.type || "image/png";
      const selectedProblemCrop =
        pendingDiagramBoxes[0]?.crop ?? (completedCrop ? normalizeCrop(completedCrop) : null);
      if (selectedProblemCrop && imageRef.current) {
        const precheck = runExtractionPrecheckForDisplayedCrop(
          selectedProblemCrop,
          imageRef.current,
        );
        if (!precheck.ok) {
          setErrorMessage(
            `생성을 중단했습니다. 문제 추출 품질이 낮습니다: ${precheck.messages.join(" / ")} 문제 박스를 다시 지정해 주세요.`,
          );
          return;
        }
      }
      const imageBase64 = selectedProblemCrop
        ? cropImageToBase64(imageRef.current, selectedProblemCrop, mimeType)
        : await toBase64(sourceFile);
      const visionPrecheckRes = await fetch("/api/precheck-extraction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64,
          imageMimeType: mimeType,
          crop: selectedProblemCrop,
        }),
      });
      const visionPrecheckData = (await visionPrecheckRes.json()) as VisionPrecheckResponse;
      if (!visionPrecheckRes.ok) {
        if (visionPrecheckRes.status >= 500) {
          const details = visionPrecheckData.details?.join(" | ");
          setQualityWarnings((prev) => [
            ...prev,
            `비전 사전검증 서버 오류(${visionPrecheckRes.status})로 검증을 건너뛰고 생성을 계속합니다.${
              details ? ` 상세: ${details}` : ""
            }`,
          ]);
        } else {
          throw new Error(
            visionPrecheckData.error || "문제 이미지 비전 사전검증 호출에 실패했습니다.",
          );
        }
      }
      if (visionPrecheckRes.ok && !visionPrecheckData.pass) {
        const reasons = [...(visionPrecheckData.reasons || []), ...(visionPrecheckData.missing || [])]
          .filter(Boolean)
          .join(" / ");
        setErrorMessage(
          `생성을 중단했습니다. 문제 추출 비전 사전검증 점수 ${visionPrecheckData.score}점(기준 70점 이상). ${reasons || "핵심 정보 누락 가능성이 높습니다."} 문제 박스를 다시 지정해 주세요.`,
        );
        return;
      }
      const liveDiagramImages = pendingDiagramBoxes.map((box) => ({
        imageBase64: cropImageToBase64(imageRef.current!, box.crop, box.mimeType || mimeType),
        mimeType: box.mimeType || mimeType,
      }));

      const response = await fetch("/api/generate-explanation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          questionText: useTextInput ? questionText : "",
          imageBase64,
          imageMimeType: mimeType,
          diagramImages: liveDiagramImages,
          quickAnswerPageHint:
            quickAnswerPages.length > 0
              ? `빠른정답 참고 페이지: ${quickAnswerPages.join(", ")}`
              : "",
          explanationReferenceHint:
            explanationRefPages.length > 0
              ? `해설 참고 페이지: ${explanationRefPages.join(", ")}`
              : "",
          generationMode,
          includeDiagramExplanation,
          explanationSelectionMode,
          showAllMethods,
          crop: selectedProblemCrop,
        }),
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string; details?: string[] };
        const detailText =
          data.details && data.details.length > 0
            ? `\n상세: ${data.details.join(" | ")}`
            : "";
        throw new Error((data.error || "해설 생성에 실패했습니다.") + detailText);
      }

      const data = (await response.json()) as {
        result: string;
        qualityWarnings?: string[];
        diagramAidRecommendation?: DiagramAidRecommendation;
        model?: string;
      };
      const parsed = parseExplanation(data.result);
      setRawResponse(data.result);
      setQualityWarnings(data.qualityWarnings ?? []);
      setDiagramAidRecommendation(data.diagramAidRecommendation ?? null);
      setQuickAnswer(parsed.quickAnswer);
      setExplanationBody(parsed.body);
      setSelectedMethodIndexes(
        splitMethodBlocks(parsed.body).methods.map((_, index) => index),
      );
      setRepresentativeMethodIndex(
        splitMethodBlocks(parsed.body).methods.length > 0 ? 0 : null,
      );
      setMethodSelectionPolicy("all");
      setWorkflowStep(
        splitMethodBlocks(parsed.body).methods.length > 1
          ? "select_explanation"
          : "confirm_quick_answer",
      );
      pushQuestionVersion(
        questionNo || "1",
        {
          rawResponse: data.result,
          quickAnswer: parsed.quickAnswer,
          explanationBody: parsed.body,
          selectedMethodIndexes: splitMethodBlocks(parsed.body).methods.map((_, index) => index),
          representativeMethodIndex: splitMethodBlocks(parsed.body).methods.length > 0 ? 0 : null,
          workflowStep:
            splitMethodBlocks(parsed.body).methods.length > 1
              ? "select_explanation"
              : "confirm_quick_answer",
          modelLabel: data.model || (generationMode === "final" ? "gemini-final" : "gemini-test"),
          sourceType: "single",
          runId: singleRunId,
        },
        true,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "알 수 없는 오류가 발생했습니다.";
      setErrorMessage(message);
      setDiagramAidRecommendation(null);
    } finally {
      setIsGenerating(false);
    }
  };

  const recomputePendingFromMarkers = (
    markers: DividerMarker[],
    overrideTargetQuestionNo?: number,
  ) => {
    if (!imageRef.current) return;
    const sorted = [...markers].sort((a, b) => a.yRatio - b.yRatio);
    if (sorted.length < 1) {
      setPendingLineCrop(null);
      return;
    }
    const imageWidth = imageRef.current.width;
    const imageHeight = imageRef.current.height;
    const targetQuestionNo = overrideTargetQuestionNo ?? queuedProblems.length + 1;
    const pairStartIndex = targetQuestionNo - 1;
    if (pairStartIndex > sorted.length - 1) {
      setPendingLineCrop(null);
      setErrorMessage(
        "현재 구분선으로는 다음 문제 구간이 없습니다. 새 구분선을 추가하거나 구분선을 조정해 주세요.",
      );
      return;
    }

    const start = sorted[pairStartIndex];
    const end = sorted[pairStartIndex + 1];
    const top = start.yRatio * imageHeight;
    const problemPaddingRatio = 0.03; // 객관식 선택지까지 포함되도록 약간 아래 여백
    const bottomRaw = end ? end.yRatio * imageHeight : imageHeight;
    const bottom = Math.min(imageHeight, bottomRaw + imageHeight * problemPaddingRatio);
    const segmentBounds = getSegmentBounds(start.segmentIndex);
    const lineCrop: PixelCrop = {
      unit: "px",
      x: Math.max(0, segmentBounds.left * imageWidth),
      y: Math.max(0, Math.min(top, imageHeight - 1)),
      width: Math.max(10, (segmentBounds.right - segmentBounds.left) * imageWidth),
      height: Math.max(10, Math.min(imageHeight, bottom) - Math.max(0, top)),
    };
    setPendingLineCrop(lineCrop);
    setQuestionNo(String(pairStartIndex + 1));
  };

  const addDividerMarkerAt = (x: number, y: number) => {
    if (!imageRef.current) return;
    const imageWidth = imageRef.current.width;
    const imageHeight = imageRef.current.height;
    const rawXRatio = Math.max(0, Math.min(1, x / imageWidth));
    const segmentIndex = getSegmentIndexByXRatio(rawXRatio);
    const segmentBounds = getSegmentBounds(segmentIndex);
    const markerXRatio = Math.max(
      segmentBounds.left,
      Math.min(segmentBounds.right, rawXRatio),
    );
    const markerYRatio = Math.max(0, Math.min(1, y / imageHeight));
    const currentPageNo = isPdfSource ? pdfPageNo : 1;
    const currentPageLabels = dividerMarkers.map((item) => item.labelNo);
    let nextLabelNo = 1;
    if (currentPageLabels.length === 0) {
      const usedInOtherPages = Object.entries(pageDrafts)
        .filter(([pageKey]) => Number.parseInt(pageKey, 10) !== currentPageNo)
        .flatMap(([, draft]) => draft.dividerMarkers.map((item) => item.labelNo));
      const maxLabel = usedInOtherPages.length > 0 ? Math.max(...usedInOtherPages) : 0;
      nextLabelNo = maxLabel + 1;
    } else {
      const usedLabelNos = new Set(currentPageLabels);
      nextLabelNo = Math.min(...currentPageLabels);
      while (usedLabelNos.has(nextLabelNo)) {
        nextLabelNo += 1;
      }
    }
    const marker: DividerMarker = {
      id: `divider-${dividerIdRef.current++}`,
      labelNo: nextLabelNo,
      xRatio: markerXRatio,
      yRatio: markerYRatio,
      segmentIndex,
    };
    const next = [...dividerMarkers, marker];
    setDividerMarkers(next);
    recomputePendingFromMarkers(next);
    setSuccessMessage(
      `${marker.labelNo}번 구분선을 추가했습니다. ${queuedProblems.length + 1}번 문제가 생성 준비되었습니다.`,
    );
    setErrorMessage("");
  };

  const addVerticalGuideAt = (x: number) => {
    if (!imageRef.current) return;
    const imageWidth = imageRef.current.width;
    const ratio = Math.max(0.05, Math.min(0.95, x / imageWidth));
    const currentPageNo = isPdfSource ? pdfPageNo : 1;
    const currentPageLabels = verticalGuides.map((item) => item.labelNo);
    let nextLabelNo = 1;
    if (currentPageLabels.length === 0) {
      const usedInOtherPages = Object.entries(pageDrafts)
        .filter(([pageKey]) => Number.parseInt(pageKey, 10) !== currentPageNo)
        .flatMap(([, draft]) => draft.verticalGuides.map((item) => item.labelNo));
      const maxLabel = usedInOtherPages.length > 0 ? Math.max(...usedInOtherPages) : 0;
      nextLabelNo = maxLabel + 1;
    } else {
      const usedLabelNos = new Set(currentPageLabels);
      nextLabelNo = Math.min(...currentPageLabels);
      while (usedLabelNos.has(nextLabelNo)) {
        nextLabelNo += 1;
      }
    }
    const guide: VerticalGuide = {
      id: `vguide-${verticalGuideIdRef.current++}`,
      labelNo: nextLabelNo,
      xRatio: ratio,
    };
    const nextGuides = [...verticalGuides, guide].sort((a, b) => a.xRatio - b.xRatio);
    setVerticalGuides(nextGuides);
    setDividerMarkers((prev) => clampMarkersToSegments(prev, nextGuides));
    setSuccessMessage("세로 가이드를 추가했습니다.");
  };

  const updateDividerMarkerByDrag = (
    drag: DividerDragState,
    mouseX: number,
    mouseY: number,
  ) => {
    if (!imageRef.current) return;
    const imageWidth = imageRef.current.width;
    const imageHeight = imageRef.current.height;
    const dx = mouseX - drag.startMouseX;
    const dy = mouseY - drag.startMouseY;

    const next = dividerMarkers.map((marker) => {
      if (marker.id !== drag.id) return marker;
      const nextXRatio = Math.max(0, Math.min(1, drag.startXRatio + dx / imageWidth));
      const nextYRatio = Math.max(0, Math.min(1, drag.startYRatio + dy / imageHeight));
      const bounds = getSegmentBounds(marker.segmentIndex);
      const minX = Math.min(bounds.right, bounds.left + 0.002);
      const maxX = Math.max(bounds.left, bounds.right - 0.002);
      const clampedX = Math.max(minX, Math.min(maxX, nextXRatio));
      return { ...marker, xRatio: clampedX, yRatio: nextYRatio };
    });

    setDividerMarkers(next);
    recomputePendingFromMarkers(next);
  };

  useEffect(() => {
    if (!dividerDragState) return;

    const handleMouseMove = (event: MouseEvent) => {
      if (!dividerOverlayRef.current) return;
      const rect = dividerOverlayRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      dividerDragMovedRef.current = true;
      updateDividerMarkerByDrag(dividerDragState, x, y);
    };

    const handleMouseUp = () => {
      if (dividerDragMovedRef.current) {
        suppressOverlayClickRef.current = true;
      }
      dividerDragMovedRef.current = false;
      setDividerDragState(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dividerDragState]);

  const removeDividerMarker = (id: string) => {
    const next = dividerMarkers.filter((marker) => marker.id !== id);
    setDividerMarkers(next);
    recomputePendingFromMarkers(next);
    setSuccessMessage("구분선을 삭제했습니다.");
  };

  const removeVerticalGuide = (id: string) => {
    const next = verticalGuides.filter((guide) => guide.id !== id);
    setVerticalGuides(next);
    setDividerMarkers((prev) => clampMarkersToSegments(prev, next));
    setSuccessMessage("세로 가이드를 삭제했습니다.");
  };

  const startVerticalGuideDrag = (guideId: string, startClientX: number, startXRatio: number) => {
    if (!dividerOverlayRef.current) return;
    const rect = dividerOverlayRef.current.getBoundingClientRect();
    const startMouseX = startClientX - rect.left;

    const handleMouseMove = (event: MouseEvent) => {
      if (!dividerOverlayRef.current || !imageRef.current) return;
      const moveRect = dividerOverlayRef.current.getBoundingClientRect();
      const x = event.clientX - moveRect.left;
      const dx = (x - startMouseX) / imageRef.current.width;
      const nextRatio = Math.max(0.05, Math.min(0.95, startXRatio + dx));
      setVerticalGuides((prev) => {
        const nextGuides = prev
          .map((guide) => (guide.id === guideId ? { ...guide, xRatio: nextRatio } : guide))
          .sort((a, b) => a.xRatio - b.xRatio);
        setDividerMarkers((prevMarkers) => clampMarkersToSegments(prevMarkers, nextGuides));
        return nextGuides;
      });
    };

    const handleMouseUp = () => {
      suppressOverlayClickRef.current = true;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  const addDiagramBox = (activeCrop: PixelCrop) => {
    if (!imageRef.current) return;
    const mimeType = sourceFile?.type || "image/png";
    const imageBase64 = cropImageToBase64(imageRef.current, activeCrop, mimeType);
    const currentPageNo = isPdfSource ? pdfPageNo : 1;
    const currentPageLabels = pendingDiagramBoxes.map((item) => item.labelNo);
    let nextLabelNo = 1;
    if (currentPageLabels.length === 0) {
      const usedInOtherPages = Object.entries(pageDrafts)
        .filter(([pageKey]) => Number.parseInt(pageKey, 10) !== currentPageNo)
        .flatMap(([, draft]) => draft.diagramBoxes.map((item) => item.labelNo));
      const maxLabel = usedInOtherPages.length > 0 ? Math.max(...usedInOtherPages) : 0;
      nextLabelNo = maxLabel + 1;
    } else {
      const usedLabelNos = new Set(currentPageLabels);
      nextLabelNo = Math.min(...currentPageLabels);
      while (usedLabelNos.has(nextLabelNo)) {
        nextLabelNo += 1;
      }
    }
    setPendingDiagramBoxes((prev) => [
      ...prev,
      {
        id: `diagram-${diagramIdRef.current++}`,
        labelNo: nextLabelNo,
        crop: activeCrop,
        imageBase64,
        mimeType,
      },
    ]);
    setCrop(undefined);
    setCompletedCrop(undefined);
    setSuccessMessage("문제 박스를 추가했습니다.");
    setErrorMessage("");
  };

  const removePendingDiagramBox = (id: string) => {
    setPendingDiagramBoxes((prev) => prev.filter((box) => box.id !== id));
  };

  useEffect(() => {
    if (!diagramDragState) return;

    const handleMouseMove = (event: MouseEvent) => {
      if (!dividerOverlayRef.current || !imageRef.current) return;
      const rect = dividerOverlayRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const dx = x - diagramDragState.startMouseX;
      const dy = y - diagramDragState.startMouseY;
      const imageWidth = imageRef.current.width;
      const imageHeight = imageRef.current.height;

      setPendingDiagramBoxes((prev) =>
        prev.map((box) => {
          if (box.id !== diagramDragState.id) return box;
          const nextX = Math.max(0, Math.min(imageWidth - box.crop.width, diagramDragState.startX + dx));
          const nextY = Math.max(0, Math.min(imageHeight - box.crop.height, diagramDragState.startY + dy));
          return {
            ...box,
            crop: {
              ...box.crop,
              x: nextX,
              y: nextY,
            },
          };
        }),
      );
    };

    const handleMouseUp = () => {
      setDiagramDragState(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [diagramDragState]);

  useEffect(() => {
    if (!diagramResizeState) return;

    const handleMouseMove = (event: MouseEvent) => {
      if (!dividerOverlayRef.current || !imageRef.current) return;
      const rect = dividerOverlayRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const dx = x - diagramResizeState.startMouseX;
      const dy = y - diagramResizeState.startMouseY;
      const imageWidth = imageRef.current.width;
      const imageHeight = imageRef.current.height;
      const minSize = 20;

      setPendingDiagramBoxes((prev) =>
        prev.map((box) => {
          if (box.id !== diagramResizeState.id) return box;
          const maxWidth = Math.max(minSize, imageWidth - diagramResizeState.startX);
          const maxHeight = Math.max(minSize, imageHeight - diagramResizeState.startY);
          const nextWidth = Math.max(
            minSize,
            Math.min(maxWidth, diagramResizeState.startWidth + dx),
          );
          const nextHeight = Math.max(
            minSize,
            Math.min(maxHeight, diagramResizeState.startHeight + dy),
          );
          return {
            ...box,
            crop: {
              ...box.crop,
              width: nextWidth,
              height: nextHeight,
            },
          };
        }),
      );
    };

    const handleMouseUp = () => {
      setDiagramResizeState(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [diagramResizeState]);

  const clearPendingSelection = () => {
    setPendingLineCrop(null);
    setPendingDiagramBoxes([]);
  };

  const savePageDraft = (pageNumber: number) => {
    if (!isPdfSource) return;
    setPageDrafts((prev) => ({
      ...prev,
      [pageNumber]: {
        dividerMarkers: dividerMarkers.map((item) => ({ ...item })),
        verticalGuides: verticalGuides.map((item) => ({ ...item })),
        diagramBoxes: pendingDiagramBoxes.map((item) => ({
          ...item,
          crop: { ...item.crop },
        })),
      },
    }));
  };

  const restorePageDraft = (pageNumber: number) => {
    const draft = pageDrafts[pageNumber];
    if (!draft) {
      setDividerMarkers([]);
      setVerticalGuides([]);
      setPendingDiagramBoxes([]);
      setPendingLineCrop(null);
      return;
    }
    setDividerMarkers(draft.dividerMarkers.map((item) => ({ ...item })));
    setVerticalGuides(draft.verticalGuides.map((item) => ({ ...item })));
    setPendingDiagramBoxes(
      draft.diagramBoxes.map((item) => ({
        ...item,
        crop: { ...item.crop },
      })),
    );
    recomputePendingFromMarkers(draft.dividerMarkers);
  };

  const savePendingAsQueuedProblem = () => {
    if (!imageRef.current) {
      setErrorMessage("이미지를 먼저 불러와 주세요.");
      return;
    }
    if (pendingDiagramBoxes.length < 1) {
      setErrorMessage("현재 페이지에 최소 1개 이상의 문제 박스를 추가해 주세요.");
      return;
    }

    const mimeType = sourceFile?.type || "image/png";
    const pageNumber = isPdfSource ? pdfPageNo : 1;
    if (isPdfSource && !requiredPageNumbers.includes(pageNumber)) {
      setErrorMessage(
        "현재 페이지는 참고 전용(빠른정답/해설참고)으로 제외된 페이지입니다. 이 페이지는 문제 저장 대상이 아닙니다.",
      );
      return;
    }
    const pageLabel = isPdfSource ? `PDF ${pageNumber}p` : "이미지";
    const baseCountWithoutCurrentPage = Object.entries(savedPageWorks).reduce(
      (sum, [pageKey, items]) => {
        const key = Number.parseInt(pageKey, 10);
        if (key === pageNumber) return sum;
        return sum + items.length;
      },
      0,
    );

    const pageProblems: QueuedProblem[] = pendingDiagramBoxes.map((box, idx) => {
      const crop = box.crop;
      const imageBase64 = cropImageToBase64(imageRef.current!, crop, mimeType);
      return {
        id: `${Date.now()}-${pageNumber}-${idx}`,
        questionNo: String(baseCountWithoutCurrentPage + idx + 1),
        pageLabel,
        imageBase64,
        imageMimeType: mimeType,
        diagramImages: [],
        crop,
        diagramCrops: [],
      };
    });

    const nextPageWorks: Record<number, QueuedProblem[]> = {
      ...savedPageWorks,
      [pageNumber]: pageProblems,
    };
    const mergedProblems = Object.entries(nextPageWorks)
      .map(([page, items]) => ({ page: Number.parseInt(page, 10), items }))
      .sort((a, b) => a.page - b.page)
      .flatMap((entry) => entry.items);

    const renumbered = mergedProblems.map((item, idx) => ({
      ...item,
      questionNo: String(idx + 1),
    }));

    setSavedPageWorks(nextPageWorks);
    savePageDraft(pageNumber);
    setQueuedProblems(renumbered);
    setSavedPageNumbers((prev) =>
      prev.includes(pageNumber) ? prev : [...prev, pageNumber].sort((a, b) => a - b),
    );
    const nextSavedList = savedPageNumbers.includes(pageNumber)
      ? savedPageNumbers
      : [...savedPageNumbers, pageNumber];
    const nextCompletedRequired = requiredPageNumbers.filter((pageNo) =>
      nextSavedList.includes(pageNo),
    ).length;
    const allPagesDone =
      totalPageCount > 0 &&
      requiredPageNumbers.length > 0 &&
      nextCompletedRequired >= requiredPageNumbers.length;
    if (allPagesDone) {
      setCurrentStep(3);
      setSuccessMessage(
        `${pageLabel} 작업 저장 완료. 모든 페이지 작업이 끝나서 해설 제작 단계로 이동했습니다.`,
      );
      return;
    }
    setSuccessMessage(
      `${pageLabel} 문제 박스를 저장했습니다. (${nextCompletedRequired}/${requiredPageNumbers.length} 필수 페이지 완료, 제외 ${excludedPageNumbers.length})`,
    );
  };

  const goToStep3IfReady = () => {
    if (!hasImage) return;
    if (!canEnterStep3) {
      setErrorMessage(
        `필수 페이지 저장 후 해설 제작으로 이동할 수 있습니다. (${completedRequiredPageCount}/${requiredPageNumbers.length} 완료, 제외 ${excludedPageNumbers.length}페이지)`,
      );
      return;
    }
    setCurrentStep(3);
  };

  const toggleExcludeCurrentPage = () => {
    if (!isPdfSource) return;
    const pageNo = pdfPageNo;
    setExcludedPageNumbers((prev) =>
      prev.includes(pageNo) ? prev.filter((item) => item !== pageNo) : [...prev, pageNo].sort((a, b) => a - b),
    );
    setSavedPageNumbers((prev) => prev.filter((item) => item !== pageNo));
    setSavedPageWorks((prev) => {
      const next = { ...prev };
      delete next[pageNo];
      return next;
    });
    setSuccessMessage(
      excludedPageNumbers.includes(pageNo)
        ? `${pageNo}페이지 제외를 해제했습니다.`
        : `${pageNo}페이지를 제외 처리했습니다.`,
    );
    setErrorMessage("");
  };

  const removeQueuedProblem = (id: string) => {
    setQueuedProblems((prev) => prev.filter((item) => item.id !== id));
  };

  const runBatchGeneration = async () => {
    if (queuedProblems.length === 0) {
      setErrorMessage("먼저 문제 박스를 하나 이상 추가해 주세요.");
      return;
    }
    if (!imageRef.current) {
      setErrorMessage("이미지 로딩이 완료된 뒤 순차 생성을 다시 시도해 주세요.");
      return;
    }

    try {
      setIsBatchGenerating(true);
      setErrorMessage("");
      setSuccessMessage("");
      setBatchResults([]);
      setQualityWarnings([]);
      const batchRunId = `batch-${Date.now()}`;

      const results: BatchResult[] = [];
      const successfulExplanations: Array<{
        questionNo: string;
        quickAnswer: string;
        body: string;
      }> = [];

      for (const item of queuedProblems) {
        const precheck = runExtractionPrecheckForDisplayedCrop(item.crop, imageRef.current);
        if (!precheck.ok) {
          results.push({
            questionNo: item.questionNo,
            quickAnswer: "-",
            status: "error",
            message: `생성 중단(사전검증 실패): ${precheck.messages.join(" / ")}`,
          });
          continue;
        }

        const visionPrecheckRes = await fetch("/api/precheck-extraction", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: item.imageBase64,
            imageMimeType: item.imageMimeType,
            crop: item.crop,
          }),
        });
        const visionPrecheckData = (await visionPrecheckRes.json()) as VisionPrecheckResponse;
        if (!visionPrecheckRes.ok) {
          if (visionPrecheckRes.status >= 500) {
            const detailText = visionPrecheckData.details?.join(" | ");
            setQualityWarnings((prev) => [
              ...prev,
              `${item.questionNo}번: 비전 사전검증 서버 오류(${visionPrecheckRes.status})로 검증을 건너뛰고 생성을 계속합니다.${
                detailText ? ` 상세: ${detailText}` : ""
              }`,
            ]);
          } else {
            results.push({
              questionNo: item.questionNo,
              quickAnswer: "-",
              status: "error",
              message:
                visionPrecheckData.error || "생성 중단(비전 사전검증 API 호출 실패)",
            });
            continue;
          }
        }
        if (visionPrecheckRes.ok && !visionPrecheckData.pass) {
          const reasons = [
            ...(visionPrecheckData.reasons || []),
            ...(visionPrecheckData.missing || []),
          ]
            .filter(Boolean)
            .join(" / ");
          results.push({
            questionNo: item.questionNo,
            quickAnswer: "-",
            status: "error",
            message: `생성 중단(비전 사전검증 ${visionPrecheckData.score}점): ${
              reasons || "핵심 정보 누락 가능성"
            }`,
          });
          continue;
        }

        setQuestionNo(item.questionNo);
        const response = await fetch("/api/generate-explanation", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            questionText: useTextInput ? questionText : "",
            imageBase64: item.imageBase64,
            imageMimeType: item.imageMimeType,
            diagramImages: item.diagramImages,
            generationMode,
            includeDiagramExplanation,
            explanationSelectionMode,
            showAllMethods,
            quickAnswerPageHint:
              quickAnswerPages.length > 0
                ? `빠른정답 참고 페이지: ${quickAnswerPages.join(", ")}`
                : "",
            explanationReferenceHint:
              explanationRefPages.length > 0
                ? `해설 참고 페이지: ${explanationRefPages.join(", ")}`
                : "",
            crop: item.crop,
          }),
        });

        if (!response.ok) {
          const data = (await response.json()) as { error?: string; details?: string[] };
          const detailText =
            data.details && data.details.length > 0
              ? ` / 상세: ${data.details.join(" | ")}`
              : "";
          results.push({
            questionNo: item.questionNo,
            quickAnswer: "-",
            status: "error",
            message: (data.error || "해설 생성 실패") + detailText,
          });
          continue;
        }

        const data = (await response.json()) as {
          result: string;
          qualityWarnings?: string[];
          diagramAidRecommendation?: DiagramAidRecommendation;
          model?: string;
        };
        const rawResult = data.result;
        const parsed = parseExplanation(rawResult);
        setRawResponse(rawResult);
        setQualityWarnings(data.qualityWarnings ?? []);
        setDiagramAidRecommendation(data.diagramAidRecommendation ?? null);
        setQuickAnswer(parsed.quickAnswer);
        setExplanationBody(parsed.body);
        setSelectedMethodIndexes(
          splitMethodBlocks(parsed.body).methods.map((_, index) => index),
        );
        setRepresentativeMethodIndex(
          splitMethodBlocks(parsed.body).methods.length > 0 ? 0 : null,
        );
        setMethodSelectionPolicy("all");
        setWorkflowStep(
          splitMethodBlocks(parsed.body).methods.length > 1
            ? "select_explanation"
            : "confirm_quick_answer",
        );
        pushQuestionVersion(
          item.questionNo,
          {
            rawResponse: rawResult,
            quickAnswer: parsed.quickAnswer,
            explanationBody: parsed.body,
            selectedMethodIndexes: splitMethodBlocks(parsed.body).methods.map((_, index) => index),
            representativeMethodIndex: splitMethodBlocks(parsed.body).methods.length > 0 ? 0 : null,
            workflowStep:
              splitMethodBlocks(parsed.body).methods.length > 1
                ? "select_explanation"
                : "confirm_quick_answer",
            modelLabel: data.model || (generationMode === "final" ? "gemini-final" : "gemini-test"),
            sourceType: "batch",
            runId: batchRunId,
          },
          true,
        );
        results.push({
          questionNo: item.questionNo,
          quickAnswer: parsed.quickAnswer,
          status: "success",
          message:
              `${data.qualityWarnings && data.qualityWarnings.length > 0 ? `생성 완료(경고 ${data.qualityWarnings.length}건)` : "생성 완료"}${
                data.diagramAidRecommendation?.recommended
                  ? ` / 도형보조 추천(score ${data.diagramAidRecommendation.score})`
                  : ""
              }`,
        });
        successfulExplanations.push({
          questionNo: item.questionNo,
          quickAnswer: parsed.quickAnswer,
          body: parsed.body,
        });
      }

      if (successfulExplanations.length > 0) {
        try {
          const combinedBody = successfulExplanations
            .map(
              (entry) =>
                `[문항 ${entry.questionNo}]\n[정답] ${entry.quickAnswer}\n${entry.body}`,
            )
            .join("\n\n");
          const formData = new FormData();
          formData.append("examName", selectedExam || "직접업로드");
          formData.append(
            "questionNo",
            `통합_${successfulExplanations[0]?.questionNo || "1"}-${
              successfulExplanations[successfulExplanations.length - 1]?.questionNo || "1"
            }`,
          );
          formData.append("quickAnswer", "문항별 정답은 해설 본문의 [정답]을 확인하세요.");
          formData.append("explanationBody", combinedBody);
          formData.append(
            "rawResponse",
            successfulExplanations
              .map((entry) => `[문항 ${entry.questionNo}]\n${entry.body}`)
              .join("\n\n"),
          );
          const saveRes = await fetch("/api/save-result", {
            method: "POST",
            body: formData,
          });
          if (!saveRes.ok) {
            const data = (await saveRes.json()) as { error?: string };
            throw new Error(data.error || "통합 DOCX 저장 실패");
          }
          const savedMessage = (await saveRes.json()) as { message?: string };
          setSuccessMessage(savedMessage.message || "통합 DOCX 저장을 완료했습니다.");
          setWorkflowStep("generate_sheet");
        } catch (e) {
          const message =
            e instanceof Error
              ? e.message
              : "자동 생성은 성공했지만 통합 DOCX 저장에 실패했습니다.";
          setErrorMessage(message);
        }
      }

      setBatchResults(results);
      if (successfulExplanations.length === 0) {
        setSuccessMessage("문제 박스 순차 자동 해설 생성을 완료했습니다.");
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "자동 해설 생성 중 오류가 발생했습니다.";
      setErrorMessage(message);
    } finally {
      setIsBatchGenerating(false);
    }
  };

  const movePdfPage = async (delta: number) => {
    if (!originalFile || !isPdfSource) return;
    const nextPage = pdfPageNo + delta;
    if (nextPage < 1 || nextPage > pdfPageCount) return;
    try {
      setErrorMessage("");
      setSuccessMessage("");
      savePageDraft(pdfPageNo);
      await renderPdfPageToImage(originalFile, nextPage);
      restorePageDraft(nextPage);
      setCrop(undefined);
      setCompletedCrop(undefined);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "PDF 페이지 이동 중 오류가 발생했습니다.";
      setErrorMessage(message);
    }
  };

  const buildPdfBlob = async () => {
    if (!resultRef.current) {
      throw new Error("PDF로 저장할 해설 영역을 찾지 못했습니다.");
    }

    const renderAtScale = async (scale: number) =>
      html2canvas(resultRef.current as HTMLDivElement, {
        scale,
        useCORS: true,
        backgroundColor: "#ffffff",
      });

    let canvas: HTMLCanvasElement;
    try {
      canvas = await renderAtScale(1.6);
    } catch {
      // 고해상도에서 실패하면 메모리 부담을 줄여 재시도
      canvas = await renderAtScale(1.0);
    }

    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF("p", "mm", "a4");
    const pageWidth = 210;
    const pageHeight = 297;
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    let heightLeft = imgHeight;
    let position = 0;

    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;

    while (heightLeft > 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }

    return pdf.output("blob");
  };

  const handleSavePdf = async () => {
    try {
      setIsSavingPdf(true);
      setErrorMessage("");
      setSuccessMessage("");
      const blob = await buildPdfBlob();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selectedExam || "highroad_math"}_문항${questionNo}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 PDF 저장 오류";
      setErrorMessage(`PDF 저장 중 오류가 발생했습니다: ${message}`);
    } finally {
      setIsSavingPdf(false);
    }
  };

  const handleSaveCurrentDocx = async () => {
    if (!hasGeneratedResult) {
      setErrorMessage("먼저 문제 풀이/해설 생성을 완료해 주세요.");
      return;
    }
    try {
      setErrorMessage("");
      setSuccessMessage("");
      const activeVersion = selectedQuestionVersion;
      const finalQuickAnswer = activeVersion?.quickAnswer || quickAnswer || "-";
      const finalBody = activeVersion?.explanationBody || selectedExplanationBody;
      const formData = new FormData();
      formData.append("examName", selectedExam || "직접업로드");
      formData.append("questionNo", questionNo || "1");
      formData.append("quickAnswer", finalQuickAnswer);
      formData.append("explanationBody", `[정답] ${finalQuickAnswer}\n${finalBody}`);
      const saveRes = await fetch("/api/save-result", {
        method: "POST",
        body: formData,
      });
      if (!saveRes.ok) {
        const data = (await saveRes.json()) as { error?: string };
        throw new Error(data.error || "DOCX 저장 실패");
      }
      const savedMessage = (await saveRes.json()) as { message?: string };
      setSuccessMessage(savedMessage.message || "해설지 DOCX 생성이 완료되었습니다.");
      setWorkflowStep("generate_sheet");
    } catch (error) {
      const message = error instanceof Error ? error.message : "DOCX 저장 중 오류가 발생했습니다.";
      setErrorMessage(message);
    }
  };

  return (
    <main className="min-h-screen bg-slate-100 p-4 md:p-6">
      <div className="mx-auto grid max-w-[1600px] grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
          <h1 className="text-xl font-bold text-slate-900">
            하이로드 수학 해설지 제작기
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            필요한 단계만 보이도록 단순화된 제작 흐름
          </p>

          <div className="mt-5 space-y-4">
            <div className="grid grid-cols-3 gap-2 text-xs">
              <button
                onClick={() => {
                  setCurrentStep(1);
                  void loadExamFiles();
                }}
                className={`rounded border px-2 py-2 font-semibold ${
                  currentStep === 1
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-500"
                }`}
              >
                1) 시험지 선택
              </button>
              <button
                onClick={() => hasImage && setCurrentStep(2)}
                disabled={!hasImage}
                className={`rounded border px-2 py-2 font-semibold ${
                  currentStep === 2
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-500"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                2) 영역 지정
              </button>
              <button
                onClick={goToStep3IfReady}
                disabled={!hasImage}
                className={`rounded border px-2 py-2 font-semibold ${
                  currentStep === 3
                    ? "border-blue-500 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-500"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                3) 해설 제작
              </button>
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              {currentStep === 1 &&
                "현재 단계: 시험지 선택. 목록에서 파일을 선택하거나 직접 업로드하세요."}
              {currentStep === 2 &&
                "현재 단계: 수동 영역 지정(메인). 문제 박스를 지정한 뒤 현재 페이지 작업 저장을 누르세요."}
              {currentStep === 3 &&
                "현재 단계: 해설 제작. 문제풀이 → 해설선택 → 빠른정답 → 해설지 생성 순서로 진행하세요."}
            </div>

            {currentStep === 1 && (
              <>
            <div>
              <label className="mb-2 block text-sm font-semibold text-slate-800">
                1) 시험지 목록 불러오기
              </label>
              <button
                onClick={loadExamFiles}
                disabled={isLoadingExams}
                className="w-full rounded-md border border-slate-300 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isLoadingExams ? "불러오는 중..." : "시험지 폴더 새로고침"}
              </button>
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold text-slate-800">
                2) 원하는 시험지 클릭 선택
              </label>
              <div className="h-44 overflow-y-auto rounded-md border border-slate-200">
                {examFiles.length === 0 ? (
                  <p className="p-3 text-sm text-slate-500">
                    시험지 폴더에 파일이 없습니다. `시험지` 또는 `exams` 폴더에 png/jpg/pdf 파일을 넣어주세요.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-200">
                    {examFiles.map((file) => (
                      <li key={file}>
                        <button
                          onClick={() => loadExamImage(file)}
                          disabled={isLoadingSelectedFile}
                          className={`w-full px-3 py-2 text-left text-sm ${
                            selectedExam === file
                              ? "bg-blue-50 font-semibold text-blue-700"
                              : "hover:bg-slate-50"
                          } disabled:cursor-not-allowed disabled:opacity-70`}
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate">{file}</span>
                            <span className="rounded border border-slate-300 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
                              {(() => {
                                const kind = getExamSourceKind(file);
                                if (kind === "hml") return "HML";
                                if (kind === "hwp") return "HWP/HWPX";
                                if (kind === "pdf") return "PDF";
                                return "IMG";
                              })()}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-semibold text-slate-800">
                (선택) 직접 이미지 업로드
              </label>
              <input
                type="file"
                accept="image/*,.pdf,application/pdf"
                onChange={handleImageUpload}
                className="block w-full rounded-md border border-slate-300 p-2 text-sm"
              />
            </div>

            <div className="rounded-md border border-violet-200 bg-violet-50 p-3">
              <p className="text-sm font-semibold text-violet-900">
                이미지 영역 지정 기반 처리(고정)
              </p>
              <p className="mt-1 text-xs text-violet-800">
                현재는 PDF/이미지에서 문제 영역을 지정해 해설을 생성합니다.
                <br />
                HML/HWP/HWPX는 직접 편집하지 않고, PDF 또는 이미지로 변환 후 진행해 주세요.
              </p>
            </div>
              </>
            )}

            {currentStep >= 2 && hasImage && (
              <div>
                <label className="mb-2 block text-sm font-semibold text-slate-800">
                  3) 문제 영역 지정(크롭)
                </label>
                {isLoadingSelectedFile && (
                  <p className="mb-2 text-xs text-slate-500">시험지 로딩 중...</p>
                )}
                {isPdfSource && (
                  <div className="mb-2 rounded-md bg-slate-50 p-2 text-sm">
                    <div className="flex items-center justify-between">
                    <button
                      onClick={() => void movePdfPage(-1)}
                      disabled={pdfPageNo <= 1}
                      className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                    >
                      이전 페이지
                    </button>
                    <span>
                      PDF 페이지 {pdfPageNo} / {pdfPageCount}
                    </span>
                    <button
                      onClick={() => void movePdfPage(1)}
                      disabled={pdfPageNo >= pdfPageCount}
                      className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                    >
                      다음 페이지
                    </button>
                    </div>
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={toggleExcludeCurrentPage}
                        className={`rounded border px-2 py-1 text-xs font-semibold ${
                          isCurrentPageExcluded
                            ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                            : "border-rose-300 bg-rose-50 text-rose-700"
                        }`}
                      >
                        {isCurrentPageExcluded ? "이 페이지 제외 해제" : "이 페이지 제외"}
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                      <div>
                        <p className="text-xs font-semibold text-slate-700">빠른정답 페이지 지정(선택)</p>
                        <label className="mt-1 flex items-center gap-2 text-[11px] text-slate-600">
                          <input
                            type="checkbox"
                            checked={noQuickAnswerPage}
                            onChange={(event) => setNoQuickAnswerPage(event.target.checked)}
                          />
                          빠른정답 없음
                        </label>
                        <input
                          type="text"
                          value={quickAnswerPageSelection}
                          onChange={(event) => setQuickAnswerPageSelection(event.target.value)}
                          placeholder="예: 9 또는 9-10"
                          disabled={noQuickAnswerPage}
                          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                        />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-slate-700">해설참고 페이지 지정(선택)</p>
                        <label className="mt-1 flex items-center gap-2 text-[11px] text-slate-600">
                          <input
                            type="checkbox"
                            checked={noExplanationRefPage}
                            onChange={(event) => setNoExplanationRefPage(event.target.checked)}
                          />
                          해설참고 없음
                        </label>
                        <input
                          type="text"
                          value={explanationRefPageSelection}
                          onChange={(event) => setExplanationRefPageSelection(event.target.value)}
                          placeholder="예: 11-14"
                          disabled={noExplanationRefPage}
                          className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                        />
                      </div>
                    </div>
                    {referenceOnlyPages.length > 0 && (
                      <p className="mt-2 rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">
                        참고 전용 페이지(필수 작업 제외): {referenceOnlyPages.join(", ")}
                      </p>
                    )}
                    {referenceOnlyPages.length === 0 && (
                      <p className="mt-2 rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">
                        빠른정답/해설 참고 페이지가 없어도 정상입니다. 빈칸으로 두면 일반 모드로 진행됩니다.
                      </p>
                    )}
                    {(invalidQuickAnswerSelection || invalidExplanationRefSelection) && (
                      <p className="mt-2 rounded bg-rose-50 px-2 py-1 text-xs text-rose-700">
                        페이지 지정값을 확인해 주세요. 현재 PDF 페이지 범위와 맞지 않아 반영되지 않았습니다.
                      </p>
                    )}
                  </div>
                )}
                <div className="max-h-[420px] overflow-auto rounded-md border border-slate-200 p-2">
                  <div className="relative inline-block">
                    <ReactCrop
                      disabled={linePlacementMode}
                      className="bg-white"
                      crop={crop}
                      onChange={(nextCrop) => {
                        if (linePlacementMode) return;
                        setCrop(nextCrop);
                      }}
                      onComplete={(nextCrop) => {
                        if (linePlacementMode) {
                          setCompletedCrop(nextCrop);
                          return;
                        }
                        const normalized = normalizeCrop(nextCrop);
                        if (!normalized) return;
                        addDiagramBox(normalized);
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        ref={imageRef}
                        src={sourceImage}
                        alt="문제 이미지"
                        className="max-w-full"
                        style={{ cursor: HIGH_VISIBILITY_CROSSHAIR_CURSOR }}
                        onLoad={(event) => {
                          setRenderImageSize({
                            width: event.currentTarget.clientWidth,
                            height: event.currentTarget.clientHeight,
                          });
                          setCrop(undefined);
                          setCompletedCrop(undefined);
                        }}
                      />
                    </ReactCrop>

                    <div
                      ref={dividerOverlayRef}
                      className="absolute inset-0"
                      style={{
                        pointerEvents: linePlacementMode ? "auto" : "none",
                        cursor: HIGH_VISIBILITY_CROSSHAIR_CURSOR,
                      }}
                      onClick={(event) => {
                        if (!linePlacementMode) return;
                        if (dividerDragState) return;
                        if (suppressOverlayClickRef.current) {
                          suppressOverlayClickRef.current = false;
                          return;
                        }
                        if (!imageRef.current) return;
                        const imageRect = imageRef.current.getBoundingClientRect();
                        const x = Math.max(
                          0,
                          Math.min(imageRect.width, event.clientX - imageRect.left),
                        );
                        const y = Math.max(
                          0,
                          Math.min(imageRect.height, event.clientY - imageRect.top),
                        );
                        if (verticalGuideMode) {
                          addVerticalGuideAt(x);
                          return;
                        }
                        addDividerMarkerAt(x, y);
                      }}
                    >
                      {sortedVerticalGuides.map((guide, index) => (
                        <div key={guide.id}>
                          <div
                            className="absolute top-0 bottom-0 border-l-2 border-orange-500/90"
                            style={{
                              left: `${guide.xRatio * renderImageSize.width}px`,
                            }}
                          />
                          <div
                            className="absolute top-0 bottom-0 -translate-x-1/2"
                            style={{
                              left: `${guide.xRatio * renderImageSize.width}px`,
                              width: "16px",
                              cursor: "ew-resize",
                            }}
                            onMouseDown={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                              if (!dividerOverlayRef.current) return;
                              suppressOverlayClickRef.current = true;
                              startVerticalGuideDrag(guide.id, event.clientX, guide.xRatio);
                            }}
                          />
                          <button
                            type="button"
                            onMouseDown={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              removeVerticalGuide(guide.id);
                            }}
                            className="absolute z-10 h-5 w-5 -translate-x-1/2 rounded-full bg-orange-500 text-[11px] font-bold text-white"
                            style={{
                              left: `${guide.xRatio * renderImageSize.width}px`,
                              top: "6px",
                            }}
                          >
                            ×
                          </button>
                          <span
                            className="absolute rounded bg-orange-500 px-1.5 py-0.5 text-[10px] font-bold text-white"
                            style={{
                              left: `${guide.xRatio * renderImageSize.width + 8}px`,
                              top: "6px",
                            }}
                          >
                            V{guide.labelNo ?? index + 1}
                          </span>
                        </div>
                      ))}
                      {sortedDividerMarkers.map((marker) => (
                        <div key={marker.id}>
                          {(() => {
                            const bounds = getSegmentBounds(marker.segmentIndex);
                            const left = bounds.left * renderImageSize.width;
                            const width = (bounds.right - bounds.left) * renderImageSize.width;
                            return (
                              <div
                                className="absolute border-t border-indigo-500/70"
                                style={{
                                  left: `${left}px`,
                                  top: `${marker.yRatio * renderImageSize.height}px`,
                                  width: `${Math.max(10, width)}px`,
                                }}
                              />
                            );
                          })()}
                          <div
                            className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-indigo-500 bg-indigo-400 text-[10px] font-bold text-white"
                            style={{
                              left: `${marker.xRatio * renderImageSize.width}px`,
                              top: `${marker.yRatio * renderImageSize.height}px`,
                              cursor: "grab",
                            }}
                            onMouseDown={(event) => {
                              event.stopPropagation();
                              event.preventDefault();
                              dividerDragMovedRef.current = false;
                              const rect = dividerOverlayRef.current?.getBoundingClientRect();
                              if (!rect) return;
                              setDividerDragState({
                                id: marker.id,
                                startMouseX: event.clientX - rect.left,
                                startMouseY: event.clientY - rect.top,
                                startXRatio: marker.xRatio,
                                startYRatio: marker.yRatio,
                              });
                            }}
                            onClick={(event) => event.stopPropagation()}
                          >
                            {marker.labelNo}
                          </div>
                          {linePlacementMode && (
                            <button
                              type="button"
                              onMouseDown={(event) => {
                                event.stopPropagation();
                                event.preventDefault();
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                                removeDividerMarker(marker.id);
                              }}
                              className="absolute z-10 h-5 w-5 -translate-y-full rounded-full bg-red-500 text-[11px] font-bold text-white"
                              style={{
                                left: `${marker.xRatio * renderImageSize.width + 10}px`,
                                top: `${marker.yRatio * renderImageSize.height}px`,
                              }}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <div
                      className="pointer-events-none absolute inset-0"
                      style={{
                        zIndex: 40,
                      }}
                    >
                      {pendingDiagramBoxes.map((box, idx) => (
                        <div
                          key={box.id}
                          className="absolute border-2 border-dashed border-emerald-500"
                          style={{
                            left: `${box.crop.x}px`,
                            top: `${box.crop.y}px`,
                            width: `${box.crop.width}px`,
                            height: `${box.crop.height}px`,
                            cursor: "move",
                            pointerEvents: linePlacementMode ? "none" : "auto",
                            zIndex: 41,
                          }}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (!dividerOverlayRef.current) return;
                            if (diagramResizeState) return;
                            const rect = dividerOverlayRef.current.getBoundingClientRect();
                            setDiagramDragState({
                              id: box.id,
                              startMouseX: event.clientX - rect.left,
                              startMouseY: event.clientY - rect.top,
                              startX: box.crop.x,
                              startY: box.crop.y,
                            });
                          }}
                        >
                          <span className="absolute -top-5 left-0 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                            문제 {box.labelNo ?? idx + 1}
                          </span>
                          <button
                            type="button"
                            aria-label={`문제 ${box.labelNo ?? idx + 1} 크기 조절`}
                            className="absolute -bottom-2 -right-2 h-4 w-4 rounded bg-emerald-600 text-white"
                            style={{ cursor: "nwse-resize" }}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (!dividerOverlayRef.current) return;
                              const rect = dividerOverlayRef.current.getBoundingClientRect();
                              setDiagramResizeState({
                                id: box.id,
                                startMouseX: event.clientX - rect.left,
                                startMouseY: event.clientY - rect.top,
                                startWidth: box.crop.width,
                                startHeight: box.crop.height,
                                startX: box.crop.x,
                                startY: box.crop.y,
                              });
                            }}
                          >
                            ↘
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <p className="mt-2 rounded bg-blue-50 p-2 text-xs text-blue-700">
                  문제 박스 모드: 드래그해서 문제 영역을 추가하고, 저장 후 자동 보조 실행에 포함하세요.
                </p>
                <p className="mt-2 rounded bg-emerald-50 p-2 text-xs text-emerald-700">
                  박스를 드래그해 추가하면 자동 저장 목록에 포함됩니다. 추가된 박스는 드래그 이동, 우하단
                  핸들로 크기 조절할 수 있습니다.
                </p>
                <button
                  onClick={savePendingAsQueuedProblem}
                  disabled={pendingDiagramBoxes.length < 1}
                  className="mt-2 w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white"
                >
                  현재 페이지 작업 저장
                </button>
                {pendingDiagramBoxes.length > 0 && (
                  <p className="mt-2 rounded bg-slate-50 p-2 text-xs text-slate-600">
                    설정됨: 문제 박스 {pendingDiagramBoxes.length}개
                  </p>
                )}
                {pendingDiagramBoxes.length === 0 && (
                  <p className="mt-1 text-xs text-rose-600">
                    문제 박스를 먼저 추가해 주세요.
                  </p>
                )}
                <div className="mt-1 rounded-md bg-slate-50 px-2 py-2 text-xs text-slate-600">
                  문제 박스 {pendingDiagramBoxes.length}개 / 저장상태{" "}
                  {isCurrentPageExcluded ? "제외됨" : isCurrentPageSaved ? "저장됨" : "미저장"} / 필수{" "}
                  {completedRequiredPageCount}/{requiredPageNumbers.length}
                </div>
                {pendingDiagramBoxes.length > 0 && (
                  <div className="mt-2 rounded-md border border-slate-200 p-2">
                    <p className="text-xs font-semibold text-slate-700">
                      문제 박스 목록 ({pendingDiagramBoxes.length})
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {pendingDiagramBoxes.map((box, idx) => (
                        <button
                          key={box.id}
                          onClick={() => removePendingDiagramBox(box.id)}
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                        >
                          문제 {box.labelNo ?? idx + 1} 삭제
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => setCurrentStep(1)}
                    className="w-1/2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    이전: 시험지 선택
                  </button>
                  <button
                    onClick={goToStep3IfReady}
                    className="w-1/2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
                  >
                    다음: 해설 제작
                  </button>
                </div>
              </div>
            )}

            {currentStep >= 3 && (
              <>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-sm font-semibold text-slate-800">현재 문항: {questionNo || "-"}</p>
              {questionNoOptions.length > 0 && (
                <div className="mt-2">
                  <label className="text-[11px] font-semibold text-slate-600">문항 선택</label>
                  <select
                    value={questionNo}
                    onChange={(event) => setQuestionNo(event.target.value)}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  >
                    {questionNoOptions.map((item) => (
                      <option key={`q-opt-${item}`} value={item}>
                        {item}번
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <p className="mt-1 text-xs text-slate-600">
                단계: 영역지정 → 문제풀이 → 해설 선택 → 빠른정답 → 해설지 생성
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                <span className="rounded bg-blue-100 px-2 py-0.5 text-blue-800">1. 문제풀이</span>
                <span
                  className={`rounded px-2 py-0.5 ${
                    workflowStep !== "solve" ? "bg-blue-100 text-blue-800" : "bg-slate-200 text-slate-600"
                  }`}
                >
                  2. 해설 선택
                </span>
                <span
                  className={`rounded px-2 py-0.5 ${
                    workflowStep === "confirm_quick_answer" || workflowStep === "generate_sheet"
                      ? "bg-blue-100 text-blue-800"
                      : "bg-slate-200 text-slate-600"
                  }`}
                >
                  3. 빠른정답
                </span>
                <span
                  className={`rounded px-2 py-0.5 ${
                    workflowStep === "generate_sheet"
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-slate-200 text-slate-600"
                  }`}
                >
                  4. 해설지 생성
                </span>
              </div>
            </div>

            {methodBlocks.methods.length > 0 && (
              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <p className="font-semibold text-slate-800">
                  풀이 방법 채택 (PDF 반영)
                </p>
                <div className="mt-2 rounded-md border border-slate-200 bg-white p-2 text-xs">
                  <p className="font-semibold text-slate-700">해설 반영 방식</p>
                  <label className="mt-1 flex items-center gap-2">
                    <input
                      type="radio"
                      name="methodSelectionPolicy"
                      checked={methodSelectionPolicy === "all"}
                      onChange={() => setMethodSelectionPolicy("all")}
                    />
                    해설이 여러 개면 모두 넣기
                  </label>
                  <label className="mt-1 flex items-center gap-2">
                    <input
                      type="radio"
                      name="methodSelectionPolicy"
                      checked={methodSelectionPolicy === "selected"}
                      onChange={() => setMethodSelectionPolicy("selected")}
                    />
                    선택한 해설만 넣기
                  </label>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  채택한 방법만 우측 미리보기와 PDF/작업완료 저장에 반영됩니다.
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  대표풀이(별표)로 지정한 방법은 항상 가장 위에 배치됩니다.
                </p>
                <div className="mt-2 space-y-1">
                  {methodBlocks.methods.map((method, index) => (
                    <div
                      key={`pick-method-${index}`}
                      className="flex items-start justify-between gap-2 rounded bg-slate-50 px-2 py-1"
                    >
                      <label className="flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={selectedMethodIndexes.includes(index)}
                          onChange={(event) => {
                            if (event.target.checked) {
                              setSelectedMethodIndexes((prev) =>
                                [...prev, index].sort((a, b) => a - b),
                              );
                              if (representativeMethodIndex === null) {
                                setRepresentativeMethodIndex(index);
                              }
                            } else {
                              setSelectedMethodIndexes((prev) =>
                                prev.filter((item) => item !== index),
                              );
                              if (representativeMethodIndex === index) {
                                setRepresentativeMethodIndex(null);
                              }
                            }
                          }}
                        />
                        <span className="line-clamp-2">{method.split("\n")[0]}</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          if (!selectedMethodIndexes.includes(index)) {
                            setSelectedMethodIndexes((prev) =>
                              [...prev, index].sort((a, b) => a - b),
                            );
                          }
                          setRepresentativeMethodIndex(index);
                        }}
                        className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${
                          representativeMethodIndex === index
                            ? "bg-amber-100 text-amber-800"
                            : "border border-slate-300 bg-white text-slate-600"
                        }`}
                      >
                        {representativeMethodIndex === index ? "★ 대표풀이" : "☆ 대표로"}
                      </button>
                    </div>
                  ))}
                </div>
                {methodBlocks.methods.length > 1 && workflowStep === "select_explanation" && (
                  <button
                    type="button"
                    onClick={() => setWorkflowStep("confirm_quick_answer")}
                    className="mt-3 w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white"
                  >
                    해설 선택 확정
                  </button>
                )}
              </div>
            )}

            <button
              onClick={handleGenerateExplanation}
              disabled={!canGenerate}
              className="w-full rounded-md bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isGenerating ? "해설 생성 중..." : "수동 지정 해설 생성 (한 문제)"}
            </button>

            {hasGeneratedResult && (
              <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3">
                <p className="text-xs font-semibold text-indigo-900">
                  문항 버전 관리
                  {selectedQuestionVersion
                    ? ` (현재 ${selectedQuestionVersion.label}, ${selectedQuestionVersion.modelLabel})`
                    : ""}
                </p>
                {currentQuestionVersionState?.versions?.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {currentQuestionVersionState.versions.map((version) => (
                      <button
                        key={version.id}
                        type="button"
                        onClick={() => selectQuestionVersion(questionNo || "1", version.id)}
                        className={`rounded border px-2 py-1 text-[11px] ${
                          currentQuestionVersionState.selectedVersionId === version.id
                            ? "border-indigo-600 bg-indigo-600 text-white"
                            : "border-indigo-300 bg-white text-indigo-900"
                        }`}
                        title={`${new Date(version.createdAt).toLocaleString()} / ${version.modelLabel} / ${version.sourceType}:${version.runId}`}
                      >
                        {version.label} · {version.sourceType === "manual" ? "수동" : version.sourceType}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        if (!rawResponse.trim()) return;
                        pushQuestionVersion(
                          questionNo || "1",
                          {
                            rawResponse,
                            quickAnswer,
                            explanationBody,
                            selectedMethodIndexes,
                            representativeMethodIndex,
                            workflowStep,
                            modelLabel: "manual",
                            sourceType: "manual",
                            runId: `manual-${Date.now()}`,
                          },
                          true,
                        );
                        setSuccessMessage("현재 편집 상태를 새 버전으로 저장했습니다.");
                      }}
                      className="rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] text-emerald-800"
                    >
                      + 현재 상태를 새 버전으로 저장
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-indigo-800">
                    아직 버전이 없습니다. 해설 생성을 실행하면 v1부터 기록됩니다.
                  </p>
                )}
              </div>
            )}

            {hasGeneratedResult && (
              <div className="rounded-md border border-slate-200 p-3">
                <p className="text-xs font-semibold text-slate-700">빠른정답 확정</p>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    value={quickAnswer}
                    onChange={(event) => setQuickAnswer(event.target.value)}
                    className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setWorkflowStep("generate_sheet")}
                    className="shrink-0 rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white"
                  >
                    빠른정답 확정
                  </button>
                </div>
              </div>
            )}

            <details className="rounded-md border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                보조 실행 설정 (자동생성/텍스트 입력/상세 옵션)
              </summary>
              <div className="mt-3 space-y-3">
                <div className="rounded-md border border-slate-200 p-3">
                  <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-800">
                    <input
                      type="checkbox"
                      checked={useTextInput}
                      onChange={(event) => setUseTextInput(event.target.checked)}
                    />
                    문제 텍스트 직접 입력
                  </label>
                  {useTextInput && (
                    <textarea
                      value={questionText}
                      onChange={(event) => setQuestionText(event.target.value)}
                      placeholder="선택 사항: 텍스트를 넣으면 해설 정확도에 도움됩니다."
                      className="mt-2 min-h-[130px] w-full rounded-md border border-slate-300 p-3 text-sm leading-6"
                    />
                  )}
                </div>

                <div className="rounded-md border border-slate-200 p-3 text-sm">
                  <p className="font-semibold text-slate-800">해설 옵션</p>
                  <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2">
                    <p className="text-xs font-semibold text-slate-700">생성 모드</p>
                    <label className="mt-1 flex items-center gap-2 text-xs">
                      <input
                        type="radio"
                        name="generationMode"
                        checked={generationMode === "test"}
                        onChange={() => setGenerationMode("test")}
                      />
                      테스트 모드(속도/비용 우선)
                    </label>
                    <label className="mt-1 flex items-center gap-2 text-xs">
                      <input
                        type="radio"
                        name="generationMode"
                        checked={generationMode === "final"}
                        onChange={() => setGenerationMode("final")}
                      />
                      최종 모드(품질 우선)
                    </label>
                  </div>
                  <label className="mt-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={includeDiagramExplanation}
                      onChange={(event) => setIncludeDiagramExplanation(event.target.checked)}
                    />
                    그림/도형 해설 포함
                  </label>
                </div>

                <div className="rounded-md border border-slate-200 p-3">
                  <p className="text-sm font-semibold text-slate-800">
                    자동 보조 해설 대기열 ({queuedProblems.length})
                  </p>
                  {queuedProblems.length === 0 ? (
                    <p className="mt-2 text-xs text-slate-500">
                      문제 박스를 저장하면 자동 생성에 추가됩니다.
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-1 text-xs text-slate-700">
                      {queuedProblems.map((item, index) => (
                        <li key={item.id} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1">
                          <span>
                            {index + 1}. {item.questionNo}번 ({item.pageLabel})
                          </span>
                          <button
                            onClick={() => removeQueuedProblem(item.id)}
                            className="rounded border border-slate-300 px-2 py-0.5 text-[11px]"
                          >
                            삭제
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    onClick={runBatchGeneration}
                    disabled={queuedProblems.length === 0 || isBatchGenerating}
                    className="mt-3 w-full rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {isBatchGenerating
                      ? "보조 자동 해설 생성 중..."
                      : "문제 박스 순서대로 자동 보조 실행"}
                  </button>
                </div>
              </div>
            </details>
              </>
            )}

            {errorMessage && (
              <p className="rounded-md bg-rose-50 p-3 text-sm text-rose-700">
                {errorMessage}
              </p>
            )}

            {successMessage && (
              <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">
                {successMessage}
              </p>
            )}

            {batchResults.length > 0 && (
              <div className="rounded-md border border-slate-200 p-3 text-xs">
                <p className="font-semibold text-slate-800">자동 보조 실행 결과</p>
                <ul className="mt-2 space-y-1">
                  {batchResults.map((result, index) => (
                    <li key={`${result.questionNo}-${index}`} className="rounded bg-slate-50 px-2 py-1">
                      {result.questionNo}번 - {result.status === "success" ? "성공" : "실패"} / 빠른정답:{" "}
                      {result.quickAnswer} / {result.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {qualityWarnings.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                <p className="font-semibold">품질 경고(자동 보정 이력)</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {qualityWarnings.map((item, idx) => (
                    <li key={`quality-warning-${idx}`}>{item}</li>
                  ))}
                </ul>
              </div>
            )}

            {diagramAidRecommendation && (
              <div
                className={`rounded-md border p-3 text-xs ${
                  diagramAidRecommendation.recommended
                    ? "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-900"
                    : "border-slate-300 bg-slate-50 text-slate-700"
                }`}
              >
                <p className="font-semibold">
                  도형 보조 이미지 추천:{" "}
                  {diagramAidRecommendation.recommended ? "권장" : "불필요(텍스트 우선)"}
                  {"  "}
                  <span className="font-normal">(score {diagramAidRecommendation.score})</span>
                </p>
                <p className="mt-1">
                  근거: {diagramAidRecommendation.reasons.join(", ")}
                </p>
                {diagramAidRecommendation.recommended && (
                  <button
                    type="button"
                    onClick={() =>
                      setSuccessMessage(
                        "도형 보조 이미지가 추천됩니다. 필요한 문항에만 바나나(이미지 생성)를 선택 적용하세요.",
                      )
                    }
                    className="mt-2 rounded border border-fuchsia-400 bg-white px-2 py-1 text-[11px] font-semibold text-fuchsia-900"
                  >
                    바나나 선택 적용 안내 보기
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-slate-300 bg-[#fdfcf8] p-4 shadow-sm md:p-6">
          {currentStep !== 3 ? (
            <div className="rounded-md border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
              <p className="text-sm">3단계(해설 제작)에서 해설 미리보기가 표시됩니다.</p>
              <p className="mt-2 text-xs">
                지금은 좌측에서 시험지 선택과 문제 영역 지정을 먼저 진행하세요.
              </p>
            </div>
          ) : (
            <>
              {!hasGeneratedResult && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-5 text-center text-amber-900">
                  <p className="text-sm font-semibold">아직 해설이 생성되지 않았습니다.</p>
                  <p className="mt-1 text-xs">
                    좌측에서 `수동 지정 해설 생성 (한 문제)`을 먼저 실행하고, 필요 시 자동 보조 실행을 사용해 주세요.
                  </p>
                </div>
              )}

              {hasGeneratedResult && (
                <div ref={resultRef} className="mx-auto max-w-[794px] bg-white p-6 md:p-10">
                  <header className="mb-6 border-b border-slate-300 pb-4">
                    <h2 className="text-center text-2xl font-bold text-slate-900">
                      하이로드 수학 모의고사 해설
                    </h2>
                    <p className="mt-2 text-center text-sm text-slate-500">
                      시험지: {selectedExam || "선택 안됨"} | 문항: {questionNo || "-"}
                    </p>
                  </header>

                  <div className="mb-6 rounded-md border-2 border-blue-400 bg-blue-50 p-4">
                    <p className="text-sm font-semibold text-blue-900">[빠른 정답 체크]</p>
                    <p className="mt-2 text-2xl font-bold tracking-wide text-blue-950">
                      {quickAnswer}
                    </p>
                  </div>

                  <article className="newspaper-columns text-[15px] leading-7 text-slate-800">
                    {renderMethodBlocks(selectedExplanationBody)}
                  </article>
                </div>
              )}
            </>
          )}

          {currentStep === 3 && hasGeneratedResult && (
            <div className="mt-4 grid grid-cols-1 gap-3">
              <button
                onClick={handleSaveCurrentDocx}
                disabled={workflowStep !== "generate_sheet"}
                className="w-full rounded-md bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                해설지 생성 (DOCX)
              </button>
              <button
                onClick={handleSavePdf}
                disabled={isSavingPdf || workflowStep !== "generate_sheet"}
                className="w-full rounded-md bg-emerald-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isSavingPdf ? "PDF 생성 중..." : "PDF로 저장하기"}
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
