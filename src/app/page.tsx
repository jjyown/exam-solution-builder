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

const DEFAULT_BODY = `해설 생성 버튼을 누르면 이 영역에 결과가 표시됩니다.

[출제 의도 및 개념] : 문제의 핵심 개념을 짧게 정리
[조건 분석] : 주어진 조건을 어떻게 해석하는지 설명
[단계별 풀이] : Step 1, Step 2 형식으로 풀이를 전개
[최종 정답 확인] : 따라서 정답은 ~이다`;

function extractSection(text: string, header: string, nextHeaders: string[]) {
  const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedNext = nextHeaders
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const pattern = new RegExp(
    `\\[${escapedHeader}\\]\\s*:?\\s*([\\s\\S]*?)(?=\\n\\s*\\[(?:${escapedNext})\\]|$)`,
    "i",
  );
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
    const fallbackOption = fullText.match(/[①②③④⑤]|(?<!\d)[1-5](?!\d)/);
    if (fallbackOption) return toDigit(fallbackOption[0]);
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

  const body = [
    `[출제 의도 및 개념] : ${concept || "내용이 제공되지 않았습니다."}`,
    `[조건 분석] : ${condition || "내용이 제공되지 않았습니다."}`,
    `[단계별 풀이] : ${steps || "내용이 제공되지 않았습니다."}`,
    `[최종 정답 확인] : ${finalAnswer || "내용이 제공되지 않았습니다."}`,
  ].join("\n\n");

  return {
    quickAnswer: normalizeQuickAnswer(quickAnswer || "-", normalized),
    body,
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

export default function Home() {
  const resultRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dividerOverlayRef = useRef<HTMLDivElement | null>(null);
  const dividerIdRef = useRef(1);
  const verticalGuideIdRef = useRef(1);
  const diagramIdRef = useRef(1);
  const suppressOverlayClickRef = useRef(false);
  const dividerDragMovedRef = useRef(false);
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
  const [explanationBody, setExplanationBody] = useState(DEFAULT_BODY);
  const [rawResponse, setRawResponse] = useState("");
  const [isLoadingExams, setIsLoadingExams] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSavingPdf, setIsSavingPdf] = useState(false);
  const [isSavingToFolder, setIsSavingToFolder] = useState(false);
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
  const [linePlacementMode, setLinePlacementMode] = useState(true);
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
  const requiredPageNumbers = useMemo(
    () =>
      Array.from({ length: totalPageCount }, (_, idx) => idx + 1).filter(
        (pageNo) => !excludedPageNumbers.includes(pageNo),
      ),
    [totalPageCount, excludedPageNumbers],
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
        selectedMethodIndexes,
        representativeMethodIndex,
      ),
    [explanationBody, selectedMethodIndexes, representativeMethodIndex],
  );

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
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    (pdfjs.GlobalWorkerOptions as { workerSrc: string }).workerSrc =
      `https://unpkg.com/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({
      data: arrayBuffer,
    } as unknown as Parameters<typeof pdfjs.getDocument>[0]).promise;
    const safePageNo = Math.max(1, Math.min(pageNo, pdf.numPages));
    const page = await pdf.getPage(safePageNo);
    const viewport = page.getViewport({ scale: 2 });
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
    setQueuedProblems([]);
    setSavedPageNumbers([]);
    setExcludedPageNumbers([]);
    setSavedPageWorks({});
    setPageDrafts({});
    setQuestionNo("1");
    setBatchResults([]);

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
    const refresh = () => {
      void loadExamFiles();
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [currentStep, loadExamFiles]);

  const loadExamImage = async (fileName: string) => {
    try {
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

  const handleGenerateExplanation = async () => {
    if (!sourceFile) {
      setErrorMessage("문제 이미지를 먼저 업로드해 주세요.");
      return;
    }
    if (!imageRef.current) {
      setErrorMessage("이미지 로딩이 완료된 뒤 다시 시도해 주세요.");
      return;
    }
    try {
      setIsGenerating(true);
      setErrorMessage("");
      setSuccessMessage("");

      const mimeType = sourceFile.type || "image/png";
      const selectedProblemCrop = pendingLineCrop ?? (completedCrop ? normalizeCrop(completedCrop) : null);
      const imageBase64 = selectedProblemCrop
        ? cropImageToBase64(imageRef.current, selectedProblemCrop, mimeType)
        : await toBase64(sourceFile);
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

      const data = (await response.json()) as { result: string };
      const parsed = parseExplanation(data.result);
      setRawResponse(data.result);
      setQuickAnswer(parsed.quickAnswer);
      setExplanationBody(parsed.body);
      setSelectedMethodIndexes(
        splitMethodBlocks(parsed.body).methods.map((_, index) => index),
      );
      setRepresentativeMethodIndex(
        splitMethodBlocks(parsed.body).methods.length > 0 ? 0 : null,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "알 수 없는 오류가 발생했습니다.";
      setErrorMessage(message);
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
    setSuccessMessage("그림 전용 박스를 추가했습니다.");
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
    if (sortedDividerMarkers.length < 1) {
      setErrorMessage("현재 페이지에 최소 1개 이상의 구분선을 추가해 주세요.");
      return;
    }

    const imageWidth = imageRef.current.width;
    const imageHeight = imageRef.current.height;
    const mimeType = sourceFile?.type || "image/png";
    const pageNumber = isPdfSource ? pdfPageNo : 1;
    const pageLabel = isPdfSource ? `PDF ${pageNumber}p` : "이미지";
    const baseCountWithoutCurrentPage = Object.entries(savedPageWorks).reduce(
      (sum, [pageKey, items]) => {
        const key = Number.parseInt(pageKey, 10);
        if (key === pageNumber) return sum;
        return sum + items.length;
      },
      0,
    );

    const pageProblems: QueuedProblem[] = sortedDividerMarkers.map((start, idx) => {
      const end = sortedDividerMarkers[idx + 1];
      const top = start.yRatio * imageHeight;
      const problemPaddingRatio = 0.03; // 객관식 선택지 인식 보정(아래 여백 포함)
      const bottomRaw = end ? end.yRatio * imageHeight : imageHeight;
      const bottom = Math.min(imageHeight, bottomRaw + imageHeight * problemPaddingRatio);
      const segmentBounds = getSegmentBounds(start.segmentIndex);
      const crop: PixelCrop = {
        unit: "px",
        x: Math.max(0, segmentBounds.left * imageWidth),
        y: Math.max(0, Math.min(top, imageHeight - 1)),
        width: Math.max(10, (segmentBounds.right - segmentBounds.left) * imageWidth),
        height: Math.max(10, Math.min(imageHeight, bottom) - Math.max(0, top)),
      };
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
    if (sortedDividerMarkers.length > 0) {
      recomputePendingFromMarkers(sortedDividerMarkers);
    }

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
      `${pageLabel} 작업을 저장했습니다. (${nextCompletedRequired}/${requiredPageNumbers.length} 필수 페이지 완료, 제외 ${excludedPageNumbers.length})`,
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
      setErrorMessage("먼저 영역 박스를 하나 이상 추가해 주세요.");
      return;
    }

    try {
      setIsBatchGenerating(true);
      setErrorMessage("");
      setSuccessMessage("");
      setBatchResults([]);

      const results: BatchResult[] = [];

      for (const item of queuedProblems) {
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

        const data = (await response.json()) as { result: string };
        const rawResult = data.result;
        const parsed = parseExplanation(rawResult);
        setRawResponse(rawResult);
        setQuickAnswer(parsed.quickAnswer);
        setExplanationBody(parsed.body);
        setSelectedMethodIndexes(
          splitMethodBlocks(parsed.body).methods.map((_, index) => index),
        );
        setRepresentativeMethodIndex(
          splitMethodBlocks(parsed.body).methods.length > 0 ? 0 : null,
        );
        results.push({
          questionNo: item.questionNo,
          quickAnswer: parsed.quickAnswer,
          status: "success",
          message: "생성 완료",
        });

        // 자동으로 TXT를 작업 완료 폴더에 저장합니다. (PDF는 자동 생성 시 비용/메모리 부담이 커서 제외)
        try {
          const formData = new FormData();
          formData.append("examName", selectedExam || "직접업로드");
          formData.append("questionNo", item.questionNo || "1");
          formData.append("quickAnswer", parsed.quickAnswer);
          formData.append("explanationBody", parsed.body);
          formData.append("rawResponse", rawResult);
          const saveRes = await fetch("/api/save-result", {
            method: "POST",
            body: formData,
          });
          if (!saveRes.ok) {
            const data = (await saveRes.json()) as { error?: string };
            throw new Error(data.error || "작업 완료 TXT 저장 실패");
          }
        } catch (e) {
          // TXT 저장이 실패해도 전체 생성은 계속 진행
          console.warn("TXT 저장 실패:", e);
        }
      }

      setBatchResults(results);
      setSuccessMessage("영역 박스 순차 자동 해설 생성을 완료했습니다.");
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

  const handleSaveToCompletedFolder = async () => {
    try {
      setIsSavingToFolder(true);
      setErrorMessage("");
      setSuccessMessage("");
      const formData = new FormData();
      formData.append("examName", selectedExam || "직접업로드");
      formData.append("questionNo", questionNo || "1");
      formData.append("quickAnswer", quickAnswer);
      formData.append("explanationBody", selectedExplanationBody);
      formData.append("rawResponse", rawResponse);

      const response = await fetch("/api/save-result", {
        method: "POST",
        body: formData,
      });
      const data = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error || "작업 완료 폴더 저장에 실패했습니다.");
      }
      const nextNo = getNextQuestionNo(questionNo);
      setQuestionNo(nextNo);
      setQuestionText("");
      setQuickAnswer("-");
      setExplanationBody(DEFAULT_BODY);
      setSelectedMethodIndexes([]);
      setRepresentativeMethodIndex(null);
      setRawResponse("");
      setSuccessMessage(
        `${data.message || "작업 완료 폴더에 저장했습니다."} 다음 문항 번호는 ${nextNo}번입니다.`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "저장 중 오류가 발생했습니다.";
      setErrorMessage(message);
    } finally {
      setIsSavingToFolder(false);
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
            단계별 진행: 시험지 선택 → 영역 지정 → 해설 제작
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
                          className={`w-full px-3 py-2 text-left text-sm ${
                            selectedExam === file
                              ? "bg-blue-50 font-semibold text-blue-700"
                              : "hover:bg-slate-50"
                          }`}
                        >
                          {file}
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
                  </div>
                )}
                <div className="max-h-[420px] overflow-auto rounded-md border border-slate-200 p-2">
                  <div className="relative inline-block">
                    <ReactCrop
                      disabled={linePlacementMode}
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
                        onLoad={(event) => {
                          setRenderImageSize({
                            width: event.currentTarget.width,
                            height: event.currentTarget.height,
                          });
                          setCrop(undefined);
                          setCompletedCrop(undefined);
                        }}
                      />
                    </ReactCrop>

                    <div
                      ref={dividerOverlayRef}
                      className="absolute inset-0"
                      style={{ pointerEvents: linePlacementMode ? "auto" : "none" }}
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
                            그림 {box.labelNo ?? idx + 1}
                          </span>
                          <button
                            type="button"
                            aria-label={`그림 ${box.labelNo ?? idx + 1} 크기 조절`}
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
                  {linePlacementMode
                    ? verticalGuideMode
                      ? "세로선 모드: 클릭하면 세로 가이드가 추가되고, 마커는 이를 넘지 못합니다."
                      : "구분선 모드: 페이지 클릭으로 시작점 마커 추가, 마커 드래그 이동, X 버튼 삭제"
                    : "그림 박스 모드: 드래그해서 그림/도형 영역을 선택"}
                </p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <button
                    onClick={() => {
                      setLinePlacementMode(true);
                      setVerticalGuideMode(false);
                    }}
                    className={`rounded-md px-3 py-2 text-sm font-semibold ${
                      linePlacementMode && !verticalGuideMode
                        ? "bg-blue-600 text-white"
                        : "border border-slate-300 bg-white text-slate-700"
                    }`}
                  >
                    구분선 모드
                  </button>
                  <button
                    onClick={() => {
                      setLinePlacementMode(true);
                      setVerticalGuideMode(true);
                    }}
                    className={`rounded-md px-3 py-2 text-sm font-semibold ${
                      linePlacementMode && verticalGuideMode
                        ? "bg-orange-600 text-white"
                        : "border border-slate-300 bg-white text-slate-700"
                    }`}
                  >
                    세로선 모드
                  </button>
                  <button
                    onClick={() => {
                      setLinePlacementMode(false);
                      setVerticalGuideMode(false);
                    }}
                    className={`rounded-md px-3 py-2 text-sm font-semibold ${
                      !linePlacementMode
                        ? "bg-emerald-600 text-white"
                        : "border border-slate-300 bg-white text-slate-700"
                    }`}
                  >
                    그림 박스 모드
                  </button>
                </div>
                {!linePlacementMode && (
                  <p className="mt-2 rounded bg-emerald-50 p-2 text-xs text-emerald-700">
                    그림 박스 모드에서는 드래그를 마치면 박스가 자동으로 추가됩니다. 추가된 박스는
                    드래그로 이동, 우하단 핸들로 크기 조절할 수 있습니다.
                  </p>
                )}
                <button
                  onClick={savePendingAsQueuedProblem}
                  disabled={sortedDividerMarkers.length < 1}
                  className="mt-2 w-full rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white"
                >
                  현재 페이지 작업 저장
                </button>
                {(pendingLineCrop || pendingDiagramBoxes.length > 0) && (
                  <p className="mt-2 rounded bg-slate-50 p-2 text-xs text-slate-600">
                    설정됨: {pendingLineCrop ? "문제 구분선 " : ""}
                    {pendingDiagramBoxes.length > 0
                      ? `+ 그림 박스 ${pendingDiagramBoxes.length}개`
                      : ""}
                  </p>
                )}
                {!pendingLineCrop && (
                  <p className="mt-1 text-xs text-rose-600">
                    구분선을 먼저 추가해 주세요. 마지막 문제는 마지막 구분선 아래 영역으로 자동 처리됩니다.
                  </p>
                )}
                <p className="mt-1 text-xs text-slate-500">
                  현재 구분선 수: {dividerMarkers.length}개
                </p>
                <p className="mt-1 text-xs text-indigo-700">
                  현재 페이지 구분선 번호:{" "}
                  {currentPageDividerRange
                    ? `${currentPageDividerRange.start} ~ ${currentPageDividerRange.end}`
                    : `없음 (다음 시작 번호: ${nextDividerLabelNo})`}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  현재 세로선 수: {verticalGuides.length}개
                </p>
                <p className="mt-1 text-xs text-blue-700">
                  페이지 저장 상태: {isCurrentPageExcluded ? "제외됨" : isCurrentPageSaved ? "저장됨" : "미저장"} /
                  필수 {completedRequiredPageCount}/{requiredPageNumbers.length} (제외{" "}
                  {excludedPageNumbers.length})
                </p>
                {pendingDiagramBoxes.length > 0 && (
                  <div className="mt-2 rounded-md border border-slate-200 p-2">
                    <p className="text-xs font-semibold text-slate-700">
                      그림 박스 목록 ({pendingDiagramBoxes.length})
                    </p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {pendingDiagramBoxes.map((box, idx) => (
                        <button
                          key={box.id}
                          onClick={() => removePendingDiagramBox(box.id)}
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                        >
                          그림 {box.labelNo ?? idx + 1} 삭제
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {dividerMarkers.length > 0 && (
                  <div className="mt-2 rounded-md border border-slate-200 p-2">
                    <p className="text-xs font-semibold text-slate-700">구분선 삭제</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {sortedDividerMarkers.map((marker) => (
                        <button
                          key={`remove-divider-${marker.id}`}
                          onClick={() => removeDividerMarker(marker.id)}
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px]"
                        >
                          {marker.labelNo}번 선 삭제
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
            <div>
              <label className="mb-2 block text-sm font-semibold text-slate-800">
                4) 문제 번호 (자동)
              </label>
              <input
                value={questionNo}
                readOnly
                placeholder="구분선 2개 이상 지정 시 자동 설정"
                className="w-full rounded-md border border-slate-300 bg-slate-50 p-2 text-sm"
              />
            </div>

            <div className="rounded-md border border-slate-200 p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-800">
                <input
                  type="checkbox"
                  checked={useTextInput}
                  onChange={(event) => setUseTextInput(event.target.checked)}
                />
                문제 텍스트 직접 입력 사용(선택)
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
                  테스트 모드(Flash 우선, 비용 절약)
                </label>
                <label className="mt-1 flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="generationMode"
                    checked={generationMode === "final"}
                    onChange={() => setGenerationMode("final")}
                  />
                  최종 모드(Pro 우선, 품질 우선)
                </label>
              </div>
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeDiagramExplanation}
                  onChange={(event) =>
                    setIncludeDiagramExplanation(event.target.checked)
                  }
                />
                그림/도형/그래프 해설 포함
              </label>
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={showAllMethods}
                  onChange={(event) => setShowAllMethods(event.target.checked)}
                />
                풀이가 여러 개면 모두 제시
              </label>
              <div className="mt-2">
                <p className="text-xs font-semibold text-slate-700">
                  여러 해설 관점 처리
                </p>
                <label className="mt-1 flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="explanationSelectionMode"
                    checked={explanationSelectionMode === "all"}
                    onChange={() => setExplanationSelectionMode("all")}
                  />
                  괜찮은 해설이 여러 개면 모두 수록
                </label>
                <label className="mt-1 flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="explanationSelectionMode"
                    checked={explanationSelectionMode === "core"}
                    onChange={() => setExplanationSelectionMode("core")}
                  />
                  핵심 해설만 엄선해서 수록
                </label>
              </div>
            </div>

            {methodBlocks.methods.length > 0 && (
              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <p className="font-semibold text-slate-800">
                  풀이 방법 채택 (PDF 반영)
                </p>
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
              </div>
            )}

            <button
              onClick={handleGenerateExplanation}
              disabled={!canGenerate}
              className="w-full rounded-md bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isGenerating ? "해설 생성 중..." : "해설 생성 (한 문제)"}
            </button>

            <div className="rounded-md border border-slate-200 p-3">
              <p className="text-sm font-semibold text-slate-800">
                자동 해설 대기열 ({queuedProblems.length})
              </p>
              {queuedProblems.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                  영역 박스를 추가하면 여기서 순서대로 자동 해설 생성할 수 있습니다.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-xs text-slate-700">
                  {queuedProblems.map((item, index) => (
                    <li key={item.id} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1">
                      <span>
                        {index + 1}. {item.questionNo}번 ({item.pageLabel})
                        {item.diagramCrops && item.diagramCrops.length > 0
                          ? ` + 그림박스 ${item.diagramCrops.length}`
                          : ""}
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
                  ? "영역 순차 자동 해설 생성 중..."
                  : "영역 박스 순서대로 자동 해설 생성"}
              </button>
            </div>
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

            {rawResponse && (
              <details className="rounded-md border border-slate-200 p-3 text-sm">
                <summary className="cursor-pointer font-semibold text-slate-700">
                  AI 원문 보기
                </summary>
                <pre className="mt-3 whitespace-pre-wrap break-words text-xs text-slate-600">
                  {rawResponse}
                </pre>
              </details>
            )}

            {batchResults.length > 0 && (
              <div className="rounded-md border border-slate-200 p-3 text-xs">
                <p className="font-semibold text-slate-800">자동 생성 결과</p>
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

          <button
            onClick={handleSavePdf}
            disabled={isSavingPdf || currentStep !== 3}
            className="mt-4 w-full rounded-md bg-emerald-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {isSavingPdf ? "PDF 생성 중..." : "PDF로 저장하기"}
          </button>

          <button
            onClick={handleSaveToCompletedFolder}
            disabled={isSavingToFolder || currentStep !== 3}
            className="mt-3 w-full rounded-md bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {isSavingToFolder
              ? "작업 완료 폴더 저장 중..."
              : "작업 완료 폴더로 저장"}
          </button>
        </section>
      </div>
    </main>
  );
}
