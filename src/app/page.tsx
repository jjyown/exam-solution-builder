"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactCrop, {
  type Crop,
  type PixelCrop,
} from "react-image-crop";
import { InlineMath, BlockMath } from "react-katex";
import "react-image-crop/dist/ReactCrop.css";
import "katex/dist/katex.min.css";

import type { ExportDocEntry } from "@/lib/exportDocQuality";
import {
  applyDeterministicExportPatches,
  DEFAULT_EXPLANATION_BODY as DEFAULT_BODY,
  isPlaceholderExplanationBody,
  validateExportDocEntries,
} from "@/lib/exportDocQuality";
import { resolveGeminiGenerateEnvKey } from "@/lib/generateExplanationGeminiEnv";
import { FINAL_EXPLANATION_DIR_NAME } from "@/lib/outputPaths";
import { isCropOnlyUi } from "@/lib/uiMode";

type ParsedExplanation = {
  quickAnswer: string;
  body: string;
};

type ExamListResponse = {
  files: string[];
  error?: string;
  sources?: { local?: boolean; googleDrive?: boolean };
  warnings?: string[];
  /** Next 서버가 읽는 작업 디렉터리 (원격 배포 시 사용자 PC 경로와 다름) */
  serverCwd?: string;
  localScanRoots?: string[];
};

type QueuedProblem = {
  id: string;
  questionNo: string;
  pageLabel: string;
  /** PDF일 때 원본 페이지(바로가기·일괄 제외용). 없으면 pageLabel에서 파싱 시도 */
  pdfPage?: number;
  imageBase64: string;
  imageMimeType: string;
  diagramImages?: Array<{ imageBase64: string; mimeType: string }>;
  crop: PixelCrop;
  diagramCrops?: PixelCrop[];
};

function getPdfPageFromQueuedProblem(item: QueuedProblem): number | null {
  if (typeof item.pdfPage === "number" && Number.isFinite(item.pdfPage) && item.pdfPage >= 1) {
    return Math.floor(item.pdfPage);
  }
  const m = item.pageLabel.match(/^PDF\s+(\d+)\s*p$/i);
  if (m) return Number.parseInt(m[1]!, 10);
  return null;
}

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

type QuestionCardDraft = {
  quickAnswer: string;
  explanationBody: string;
  /** 문항 전환 시 미리보기·상태 일치용(구버전 초안에는 없을 수 있음) */
  rawResponse?: string;
  selectedMethodIndexes: number[];
  representativeMethodIndex: number | null;
  methodSelectionPolicy: "all" | "selected";
  workflowStep: ExplanationWorkflowStep;
};

function pickSelectedVersionForQuestion(
  state: QuestionVersionState | undefined,
): QuestionVersionEntry | null {
  if (!state?.versions?.length) return null;
  return (
    state.versions.find((item) => item.id === state.selectedVersionId) ||
    state.versions[0] ||
    null
  );
}

type SolverModelProfile = "easy" | "balanced" | "killer";

function solverProfileLabel(p: SolverModelProfile) {
  if (p === "easy") return "쉬운 특화";
  if (p === "killer") return "킬러 특화";
  return "균형형";
}

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

function normalizeQuickAnswerForDisplay(raw: string) {
  const value = String(raw ?? "").trim();
  const normalized = value.replace(/[①-⑤]/g, (ch) => {
    const map: Record<string, string> = { "①": "1", "②": "2", "③": "3", "④": "4", "⑤": "5" };
    return map[ch] ?? ch;
  });
  const match = normalized.match(/^[1-5]$/);
  if (!match) return value || "-";
  const circled = ["①", "②", "③", "④", "⑤"][Number(match[0]) - 1];
  return `${circled} (${match[0]})`;
}

function isSameNumberArray(a: number[], b: number[]) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
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
  cropRatio: { x: number; y: number; width: number; height: number };
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

function hasCompletedExplanationBody(body: string) {
  return !isPlaceholderExplanationBody(body);
}

function clampPixelCropToSize(crop: PixelCrop, width: number, height: number): PixelCrop {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const w = Math.max(1, Math.min(crop.width, safeW));
  const h = Math.max(1, Math.min(crop.height, safeH));
  return {
    ...crop,
    width: w,
    height: h,
    x: Math.max(0, Math.min(crop.x, safeW - w)),
    y: Math.max(0, Math.min(crop.y, safeH - h)),
  };
}

function scalePixelCrop(crop: PixelCrop, scaleX: number, scaleY: number, width: number, height: number) {
  return clampPixelCropToSize(
    {
      ...crop,
      x: crop.x * scaleX,
      y: crop.y * scaleY,
      width: crop.width * scaleX,
      height: crop.height * scaleY,
    },
    width,
    height,
  );
}

function pixelCropToRatioCrop(crop: PixelCrop, width: number, height: number) {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const clamped = clampPixelCropToSize(crop, safeW, safeH);
  return {
    x: clamped.x / safeW,
    y: clamped.y / safeH,
    width: clamped.width / safeW,
    height: clamped.height / safeH,
  };
}

function ratioCropToPixelCrop(
  cropRatio: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
): PixelCrop {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  return clampPixelCropToSize(
    {
      unit: "px",
      x: cropRatio.x * safeW,
      y: cropRatio.y * safeH,
      width: cropRatio.width * safeW,
      height: cropRatio.height * safeH,
    },
    safeW,
    safeH,
  );
}

async function parseApiErrorMessage(response: Response, fallback: string) {
  const raw = await response.text();
  if (!raw) return fallback;
  try {
    const json = JSON.parse(raw) as { error?: string; message?: string; details?: string[] };
    const detailText =
      json.details && json.details.length > 0 ? ` / 상세: ${json.details.join(" | ")}` : "";
    return (json.error || json.message || fallback) + detailText;
  } catch {
    return raw;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number) {
  return status === 429 || status === 408 || status === 502 || status === 503 || status === 504;
}

function hasRateLimitSignal(status: number, details?: string[], message?: string) {
  if (status === 429) return true;
  const pattern = /429|Too Many Requests|Resource exhausted/i;
  if (message && pattern.test(message)) return true;
  return !!details?.some((detail) => pattern.test(detail));
}

async function fetchWithBackoff(
  input: RequestInfo | URL,
  init: RequestInit,
  options?: { retries?: number; baseDelayMs?: number },
) {
  const retries = options?.retries ?? 2;
  const baseDelayMs = options?.baseDelayMs ?? 2000;
  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(input, init);
      if (!isRetryableStatus(response.status) || attempt === retries) {
        return response;
      }
      lastResponse = response;
      const waitMs = baseDelayMs * 2 ** attempt;
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const waitMs = baseDelayMs * 2 ** attempt;
      await sleep(waitMs);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error
    ? lastError
    : new Error("네트워크 요청 재시도 중 알 수 없는 오류가 발생했습니다.");
}

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
  const explanationRunGuardRef = useRef(false);
  const batchRunGuardRef = useRef(false);
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
  const [pdfPageInput, setPdfPageInput] = useState("1");
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
  const [solverModelProfile, setSolverModelProfile] =
    useState<SolverModelProfile>("balanced");
  const [questionSolverProfileOverrides, setQuestionSolverProfileOverrides] =
    useState<Partial<Record<string, SolverModelProfile>>>({});
  /** 해설 생성 API가 Gemini 후보를 읽는 환경변수 키(UI와 `pickModelCandidates` 일치). */
  const resolvedGeminiGenerateEnvKey = useMemo(
    () => resolveGeminiGenerateEnvKey({ generationMode, solverModelProfile }),
    [generationMode, solverModelProfile],
  );
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
  const [questionCardDraftMap, setQuestionCardDraftMap] = useState<Record<string, QuestionCardDraft>>(
    {},
  );
  const questionCardDraftMapRef = useRef<Record<string, QuestionCardDraft>>({});
  const questionVersionMapRef = useRef<Record<string, QuestionVersionState>>({});
  const isHydratingQuestionRef = useRef(false);
  const hydrationReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  questionCardDraftMapRef.current = questionCardDraftMap;
  questionVersionMapRef.current = questionVersionMap;
  const [quickAnswerPageSelection, setQuickAnswerPageSelection] = useState("");
  const [explanationRefPageSelection, setExplanationRefPageSelection] = useState("");
  const [noQuickAnswerPage, setNoQuickAnswerPage] = useState(false);
  const [noExplanationRefPage, setNoExplanationRefPage] = useState(false);
  const [isLoadingExams, setIsLoadingExams] = useState(false);
  const [isUploadingCropBundle, setIsUploadingCropBundle] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [queuedProblems, setQueuedProblems] = useState<QueuedProblem[]>([]);
  const [savedPageNumbers, setSavedPageNumbers] = useState<number[]>([]);
  const [excludedPageNumbers, setExcludedPageNumbers] = useState<number[]>([]);
  /** PDF에서 문제 작업으로 남길 페이지만 입력 후 「나머지 제외」에 사용 */
  const [keepWorkPagesOnlyInput, setKeepWorkPagesOnlyInput] = useState("");
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
  const [isExportChecking, setIsExportChecking] = useState(false);
  const [selectedMethodIndexes, setSelectedMethodIndexes] = useState<number[]>([]);
  const [representativeMethodIndex, setRepresentativeMethodIndex] = useState<number | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const appendQualityWarningUnique = useCallback((message: string) => {
    const normalized = message.trim();
    if (!normalized) return;
    setQualityWarnings((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
  }, []);

  const hasImage = Boolean(sourceImage && sourceFile);

  useEffect(() => {
    if (isCropOnlyUi && currentStep === 3) {
      setCurrentStep(2);
    }
  }, [isCropOnlyUi, currentStep]);
  const selectedExamKind = selectedExam ? getExamSourceKind(selectedExam) : "unknown";
  const questionNoOptions = useMemo(
    () => [...new Set(queuedProblems.map((item) => item.questionNo))].sort((a, b) => Number(a) - Number(b)),
    [queuedProblems],
  );
  const cardQuestionNos = useMemo(
    () =>
      [...new Set([...Object.keys(questionVersionMap), ...questionNoOptions])]
        .filter(Boolean)
        .sort((a, b) => Number(a) - Number(b)),
    [questionNoOptions, questionVersionMap],
  );
  const effectiveSolverProfileForCurrentQuestion = useMemo(
    () => questionSolverProfileOverrides[questionNo] ?? solverModelProfile,
    [questionSolverProfileOverrides, questionNo, solverModelProfile],
  );
  const hasGeneratedResult = rawResponse.trim().length > 0;
  const currentQuestionExplanationReady = useMemo(() => {
    if (!questionNo) return false;
    const draft = questionCardDraftMap[questionNo];
    const ver = pickSelectedVersionForQuestion(questionVersionMap[questionNo]);
    const body = draft?.explanationBody ?? ver?.explanationBody ?? "";
    return hasCompletedExplanationBody(body);
  }, [questionNo, questionCardDraftMap, questionVersionMap]);
  const explanationGenerationBusy = isBatchGenerating || isGenerating;
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
  const invalidKeepWorkPagesInput =
    isPdfSource &&
    keepWorkPagesOnlyInput.trim().length > 0 &&
    parsePageSelection(keepWorkPagesOnlyInput, totalPageCount).length === 0;
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

  const getSelectedVersionForQuestion = useCallback(
    (targetQuestionNo: string) => pickSelectedVersionForQuestion(questionVersionMap[targetQuestionNo]),
    [questionVersionMap],
  );

  const exportDocEntriesForSave = useMemo((): ExportDocEntry[] => {
    return cardQuestionNos
      .map((no) => {
        const draft = questionCardDraftMap[no];
        const selectedVersion = pickSelectedVersionForQuestion(questionVersionMap[no]);
        if (!draft && !selectedVersion) return null;
        const quick = (draft?.quickAnswer || selectedVersion?.quickAnswer || "-").trim() || "-";
        const baseBody = draft?.explanationBody || selectedVersion?.explanationBody || "";
        const selectedIndexes =
          draft?.methodSelectionPolicy === "selected"
            ? draft.selectedMethodIndexes
            : splitMethodBlocks(baseBody).methods.map((_, index) => index);
        const body = buildSelectedExplanationBody(
          baseBody,
          selectedIndexes,
          draft?.representativeMethodIndex ?? selectedVersion?.representativeMethodIndex ?? null,
        );
        return {
          questionNo: no,
          quickAnswer: quick,
          body: body.trim() || baseBody.trim() || "(해설 본문 없음)",
        };
      })
      .filter(Boolean) as ExportDocEntry[];
  }, [cardQuestionNos, questionCardDraftMap, questionVersionMap]);

  const exportGatePreview = useMemo(() => {
    const patched = applyDeterministicExportPatches(exportDocEntriesForSave);
    return validateExportDocEntries(patched);
  }, [exportDocEntriesForSave]);

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

  const openQuestionCard = useCallback(
    (targetQuestionNo: string) => {
      setQuestionNo(targetQuestionNo);
    },
    [],
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
    setPdfPageInput(String(safePageNo));
  };

  const loadSourceFile = async (file: File) => {
    const sourceKind = getExamSourceKind(file.name);
    if (sourceKind === "hml" || sourceKind === "hwp") {
      throw new Error(
        "`.hml`/한글 문서는 이 화면에서 직접 열 수 없습니다. PDF 또는 이미지(png/jpg)로 변환한 뒤 선택해 주세요.",
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
    setKeepWorkPagesOnlyInput("");
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

  const [examListHint, setExamListHint] = useState("");

  const loadExamFiles = useCallback(async () => {
    try {
      setIsLoadingExams(true);
      setErrorMessage("");
      setExamListHint("");
      const response = await fetch("/api/exams", { cache: "no-store" });
      const data = (await response.json()) as ExamListResponse;
      if (!response.ok) {
        throw new Error(data.error || "시험지 목록 조회에 실패했습니다.");
      }
      setExamFiles(data.files);
      const parts: string[] = [];
      if (data.warnings?.length) parts.push(...data.warnings);
      if (data.files.length === 0) {
        if (data.sources?.googleDrive === false) {
          parts.push("Google Drive OAuth가 없어 Drive 쪽 시험지는 목록에 안 붙습니다(.env.local).");
        }
        parts.push(
          `서버 작업 경로(serverCwd): ${data.serverCwd ?? "(알 수 없음)"} — 시험지·exams는 이 기준의 하위에 있어야 합니다.`,
        );
        parts.push(
          "브라우저 주소가 localhost가 아니면(예: Railway), 내 PC의 `highroad-math-solution/시험지`와는 별개입니다. Drive OAuth를 쓰거나, 직접 이미지 업로드·로컬에서 `npm run dev`로 열어 주세요.",
        );
      }
      setExamListHint(parts.filter(Boolean).join(" "));
    } catch (error) {
      setExamListHint("");
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
    const currentW = renderImageSize.width;
    const currentH = renderImageSize.height;
    if (currentW <= 0 || currentH <= 0) return;

    setPendingDiagramBoxes((boxes) =>
      boxes.map((box) => ({
        ...box,
        crop: ratioCropToPixelCrop(
          box.cropRatio ?? pixelCropToRatioCrop(box.crop, currentW, currentH),
          currentW,
          currentH,
        ),
      })),
    );
    setPageDrafts((drafts) => {
      const next: Record<number, PageDraft> = {};
      for (const [pageNoText, draft] of Object.entries(drafts)) {
        const pageNo = Number(pageNoText);
        next[pageNo] = {
          ...draft,
          diagramBoxes: draft.diagramBoxes.map((box) => ({
            ...box,
            crop: ratioCropToPixelCrop(
              box.cropRatio ?? pixelCropToRatioCrop(box.crop, currentW, currentH),
              currentW,
              currentH,
            ),
          })),
        };
      }
      return next;
    });
  }, [renderImageSize.height, renderImageSize.width]);

  /** 참조가 아니라 내용이 바뀔 때만 문항 동기화(무한 렌더 #185 방지) */
  const questionCardHydrationKey = useMemo(() => {
    const d = questionNo ? questionCardDraftMap[questionNo] : undefined;
    if (!d || !questionNo) return "";
    return [
      questionNo,
      d.quickAnswer,
      d.explanationBody,
      d.rawResponse ?? "",
      d.methodSelectionPolicy,
      d.workflowStep,
      String(d.representativeMethodIndex ?? ""),
      d.selectedMethodIndexes.join(","),
    ].join("\u001f");
  }, [questionNo, questionCardDraftMap]);

  const questionVersionHydrationKey = useMemo(() => {
    const st = questionNo ? questionVersionMap[questionNo] : undefined;
    if (!st || !questionNo) return "";
    return [
      questionNo,
      st.selectedVersionId,
      st.versions.map((v) => `${v.id}:${v.createdAt}`).join(","),
    ].join("\u001f");
  }, [questionNo, questionVersionMap]);

  useLayoutEffect(() => {
    if (!questionNo) return;
    isHydratingQuestionRef.current = true;
    if (hydrationReleaseTimerRef.current) {
      clearTimeout(hydrationReleaseTimerRef.current);
      hydrationReleaseTimerRef.current = null;
    }
    const draft = questionCardDraftMap[questionNo];
    const selected = pickSelectedVersionForQuestion(questionVersionMap[questionNo]);
    if (draft) {
      const safeIndexes = draft.selectedMethodIndexes.length > 0 ? draft.selectedMethodIndexes : [0];
      if (quickAnswer !== draft.quickAnswer) setQuickAnswer(draft.quickAnswer);
      if (explanationBody !== draft.explanationBody) setExplanationBody(draft.explanationBody);
      if (!isSameNumberArray(selectedMethodIndexes, safeIndexes)) {
        setSelectedMethodIndexes(safeIndexes);
      }
      if (representativeMethodIndex !== draft.representativeMethodIndex) {
        setRepresentativeMethodIndex(draft.representativeMethodIndex);
      }
      if (methodSelectionPolicy !== draft.methodSelectionPolicy) {
        setMethodSelectionPolicy(draft.methodSelectionPolicy);
      }
      if (workflowStep !== draft.workflowStep) setWorkflowStep(draft.workflowStep);
      const nextRaw = draft.rawResponse?.trim() ? draft.rawResponse : selected?.rawResponse ?? "";
      if (rawResponse !== nextRaw) setRawResponse(nextRaw);
    } else if (selected) {
      applyVersionToEditor(selected);
    }
    hydrationReleaseTimerRef.current = setTimeout(() => {
      isHydratingQuestionRef.current = false;
      hydrationReleaseTimerRef.current = null;
    }, 0);
    return () => {
      if (hydrationReleaseTimerRef.current) {
        clearTimeout(hydrationReleaseTimerRef.current);
        hydrationReleaseTimerRef.current = null;
      }
      isHydratingQuestionRef.current = false;
    };
  }, [
    applyVersionToEditor,
    questionNo,
    questionCardHydrationKey,
    questionVersionHydrationKey,
  ]);

  useEffect(() => {
    if (!questionNo || !hasGeneratedResult) return;
    if (isHydratingQuestionRef.current) return;
    const hasStoredForQuestion =
      Boolean(questionCardDraftMapRef.current[questionNo]) ||
      Boolean(pickSelectedVersionForQuestion(questionVersionMapRef.current[questionNo]));
    if (!hasStoredForQuestion) return;
    setQuestionCardDraftMap((prev) => {
      const nextDraft: QuestionCardDraft = {
        quickAnswer,
        explanationBody,
        rawResponse,
        selectedMethodIndexes,
        representativeMethodIndex,
        methodSelectionPolicy,
        workflowStep,
      };
      const current = prev[questionNo];
      if (
        current &&
        current.quickAnswer === nextDraft.quickAnswer &&
        current.explanationBody === nextDraft.explanationBody &&
        current.rawResponse === nextDraft.rawResponse &&
        current.representativeMethodIndex === nextDraft.representativeMethodIndex &&
        current.methodSelectionPolicy === nextDraft.methodSelectionPolicy &&
        current.workflowStep === nextDraft.workflowStep &&
        isSameNumberArray(current.selectedMethodIndexes, nextDraft.selectedMethodIndexes)
      ) {
        return prev;
      }
      return {
        ...prev,
        [questionNo]: nextDraft,
      };
    });
  }, [
    explanationBody,
    hasGeneratedResult,
    methodSelectionPolicy,
    questionNo,
    quickAnswer,
    rawResponse,
    representativeMethodIndex,
    selectedMethodIndexes,
    workflowStep,
  ]);

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

  const handleGenerateExplanation = async () => {
    if (!sourceFile) {
      setErrorMessage("문제 이미지를 먼저 업로드해 주세요.");
      return;
    }
    if (!imageRef.current) {
      setErrorMessage("이미지 로딩이 완료된 뒤 다시 시도해 주세요.");
      return;
    }
    const matchedQueuedProblem = queuedProblems.find(
      (q) => String(q.questionNo) === String(questionNo),
    );
    if (
      isPdfSource &&
      !matchedQueuedProblem &&
      !requiredPageNumbers.includes(pdfPageNo)
    ) {
      setErrorMessage(
        "현재 페이지는 빠른정답/해설참고로 지정되어 풀이 대상에서 제외된 페이지입니다. 문제 페이지로 이동해 주세요.",
      );
      return;
    }
    if (explanationRunGuardRef.current) {
      setErrorMessage("해설 생성이 이미 진행 중입니다. 완료 후 다시 시도해 주세요.");
      return;
    }
    explanationRunGuardRef.current = true;
    try {
      setIsGenerating(true);
      const singleRunId = `single-${Date.now()}`;
      setErrorMessage("");
      setSuccessMessage("");
      setQualityWarnings([]);

      const mimeType = sourceFile.type || "image/png";
      let selectedProblemCrop: PixelCrop | null = null;
      let imageBase64: string;
      let requestMimeType = mimeType;
      let liveDiagramImages: Array<{ imageBase64: string; mimeType: string }>;

      if (matchedQueuedProblem) {
        /** 문항 카드 N번 재생성: 화면 첫 박스가 아니라 대기열에 저장된 N번 크롭·이미지 사용(버그 수정) */
        selectedProblemCrop = matchedQueuedProblem.crop;
        imageBase64 = matchedQueuedProblem.imageBase64;
        requestMimeType = matchedQueuedProblem.imageMimeType || mimeType;
        liveDiagramImages = matchedQueuedProblem.diagramImages?.length
          ? [...matchedQueuedProblem.diagramImages]
          : [];
      } else {
        selectedProblemCrop =
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
        imageBase64 = selectedProblemCrop
          ? cropImageToBase64(imageRef.current, selectedProblemCrop, mimeType)
          : await toBase64(sourceFile);
        liveDiagramImages = pendingDiagramBoxes.map((box) => ({
          imageBase64: cropImageToBase64(imageRef.current!, box.crop, box.mimeType || mimeType),
          mimeType: box.mimeType || mimeType,
        }));
      }

      const visionPrecheckRes = await fetchWithBackoff(
        "/api/precheck-extraction",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64,
            imageMimeType: requestMimeType,
            crop: selectedProblemCrop,
          }),
        },
        { retries: 1 },
      );
      const visionPrecheckData = (await visionPrecheckRes.json()) as VisionPrecheckResponse;
      if (visionPrecheckRes.status === 429) {
        appendQualityWarningUnique(
          "비전 사전검증 429 혼잡이 감지되어 자동 재시도 후 진행했습니다. 잠시 후 다시 시도하면 더 안정적입니다.",
        );
      }
      if (!visionPrecheckRes.ok) {
        const precheckRateLimited = hasRateLimitSignal(
          visionPrecheckRes.status,
          visionPrecheckData.details,
          visionPrecheckData.error,
        );
        if (precheckRateLimited) {
          appendQualityWarningUnique(
            "비전 사전검증이 429 혼잡으로 실패해 검증을 건너뛰고 생성을 계속합니다. 결과를 한 번 더 확인해 주세요.",
          );
        } else if (visionPrecheckRes.status >= 500) {
          const details = visionPrecheckData.details?.join(" | ");
          appendQualityWarningUnique(
            `비전 사전검증 서버 오류(${visionPrecheckRes.status})로 검증을 건너뛰고 생성을 계속합니다.${
              details ? ` 상세: ${details}` : ""
            }`,
          );
        }
        if (!precheckRateLimited && visionPrecheckRes.status < 500) {
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

      const response = await fetchWithBackoff(
        "/api/generate-explanation",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            questionText: useTextInput ? questionText : "",
            imageBase64,
            imageMimeType: requestMimeType,
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
            solverModelProfile: effectiveSolverProfileForCurrentQuestion,
            includeDiagramExplanation,
            explanationSelectionMode,
            showAllMethods,
            crop: selectedProblemCrop,
          }),
        },
        { retries: 1 },
      );

      if (!response.ok) {
        const data = (await response.json()) as { error?: string; details?: string[] };
        const hasRateLimitSignal =
          response.status === 429 ||
          !!data.details?.some((detail) => /429|Too Many Requests|Resource exhausted/i.test(detail)) ||
          /429|Too Many Requests|Resource exhausted/i.test(data.error ?? "");
        if (hasRateLimitSignal) {
          appendQualityWarningUnique(
            "해설 생성 429 혼잡이 감지되었습니다. 자동 재시도를 수행했으며, 반복 시 잠시 후 재시도해 주세요.",
          );
        }
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
          modelLabel: data.model || `gemini-${effectiveSolverProfileForCurrentQuestion}`,
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
      explanationRunGuardRef.current = false;
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
    const normalizedCrop = clampPixelCropToSize(activeCrop, imageRef.current.width, imageRef.current.height);
    const cropRatio = pixelCropToRatioCrop(
      normalizedCrop,
      imageRef.current.width,
      imageRef.current.height,
    );
    const imageBase64 = cropImageToBase64(imageRef.current, normalizedCrop, mimeType);
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
        crop: normalizedCrop,
        cropRatio,
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
            cropRatio: pixelCropToRatioCrop(
              {
                ...box.crop,
                x: nextX,
                y: nextY,
              },
              imageWidth,
              imageHeight,
            ),
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
            cropRatio: pixelCropToRatioCrop(
              {
                ...box.crop,
                width: nextWidth,
                height: nextHeight,
              },
              imageWidth,
              imageHeight,
            ),
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
          cropRatio: { ...item.cropRatio },
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
        cropRatio: item.cropRatio
          ? { ...item.cropRatio }
          : pixelCropToRatioCrop(item.crop, Math.max(1, renderImageSize.width), Math.max(1, renderImageSize.height)),
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
        pdfPage: isPdfSource ? pageNumber : 1,
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
      if (!isCropOnlyUi) {
        setCurrentStep(3);
        setSuccessMessage(
          `${pageLabel} 작업 저장 완료. 모든 페이지 작업이 끝나서 해설 제작 단계로 이동했습니다.`,
        );
        return;
      }
      setSuccessMessage(
        `${pageLabel} 저장 완료. 필수 페이지 크롭이 모두 끝났습니다. 아래 「저장된 문항」을 확인한 뒤, 로컬 제작기(일반 모드)에서 해설·DOCX를 진행하거나 Drive에 묶음을 올리는 절차를 이어가세요.`,
      );
      return;
    }
    setSuccessMessage(
      `${pageLabel} 문제 박스를 저장했습니다. (${nextCompletedRequired}/${requiredPageNumbers.length} 필수 페이지 완료, 제외 ${excludedPageNumbers.length})`,
    );
  };

  const goToStep3IfReady = () => {
    if (isCropOnlyUi) return;
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

  /**
   * 유지할 PDF 페이지(숫자 배열)만 남기고 나머지 일괄 제외. 빠른정답·해설참고 페이지는 자동 포함.
   */
  const commitWorkPagesKeepSet = (
    baseKeepPages: number[],
    messageMode: "manualInput" | "fromSavedQuestions" = "manualInput",
  ): boolean => {
    if (!isPdfSource || pdfPageCount < 1) return false;
    const uniqBase = [...new Set(baseKeepPages.filter((p) => p >= 1 && p <= pdfPageCount))].sort(
      (a, b) => a - b,
    );
    if (uniqBase.length === 0) return false;

    const keepPages = [...new Set([...uniqBase, ...referenceOnlyPages])].sort((a, b) => a - b);
    const keepSet = new Set(keepPages);
    const excluded: number[] = [];
    for (let p = 1; p <= pdfPageCount; p += 1) {
      if (!keepSet.has(p)) excluded.push(p);
    }
    setExcludedPageNumbers(excluded);
    setSavedPageNumbers((prev) => prev.filter((p) => keepSet.has(p)));

    const nextWorks: Record<number, QueuedProblem[]> = {};
    for (const [k, items] of Object.entries(savedPageWorks)) {
      const pn = Number.parseInt(k, 10);
      if (Number.isFinite(pn) && keepSet.has(pn)) nextWorks[pn] = items;
    }
    setSavedPageWorks(nextWorks);
    const mergedProblems = Object.entries(nextWorks)
      .map(([page, items]) => ({ page: Number.parseInt(page, 10), items }))
      .sort((a, b) => a.page - b.page)
      .flatMap((entry) => entry.items);
    setQueuedProblems(
      mergedProblems.map((item, idx) => ({
        ...item,
        questionNo: String(idx + 1),
      })),
    );

    setPageDrafts((prev) => {
      const next = { ...prev };
      for (const p of excluded) delete next[p];
      return next;
    });

    const refNote =
      referenceOnlyPages.length > 0
        ? ` 빠른정답·해설참고 페이지(${referenceOnlyPages.join(", ")})는 자동 유지했습니다.`
        : "";
    if (messageMode === "fromSavedQuestions") {
      setSuccessMessage(
        `저장된 문항이 있는 페이지(${uniqBase.join(", ")})만 작업 대상으로 유지하고, 나머지 ${excluded.length}페이지를 제외했습니다.${refNote}`,
      );
    } else {
      setSuccessMessage(
        `작업 유지 페이지: ${keepPages.join(", ")}. 나머지 ${excluded.length}페이지를 제외했습니다.${refNote}`,
      );
    }
    setErrorMessage("");
    return true;
  };

  /** 입력한 페이지·참고 전용 페이지만 남기고 나머지를 일괄 제외 */
  const applyExcludeAllExceptListedPages = () => {
    if (!isPdfSource || pdfPageCount < 1) return;
    const raw = keepWorkPagesOnlyInput.trim();
    if (!raw) {
      setErrorMessage("유지할 페이지를 입력한 뒤 적용해 주세요. (예: 3-10, 15)");
      setSuccessMessage("");
      return;
    }
    const parsed = parsePageSelection(raw, pdfPageCount);
    if (parsed.length === 0) {
      setErrorMessage(`유효한 페이지가 없습니다. 1~${pdfPageCount} 범위·형식(예: 3-10, 15)을 확인해 주세요.`);
      setSuccessMessage("");
      return;
    }
    commitWorkPagesKeepSet(parsed, "manualInput");
  };

  /** 저장된 문항이 위치한 PDF 페이지만 유지(수동 입력 없이) */
  const applyExcludeKeepOnlySavedQuestionPages = () => {
    if (!isPdfSource || pdfPageCount < 1) {
      setErrorMessage("PDF 시험지에서만 사용할 수 있습니다.");
      setSuccessMessage("");
      return;
    }
    if (queuedProblems.length === 0) {
      setErrorMessage("저장된 문항이 없습니다. 먼저 「현재 페이지 작업 저장」으로 문항을 저장해 주세요.");
      setSuccessMessage("");
      return;
    }
    const pages: number[] = [];
    for (const item of queuedProblems) {
      const p = getPdfPageFromQueuedProblem(item);
      if (p !== null && p >= 1 && p <= pdfPageCount) pages.push(p);
    }
    const uniq = [...new Set(pages)].sort((a, b) => a - b);
    if (uniq.length === 0) {
      setErrorMessage("저장된 문항에서 PDF 페이지 번호를 읽지 못했습니다.");
      setSuccessMessage("");
      return;
    }
    setKeepWorkPagesOnlyInput(uniq.join(", "));
    commitWorkPagesKeepSet(uniq, "fromSavedQuestions");
  };

  const removeQueuedProblem = (id: string) => {
    setQueuedProblems((prev) => prev.filter((item) => item.id !== id));
  };

  const handleUploadCropBundleToDrive = useCallback(async () => {
    if (queuedProblems.length === 0) return;
    setIsUploadingCropBundle(true);
    setErrorMessage("");
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const extFromMime = (mime: string) => {
        const m = mime.toLowerCase();
        if (m.includes("png")) return ".png";
        if (m.includes("jpeg")) return ".jpg";
        if (m.includes("webp")) return ".webp";
        if (m.includes("gif")) return ".gif";
        return ".img";
      };
      const itemsMeta: Array<{ questionNo: string; pageLabel: string; file: string }> = [];
      for (const item of queuedProblems) {
        const label = item.pageLabel.replace(/[/\\?%*:|"<> \t\n\r]/g, "_") || "page";
        const ext = extFromMime(item.imageMimeType || "image/png");
        const fname = `q${item.questionNo}_${label}${ext}`;
        zip.file(fname, item.imageBase64, { base64: true });
        itemsMeta.push({ questionNo: item.questionNo, pageLabel: item.pageLabel, file: fname });
      }
      const examLabel = selectedExam || "직접업로드";
      zip.file(
        "manifest.json",
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            examName: examLabel,
            itemCount: queuedProblems.length,
            items: itemsMeta,
          },
          null,
          2,
        ),
      );
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const form = new FormData();
      form.append("file", blob, "bundle.zip");
      form.append("examName", examLabel);
      const res = await fetch("/api/upload-crop-bundle", { method: "POST", body: form });
      if (!res.ok) {
        const msg = await parseApiErrorMessage(res, "Drive 업로드 실패");
        throw new Error(msg);
      }
      const data = (await res.json()) as { message?: string };
      setSuccessMessage(data.message || "Drive에 크롭 묶음을 올렸습니다.");
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Drive 업로드 중 오류");
    } finally {
      setIsUploadingCropBundle(false);
    }
  }, [queuedProblems, selectedExam]);

  const runBatchGeneration = async () => {
    if (queuedProblems.length === 0) {
      setErrorMessage("먼저 문제 박스를 하나 이상 추가해 주세요.");
      return;
    }
    if (!imageRef.current) {
      setErrorMessage("이미지 로딩이 완료된 뒤 순차 생성을 다시 시도해 주세요.");
      return;
    }
    if (batchRunGuardRef.current) {
      setErrorMessage("순차 자동 생성이 이미 진행 중입니다. 완료 후 다시 시도해 주세요.");
      return;
    }
    batchRunGuardRef.current = true;

    try {
      setIsBatchGenerating(true);
      setErrorMessage("");
      setSuccessMessage("");
      setBatchResults([]);
      setQualityWarnings([]);
      const batchRunId = `batch-${Date.now()}`;

      const results: BatchResult[] = [];
      const successfulQuestionNos: string[] = [];
      const basePerQuestionDelayMs = 4000;
      const maxPerQuestionDelayMs = 14000;
      const perQuestionDelayStepMs = 2000;
      let perQuestionDelayMs = basePerQuestionDelayMs;
      let precheckRateLimitCount = 0;
      let skipVisionPrecheckForRemaining = false;

      const bumpBackpressureDelay = (contextLabel: string) => {
        const nextDelayMs = Math.min(maxPerQuestionDelayMs, perQuestionDelayMs + perQuestionDelayStepMs);
        if (nextDelayMs === perQuestionDelayMs) return;
        perQuestionDelayMs = nextDelayMs;
        appendQualityWarningUnique(
          `${contextLabel}: 429 혼잡 감지로 다음 문항 대기시간을 ${Math.round(perQuestionDelayMs / 1000)}초로 늘렸습니다.`,
        );
      };

      const relaxBackpressureDelay = () => {
        if (perQuestionDelayMs <= basePerQuestionDelayMs) return;
        perQuestionDelayMs = Math.max(basePerQuestionDelayMs, perQuestionDelayMs - 500);
      };

      for (let itemIndex = 0; itemIndex < queuedProblems.length; itemIndex += 1) {
        const item = queuedProblems[itemIndex];
        try {
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

          if (!skipVisionPrecheckForRemaining) {
            const visionPrecheckRes = await fetchWithBackoff(
              "/api/precheck-extraction",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  imageBase64: item.imageBase64,
                  imageMimeType: item.imageMimeType,
                  crop: item.crop,
                }),
              },
              { retries: 0 },
            );
            const visionPrecheckData = (await visionPrecheckRes.json()) as VisionPrecheckResponse;
            if (visionPrecheckRes.status === 429) {
              bumpBackpressureDelay(`${item.questionNo}번 사전검증`);
            }
            if (!visionPrecheckRes.ok) {
              const precheckRateLimited = hasRateLimitSignal(
                visionPrecheckRes.status,
                visionPrecheckData.details,
                visionPrecheckData.error,
              );
              if (precheckRateLimited) {
                precheckRateLimitCount += 1;
                appendQualityWarningUnique(
                  "비전 사전검증 429 혼잡으로 일부 문항의 검증을 건너뛰고 생성을 계속합니다. 결과를 한 번 더 확인해 주세요.",
                );
                if (precheckRateLimitCount >= 2) {
                  skipVisionPrecheckForRemaining = true;
                  appendQualityWarningUnique(
                    "사전검증 429가 연속 발생해 남은 문항은 비전 사전검증을 잠시 생략합니다.",
                  );
                }
              } else if (visionPrecheckRes.status >= 500) {
                const detailText = visionPrecheckData.details?.join(" | ");
                appendQualityWarningUnique(
                  `${item.questionNo}번: 비전 사전검증 서버 오류(${visionPrecheckRes.status})로 검증을 건너뛰고 생성을 계속합니다.${
                    detailText ? ` 상세: ${detailText}` : ""
                  }`,
                );
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
            } else {
              precheckRateLimitCount = 0;
              if (!visionPrecheckData.pass) {
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
            }
          }

          const itemSolverProfile =
            questionSolverProfileOverrides[item.questionNo] ?? solverModelProfile;
          const response = await fetchWithBackoff(
            "/api/generate-explanation",
            {
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
                solverModelProfile: itemSolverProfile,
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
            },
            { retries: 1 },
          );

          if (!response.ok) {
            const data = (await response.json()) as { error?: string; details?: string[] };
            const hasRateLimitSignal =
              response.status === 429 ||
              !!data.details?.some((detail) => /429|Too Many Requests|Resource exhausted/i.test(detail)) ||
              /429|Too Many Requests|Resource exhausted/i.test(data.error ?? "");
            if (hasRateLimitSignal) {
              bumpBackpressureDelay(`${item.questionNo}번 해설생성`);
            }
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
          const parsedMethodBlocks = splitMethodBlocks(parsed.body);
          const selectedIndexes = parsedMethodBlocks.methods.map((_, index) => index);
          const nextWorkflowStep: ExplanationWorkflowStep =
            parsedMethodBlocks.methods.length > 1
              ? "select_explanation"
              : "confirm_quick_answer";
          pushQuestionVersion(
            item.questionNo,
            {
              rawResponse: rawResult,
              quickAnswer: parsed.quickAnswer,
              explanationBody: parsed.body,
              selectedMethodIndexes: selectedIndexes,
              representativeMethodIndex: parsedMethodBlocks.methods.length > 0 ? 0 : null,
              workflowStep: nextWorkflowStep,
              modelLabel: data.model || `gemini-${itemSolverProfile}`,
              sourceType: "batch",
              runId: batchRunId,
            },
            true,
          );
          setQuestionCardDraftMap((prev) => ({
            ...prev,
            [item.questionNo]: {
              quickAnswer: parsed.quickAnswer,
              explanationBody: parsed.body,
              rawResponse: rawResult,
              selectedMethodIndexes: selectedIndexes,
              representativeMethodIndex: parsedMethodBlocks.methods.length > 0 ? 0 : null,
              methodSelectionPolicy: "all",
              workflowStep: nextWorkflowStep,
            },
          }));
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
          successfulQuestionNos.push(item.questionNo);
          relaxBackpressureDelay();
        } finally {
          if (itemIndex < queuedProblems.length - 1) {
            await sleep(perQuestionDelayMs);
          }
        }
      }

      setBatchResults(results);
      if (successfulQuestionNos.length > 0) {
        const firstQuestionNo = successfulQuestionNos[0];
        openQuestionCard(firstQuestionNo);
        setWorkflowStep("generate_sheet");
        setSuccessMessage(
          `문제 박스 순차 자동 해설 생성을 완료했습니다. (${successfulQuestionNos.length}문항 성공) 카드에서 검토 후 해설 제작(DOCX)을 눌러주세요.`,
        );
      } else {
        setSuccessMessage("문제 박스 순차 자동 해설 생성을 완료했습니다. (성공 문항 없음)");
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "자동 해설 생성 중 오류가 발생했습니다.";
      setErrorMessage(message);
    } finally {
      batchRunGuardRef.current = false;
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

  const jumpToPdfPage = async () => {
    if (!originalFile || !isPdfSource) return;
    const targetPage = Number.parseInt(pdfPageInput.trim(), 10);
    if (!Number.isFinite(targetPage) || targetPage < 1 || targetPage > pdfPageCount) {
      setErrorMessage(`이동할 페이지를 1~${pdfPageCount} 범위에서 입력해 주세요.`);
      return;
    }
    if (targetPage === pdfPageNo) return;
    try {
      setErrorMessage("");
      setSuccessMessage("");
      savePageDraft(pdfPageNo);
      await renderPdfPageToImage(originalFile, targetPage);
      restorePageDraft(targetPage);
      setCrop(undefined);
      setCompletedCrop(undefined);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "PDF 페이지 이동 중 오류가 발생했습니다.";
      setErrorMessage(message);
    }
  };

  /** 저장 문항이 있는 PDF 페이지로 이동(현재 표시와 무관). 단계 3에서도 2로 전환해 시험지를 보여 줌 */
  const navigateToQuestionPdfPage = async (targetPage: number) => {
    if (!originalFile || !isPdfSource) {
      setErrorMessage("PDF가 열려 있을 때만 페이지 이동이 가능합니다.");
      return;
    }
    if (!Number.isFinite(targetPage) || targetPage < 1 || targetPage > pdfPageCount) {
      setErrorMessage(`이동할 페이지는 1~${pdfPageCount} 사이여야 합니다.`);
      return;
    }
    try {
      setErrorMessage("");
      setSuccessMessage("");
      savePageDraft(pdfPageNo);
      setPdfPageInput(String(targetPage));
      await renderPdfPageToImage(originalFile, targetPage);
      restorePageDraft(targetPage);
      setCrop(undefined);
      setCompletedCrop(undefined);
      if (currentStep !== 2) setCurrentStep(2);
      setSuccessMessage(`${targetPage}페이지로 이동했습니다. (문항 박스·크롭은 해당 페이지 저장본 기준)`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "PDF 페이지 이동 중 오류가 발생했습니다.";
      setErrorMessage(message);
    }
  };

  const handleSaveCurrentDocx = async () => {
    if (cardQuestionNos.length === 0) {
      setErrorMessage("먼저 자동 순차 실행으로 문항 카드를 생성해 주세요.");
      return;
    }
    try {
      setIsExportChecking(true);
      setErrorMessage("");
      setSuccessMessage("");

      if (exportDocEntriesForSave.length === 0) {
        setErrorMessage("DOCX에 넣을 문항 카드가 없습니다. 카드 생성/선택 상태를 확인해 주세요.");
        return;
      }

      let exportEntries = applyDeterministicExportPatches(exportDocEntriesForSave);
      let exportValidation = validateExportDocEntries(exportEntries);
      if (!exportValidation.ok) {
        const repairRes = await fetch("/api/repair-explanations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: exportEntries }),
        });
        if (!repairRes.ok) {
          const msg = await parseApiErrorMessage(repairRes, "내보내기 전 자동 보정에 실패했습니다.");
          throw new Error(msg);
        }
        const repairData = (await repairRes.json()) as {
          entries?: ExportDocEntry[];
        };
        if (Array.isArray(repairData.entries) && repairData.entries.length > 0) {
          const repairedMap = new Map(
            repairData.entries.map((item) => [String(item.questionNo), item] as const),
          );
          exportEntries = exportEntries.map(
            (item) => repairedMap.get(String(item.questionNo)) ?? item,
          );
        }
        exportEntries = applyDeterministicExportPatches(exportEntries);
        exportValidation = validateExportDocEntries(exportEntries);
        if (!exportValidation.ok) {
          throw new Error(
            `자동 보정 후에도 내보내기 규칙을 만족하지 못했습니다.\n${exportValidation.issues.join("\n")}`,
          );
        }
        setSuccessMessage("내보내기 전 자동 보정을 적용했습니다. DOCX를 생성합니다...");
      } else {
        setSuccessMessage("내보내기 전 규칙 검증을 통과했습니다. DOCX를 생성합니다...");
      }

      const formData = new FormData();
      formData.append("examName", selectedExam || "직접업로드");
      formData.append(
        "questionNo",
        `통합_${exportEntries[0]?.questionNo || "1"}-${exportEntries[exportEntries.length - 1]?.questionNo || "1"}`,
      );
      formData.append("quickAnswer", "문항별 정답은 해설 본문의 [정답]을 확인하세요.");
      formData.append(
        "explanationBody",
        exportEntries
          .map(
            (entry) =>
              `[문항 ${entry.questionNo}]\n[정답] ${entry.quickAnswer}\n${entry.body}`,
          )
          .join("\n\n"),
      );
      const saveRes = await fetch("/api/save-result", {
        method: "POST",
        body: formData,
      });
      if (!saveRes.ok) {
        const msg = await parseApiErrorMessage(saveRes, "DOCX 저장 실패");
        throw new Error(msg);
      }
      const savedMessage = (await saveRes.json()) as { message?: string };
      setSuccessMessage(
        savedMessage.message ||
          `문항 카드 편집 결과로 해설지 DOCX를 「${FINAL_EXPLANATION_DIR_NAME}」에 저장했습니다.`,
      );
      setWorkflowStep("generate_sheet");
    } catch (error) {
      const message = error instanceof Error ? error.message : "DOCX 저장 중 오류가 발생했습니다.";
      setErrorMessage(message);
    } finally {
      setIsExportChecking(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-100 p-4 md:p-6">
      <div className="mx-auto grid max-w-[1600px] grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
          <h1 className="text-xl font-bold text-slate-900">
            {isCropOnlyUi ? "하이로드 수학 · 영역 크롭" : "하이로드 수학 해설지 제작기"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {isCropOnlyUi
              ? "PDF·이미지에서 문제 영역만 지정합니다. 해설·DOCX는 로컬에서 일반 모드로 실행하세요."
              : "필요한 단계만 보이도록 단순화된 제작 흐름"}
          </p>

          <div className="mt-5 space-y-4">
            <div
              className={`grid gap-2 text-xs ${isCropOnlyUi ? "grid-cols-2" : "grid-cols-3"}`}
            >
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
              {!isCropOnlyUi && (
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
              )}
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              {currentStep === 1 &&
                "현재 단계: 시험지 선택. 목록에서 파일을 선택하거나 직접 업로드하세요."}
              {currentStep === 2 &&
                (isCropOnlyUi
                  ? "현재 단계: 크롭 전용. 한 박스에 한 문항만(선지·조건까지). 페이지마다 「현재 페이지 작업 저장」으로 대기열에 쌓입니다."
                  : "현재 단계: 수동 영역 지정. 한 박스에는 한 문항만(선지·조건까지). 여러 문항이 보이면 박스를 나눕니다. 저장 후 해설 제작으로 넘어가세요.")}
              {!isCropOnlyUi && currentStep === 3 &&
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
                  <div className="p-3 text-sm text-slate-500">
                    <p>
                      시험지 폴더에 파일이 없습니다. 앱 루트(서버)의 `시험지` 또는 `exams`에 png/jpg/pdf
                      등을 넣은 뒤 새로고침 하세요.
                    </p>
                    {examListHint ? (
                      <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs leading-snug text-amber-950">
                        {examListHint}
                      </p>
                    ) : null}
                  </div>
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
                    <div className="mt-2 flex items-center justify-center gap-2 text-xs">
                      <input
                        type="number"
                        min={1}
                        max={pdfPageCount}
                        value={pdfPageInput}
                        onChange={(event) => setPdfPageInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void jumpToPdfPage();
                          }
                        }}
                        className="w-20 rounded border border-slate-300 px-2 py-1 text-center"
                        placeholder="페이지"
                      />
                      <button
                        type="button"
                        onClick={() => void jumpToPdfPage()}
                        className="rounded border border-slate-300 bg-white px-2 py-1"
                      >
                        페이지 이동
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
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/90 p-2">
                      <p className="text-xs font-semibold text-amber-950">
                        작업할 페이지만 남기기 (나머지 일괄 제외)
                      </p>
                      <p className="mt-0.5 text-[11px] leading-snug text-amber-900">
                        <strong>문제 지정·저장</strong>을 계속할 페이지만 입력하면, 그 외는 모두 「이 페이지 제외」와
                        같이 처리됩니다. 빠른정답·해설참고로 이미 지정한 페이지는 범위에 넣지 않아도{" "}
                        <strong>자동으로 유지</strong>됩니다.
                      </p>
                      <div className="mt-1.5 flex flex-col gap-1.5 sm:flex-row sm:items-stretch">
                        <input
                          type="text"
                          value={keepWorkPagesOnlyInput}
                          onChange={(event) => setKeepWorkPagesOnlyInput(event.target.value)}
                          placeholder="예: 3-15, 18, 22-25"
                          className="min-w-0 flex-1 rounded border border-amber-300/80 bg-white px-2 py-1 text-xs"
                        />
                        <button
                          type="button"
                          onClick={applyExcludeAllExceptListedPages}
                          className="shrink-0 rounded border border-amber-700 bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-200"
                        >
                          나머지 페이지 제외 적용
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={applyExcludeKeepOnlySavedQuestionPages}
                        disabled={queuedProblems.length === 0}
                        className="mt-2 w-full rounded border border-amber-800 bg-amber-200/90 px-2 py-2 text-xs font-semibold text-amber-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        선택(저장) 문항이 있는 페이지만 유지 · 나머지 일괄 제외
                      </button>
                      <p className="mt-1 text-[10px] leading-snug text-amber-900/90">
                        위 입력 없이, 지금 대기열에 저장된 문항의 PDF 페이지만 남기고 나머지는 전부 제외합니다.
                        빠른정답·해설참고 페이지는 기존과 같이 자동 유지됩니다.
                      </p>
                      {invalidKeepWorkPagesInput && (
                        <p className="mt-1 text-[11px] text-rose-700">
                          입력 형식이나 범위를 확인해 주세요. (쉼표·하이픈 구간, 1~{pdfPageCount}페이지)
                        </p>
                      )}
                    </div>
                    {isPdfSource && queuedProblems.length > 0 && (
                      <div className="mt-2 rounded-md border border-sky-200 bg-sky-50/90 p-2">
                        <p className="text-xs font-semibold text-sky-950">저장된 문항 → PDF 페이지 바로 가기</p>
                        <p className="mt-0.5 text-[10px] text-sky-900">
                          현재 화면이 아니어도 해당 문항을 저장했을 때의 페이지로 이동합니다.
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {queuedProblems.map((item) => {
                            const p = getPdfPageFromQueuedProblem(item);
                            return (
                              <button
                                key={`jump-${item.id}`}
                                type="button"
                                disabled={p === null}
                                onClick={() => p !== null && void navigateToQuestionPdfPage(p)}
                                className="rounded border border-sky-600 bg-white px-2 py-1 text-[11px] font-semibold text-sky-900 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {item.questionNo}번 → {p ?? "?"}페이지
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
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
                  문제 박스 모드: 드래그로 영역을 추가합니다. 박스 1개는 해설 API 1회당 한 문항에 대응합니다.
                  2번·5번만 골라 지정하고 가운데 번호는 건너뛰는 식으로 써도 됩니다(옆 칸이 비쳐도 박스 안 문항만 풉니다). 인접
                  문항이 섞이지 않게 잘라 주세요. 저장하면 해설 대기열에 포함됩니다.
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
                    className={`rounded-md border border-slate-300 bg-white px-3 py-2 text-sm ${
                      isCropOnlyUi ? "w-full" : "w-1/2"
                    }`}
                  >
                    이전: 시험지 선택
                  </button>
                  {!isCropOnlyUi && (
                    <button
                      onClick={goToStep3IfReady}
                      className="w-1/2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
                    >
                      다음: 해설 제작
                    </button>
                  )}
                </div>
                {isCropOnlyUi && (
                  <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50/90 p-3">
                    <p className="text-sm font-semibold text-emerald-950">
                      저장된 문항 ({queuedProblems.length}개)
                    </p>
                    <p className="mt-1 text-[11px] leading-snug text-emerald-900">
                      목록은 이 브라우저 탭 세션에만 유지됩니다. 아래 버튼으로 Drive 「작업완료」에 ZIP 한 개로 올릴 수 있습니다(.env에 OAuth·폴더 설정 필요).
                    </p>
                    {queuedProblems.length === 0 ? (
                      <p className="mt-2 text-xs text-emerald-800">
                        페이지를 저장하면 여기에 문항이 쌓입니다.
                      </p>
                    ) : (
                      <ul className="mt-2 max-h-52 space-y-1 overflow-y-auto text-xs text-emerald-950">
                        {queuedProblems.map((item, index) => {
                          const p = getPdfPageFromQueuedProblem(item);
                          return (
                            <li
                              key={item.id}
                              className="flex flex-wrap items-center justify-between gap-1 rounded bg-white px-2 py-1"
                            >
                              <span className="min-w-0 flex-1">
                                {index + 1}. {item.questionNo}번 ({item.pageLabel}
                                {isPdfSource && p !== null ? ` · ${p}페이지` : ""})
                              </span>
                              <div className="flex shrink-0 flex-wrap gap-1">
                                {isPdfSource && p !== null && (
                                  <button
                                    type="button"
                                    onClick={() => void navigateToQuestionPdfPage(p)}
                                    className="rounded border border-emerald-600 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-900 hover:bg-emerald-100"
                                  >
                                    {p}p로
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => removeQueuedProblem(item.id)}
                                  className="rounded border border-emerald-300 px-2 py-0.5 text-[11px]"
                                >
                                  삭제
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {queuedProblems.length > 0 && (
                      <button
                        type="button"
                        disabled={isUploadingCropBundle}
                        onClick={() => void handleUploadCropBundleToDrive()}
                        className="mt-3 w-full rounded-md bg-violet-700 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        {isUploadingCropBundle
                          ? "Drive 업로드 중..."
                          : "작업완료 폴더에 ZIP 묶음 업로드"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {!isCropOnlyUi && currentStep >= 3 && (
              <>
            <div className="rounded-md border border-violet-200 bg-violet-50 p-3">
              <p className="text-sm font-semibold text-violet-900">
                해설 대기열 ({queuedProblems.length})
              </p>
              {queuedProblems.length === 0 ? (
                <p className="mt-2 text-xs text-violet-700">
                  문제 박스를 저장하면 해설 대기열에 항목이 추가됩니다.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-xs text-violet-900">
                  {queuedProblems.map((item, index) => {
                    const p = getPdfPageFromQueuedProblem(item);
                    return (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-center justify-between gap-1 rounded bg-white px-2 py-1"
                      >
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                          <span className="truncate">
                            {index + 1}. {item.questionNo}번 ({item.pageLabel})
                          </span>
                          {isPdfSource && p !== null && (
                            <button
                              type="button"
                              onClick={() => void navigateToQuestionPdfPage(p)}
                              className="shrink-0 rounded border border-violet-500 bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-800 hover:bg-violet-100"
                            >
                              {p}페이지로
                            </button>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeQueuedProblem(item.id)}
                          className="rounded border border-violet-300 px-2 py-0.5 text-[11px]"
                        >
                          삭제
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {isPdfSource && queuedProblems.length > 0 && (
                <button
                  type="button"
                  onClick={applyExcludeKeepOnlySavedQuestionPages}
                  disabled={isBatchGenerating}
                  className="mt-2 w-full rounded-md border border-amber-700 bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-950 hover:bg-amber-200 disabled:opacity-45"
                >
                  저장 문항이 있는 페이지만 유지 · 나머지 PDF 제외
                </button>
              )}
              {queuedProblems.length > 0 && (
                <button
                  type="button"
                  disabled={isUploadingCropBundle || isBatchGenerating}
                  onClick={() => void handleUploadCropBundleToDrive()}
                  className="mt-2 w-full rounded-md border border-violet-500 bg-white px-3 py-2 text-sm font-semibold text-violet-900 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isUploadingCropBundle
                    ? "Drive 업로드 중..."
                    : "작업완료 폴더에 ZIP 묶음 업로드"}
                </button>
              )}
              <button
                onClick={runBatchGeneration}
                disabled={queuedProblems.length === 0 || isBatchGenerating}
                className="mt-3 w-full rounded-md bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isBatchGenerating ? "해설 제작 중..." : "해설 제작 실행"}
              </button>
            </div>

            {cardQuestionNos.length > 0 && (
              <div className="rounded-md border border-sky-200 bg-sky-50 p-3">
                <p className="text-sm font-semibold text-sky-900">문항 카드 편집</p>
                <p className="mt-1 text-xs text-sky-800">
                  자동 생성 후 카드를 눌러 빠른정답/해설 채택/메인 풀이 순서를 편집하세요.
                </p>
                {explanationGenerationBusy && (
                  <p className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900">
                    해설 제작 중에는 문항 카드·문항 선택·결과 목록에서 문항을 바꿀 수 없습니다. 완료 후
                    전환해 주세요.
                  </p>
                )}
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {cardQuestionNos.map((no) => {
                    const draft = questionCardDraftMap[no];
                    const selected = getSelectedVersionForQuestion(no);
                    const baseBody = draft?.explanationBody || selected?.explanationBody || "";
                    const methodCount = splitMethodBlocks(baseBody).methods.length;
                    const answerDisplay = normalizeQuickAnswerForDisplay(
                      draft?.quickAnswer || selected?.quickAnswer || "-",
                    );
                    const isActive = questionNo === no;
                    const cardProfileOverride = questionSolverProfileOverrides[no];
                    return (
                      <div
                        key={`card-q-${no}`}
                        className={`rounded border p-2 text-xs ${
                          isActive
                            ? "border-sky-600 bg-sky-600 text-white"
                            : "border-sky-300 bg-white text-slate-800"
                        }`}
                      >
                        <button
                          type="button"
                          disabled={explanationGenerationBusy}
                          onClick={() => openQuestionCard(no)}
                          className={`w-full text-left ${
                            explanationGenerationBusy ? "cursor-not-allowed opacity-60" : ""
                          }`}
                        >
                          <p className="font-semibold">{no}번 문항</p>
                          <p className="mt-1">빠른정답: {answerDisplay}</p>
                          <p className="mt-1">
                            해설: {methodCount <= 1 ? "단일" : `복수(${methodCount}개)`} /{" "}
                            {draft?.methodSelectionPolicy === "selected" ? "하나 선택" : "모두 반영"}
                          </p>
                          {cardProfileOverride && (
                            <p className="mt-1 text-[10px] opacity-90">
                              모델: {solverProfileLabel(cardProfileOverride)} (전역 덮어쓰기)
                            </p>
                          )}
                        </button>
                        <div
                          className={`mt-1 flex items-center gap-1 ${
                            isActive ? "text-white" : "text-slate-700"
                          }`}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <label className="shrink-0 text-[10px] font-semibold opacity-80">
                            모델
                          </label>
                          <select
                            value={cardProfileOverride ?? ""}
                            disabled={explanationGenerationBusy}
                            onChange={(event) => {
                              const v = event.target.value as SolverModelProfile | "";
                              setQuestionSolverProfileOverrides((prev) => {
                                const next = { ...prev };
                                if (!v) delete next[no];
                                else next[no] = v;
                                return next;
                              });
                            }}
                            className={`min-w-0 flex-1 rounded border px-1 py-0.5 text-[10px] ${
                              explanationGenerationBusy ? "cursor-not-allowed opacity-70" : ""
                            } ${
                              isActive
                                ? "border-sky-400 bg-white text-slate-900"
                                : "border-slate-300 bg-white"
                            }`}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <option value="">전역</option>
                            <option value="easy">쉬운</option>
                            <option value="balanced">균형</option>
                            <option value="killer">킬러</option>
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <p className="text-sm font-semibold text-slate-800">현재 문항: {questionNo || "-"}</p>
              {questionNoOptions.length > 0 && (
                <div className="mt-2">
                  <label className="text-[11px] font-semibold text-slate-600">문항 선택</label>
                  <select
                    value={questionNo}
                    disabled={explanationGenerationBusy}
                    onChange={(event) => openQuestionCard(event.target.value)}
                    className={`mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs ${
                      explanationGenerationBusy ? "cursor-not-allowed opacity-70" : ""
                    }`}
                  >
                    {questionNoOptions.map((item) => (
                      <option key={`q-opt-${item}`} value={item}>
                        {item}번
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {questionNo && (
                <div className="mt-2 rounded border border-slate-200 bg-white p-2">
                  <label className="text-[11px] font-semibold text-slate-600">
                    이 문항만 모델 프로필 (전역 덮어쓰기)
                  </label>
                  <select
                    value={questionSolverProfileOverrides[questionNo] ?? ""}
                    onChange={(event) => {
                      const v = event.target.value as SolverModelProfile | "";
                      setQuestionSolverProfileOverrides((prev) => {
                        const next = { ...prev };
                        if (!v) delete next[questionNo];
                        else next[questionNo] = v;
                        return next;
                      });
                    }}
                    className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  >
                    <option value="">
                      전역과 동일 ({solverProfileLabel(solverModelProfile)})
                    </option>
                    <option value="easy">{solverProfileLabel("easy")}</option>
                    <option value="balanced">{solverProfileLabel("balanced")}</option>
                    <option value="killer">{solverProfileLabel("killer")}</option>
                  </select>
                  <p className="mt-1 text-[10px] text-slate-500">
                    적용: {solverProfileLabel(effectiveSolverProfileForCurrentQuestion)}
                    {questionSolverProfileOverrides[questionNo] ? " · 이 문항 전용" : " · 전역"}
                  </p>
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
                  풀이 방법 채택 (DOCX 반영)
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
                    해설 하나만 넣기(카드에서 1개 선택)
                  </label>
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  채택한 방법만 우측 미리보기와 DOCX 저장에 반영됩니다.
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  메인해설(별표)로 지정한 방법이 항상 가장 위(1번째)에 배치됩니다.
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
                              if (methodSelectionPolicy === "selected") {
                                setSelectedMethodIndexes([index]);
                              } else {
                                setSelectedMethodIndexes((prev) =>
                                  [...prev, index].sort((a, b) => a - b),
                                );
                              }
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
                        <span className="line-clamp-3 block text-[11px] leading-snug [&_.katex]:text-[11px]">
                          {renderWithMath(method.split("\n").slice(0, 4).join("\n"))}
                        </span>
                      </label>
                      <button
                        type="button"
                        onClick={() => {
                          if (methodSelectionPolicy === "selected") {
                            setSelectedMethodIndexes([index]);
                          } else if (!selectedMethodIndexes.includes(index)) {
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
                        {representativeMethodIndex === index ? "★ 메인해설" : "☆ 메인으로"}
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
              {isGenerating ? "선택 문항 재생성 중..." : "선택 문항 수동 재생성 (한 문제)"}
            </button>

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
                실행 설정 (텍스트 입력/상세 옵션)
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
                  <div className="mt-2 rounded-md border border-indigo-200 bg-indigo-50 p-2">
                    <p className="text-xs font-semibold text-indigo-900">문제풀이 모델 프로필</p>
                    <p className="mt-1 text-[11px] text-indigo-800">
                      학년 고정 대신 문제 난이도 성향에 맞춰 모델 우선순위를 선택합니다.
                    </p>
                    <label className="mt-2 flex items-center gap-2 text-xs text-indigo-900">
                      <input
                        type="radio"
                        name="solverModelProfile"
                        checked={solverModelProfile === "easy"}
                        onChange={() => setSolverModelProfile("easy")}
                      />
                      쉬운 문제 특화 (속도/안정)
                    </label>
                    <label className="mt-1 flex items-center gap-2 text-xs text-indigo-900">
                      <input
                        type="radio"
                        name="solverModelProfile"
                        checked={solverModelProfile === "balanced"}
                        onChange={() => setSolverModelProfile("balanced")}
                      />
                      균형형 (기본 권장)
                    </label>
                    <label className="mt-1 flex items-center gap-2 text-xs text-indigo-900">
                      <input
                        type="radio"
                        name="solverModelProfile"
                        checked={solverModelProfile === "killer"}
                        onChange={() => setSolverModelProfile("killer")}
                      />
                      킬러 문제 특화 (고난도 정밀)
                    </label>
                    <p className="mt-2 text-[11px] text-indigo-800">
                      문항별로만 다르게 쓰려면 아래 「현재 문항」또는 문항 카드의 「모델」에서 덮어쓰기를 지정하세요.
                    </p>
                  </div>
                  <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] leading-relaxed text-amber-950">
                    <span className="font-semibold">1차 Gemini 후보 env:</span>{" "}
                    <code className="rounded bg-white px-1 font-mono text-[10px] text-slate-800">
                      {resolvedGeminiGenerateEnvKey}
                    </code>
                    . 모든 키에 같은 모델을 두면 모드·프로필만 바꿔도 결과는 같을 수 있습니다. 교차검증은{" "}
                    <code className="font-mono text-[10px]">EXPLANATION_CROSS_VERIFY</code>
                    로 켜며 추가 호출 비용이 있습니다.
                  </p>
                  <label className="mt-2 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={includeDiagramExplanation}
                      onChange={(event) => setIncludeDiagramExplanation(event.target.checked)}
                    />
                    그림/도형 해설 포함
                  </label>
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
                <p className="font-semibold text-slate-800">해설 제작 결과</p>
                <ul className="mt-2 space-y-1">
                  {batchResults.map((result, index) => (
                    <li key={`${result.questionNo}-${index}`}>
                      <button
                        type="button"
                        disabled={explanationGenerationBusy}
                        onClick={() => openQuestionCard(result.questionNo)}
                        className={`w-full rounded px-2 py-1 text-left ${
                          explanationGenerationBusy
                            ? "cursor-not-allowed bg-slate-100 text-slate-500"
                            : "bg-slate-50 hover:bg-slate-100"
                        }`}
                      >
                        {result.questionNo}번 - {result.status === "success" ? "성공" : "실패"} / 빠른정답:{" "}
                        {normalizeQuickAnswerForDisplay(result.quickAnswer)} / {result.message}
                      </button>
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
          {isCropOnlyUi && currentStep === 2 && sourceImage ? (
            <div className="sticky top-4 space-y-3">
              <p className="text-sm font-semibold text-slate-800">전체 페이지 보기</p>
              <p className="text-xs text-slate-600">
                좌측 패널에서 박스 크롭을 지정합니다. 여기서는 레이아웃·작은 글씨 확인용입니다.
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sourceImage}
                alt="현재 시험지 페이지"
                className="max-h-[min(85vh,900px)] w-full rounded-md border border-slate-200 bg-white object-contain shadow-sm"
              />
            </div>
          ) : isCropOnlyUi && currentStep === 1 ? (
            <div className="rounded-md border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
              <p className="text-sm">시험지를 선택한 뒤 「영역 지정」으로 넘어가면</p>
              <p className="mt-2 text-xs">이쪽에 페이지 전체가 크게 표시되어 크롭 작업을 보조합니다.</p>
            </div>
          ) : !isCropOnlyUi && currentStep !== 3 ? (
            <div className="rounded-md border border-dashed border-slate-300 bg-white p-8 text-center text-slate-500">
              <p className="text-sm">3단계(해설 제작)에서 해설 미리보기가 표시됩니다.</p>
              <p className="mt-2 text-xs">
                지금은 좌측에서 시험지 선택과 문제 영역 지정을 먼저 진행하세요.
              </p>
            </div>
          ) : !isCropOnlyUi && currentStep === 3 ? (
            <>
              {!hasGeneratedResult && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-5 text-center text-amber-900">
                  <p className="text-sm font-semibold">아직 해설이 생성되지 않았습니다.</p>
                  <p className="mt-1 text-xs">
                    좌측에서 `해설 제작 실행`을 먼저 눌러 문항 카드를 생성해 주세요.
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

                  {currentQuestionExplanationReady ? (
                    <>
                      <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 p-3">
                        <p className="text-xs font-semibold text-slate-700">해설 선택 카드</p>
                        {methodBlocks.methods.length > 0 ? (
                          <div className="mt-2 space-y-2">
                            {methodBlocks.methods.map((method, index) => (
                              <div
                                key={`right-method-card-${index}`}
                                className="flex items-start justify-between gap-2 rounded border border-slate-200 bg-white px-2 py-2"
                              >
                                <label className="flex flex-1 items-start gap-2 text-[12px] text-slate-700">
                                  <input
                                    type="checkbox"
                                    disabled={explanationGenerationBusy}
                                    checked={
                                      methodSelectionPolicy === "all"
                                        ? true
                                        : selectedMethodIndexes.includes(index)
                                    }
                                    onChange={(event) => {
                                      if (methodSelectionPolicy === "all") {
                                        if (!event.target.checked) {
                                          setMethodSelectionPolicy("selected");
                                          setSelectedMethodIndexes(
                                            methodBlocks.methods
                                              .map((_, idx) => idx)
                                              .filter((idx) => idx !== index),
                                          );
                                        }
                                        return;
                                      }
                                      if (event.target.checked) {
                                        setSelectedMethodIndexes((prev) =>
                                          [...new Set([...prev, index])].sort((a, b) => a - b),
                                        );
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
                                  <span className="line-clamp-3 block text-[11px] leading-snug [&_.katex]:text-[11px]">
                          {renderWithMath(method.split("\n").slice(0, 4).join("\n"))}
                        </span>
                                </label>
                                <button
                                  type="button"
                                  disabled={explanationGenerationBusy}
                                  onClick={() => {
                                    if (methodSelectionPolicy === "selected") {
                                      if (!selectedMethodIndexes.includes(index)) {
                                        setSelectedMethodIndexes((prev) =>
                                          [...new Set([...prev, index])].sort((a, b) => a - b),
                                        );
                                      }
                                    }
                                    setRepresentativeMethodIndex(index);
                                  }}
                                  className={`shrink-0 rounded px-2 py-0.5 text-[11px] ${
                                    representativeMethodIndex === index
                                      ? "bg-amber-100 text-amber-800"
                                      : "border border-slate-300 bg-white text-slate-600"
                                  }`}
                                >
                                  {representativeMethodIndex === index ? "★ 메인해설" : "☆ 메인으로"}
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="mt-2 rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                            단일 해설 문항입니다. 이 해설이 자동으로 메인해설로 사용됩니다.
                          </div>
                        )}
                      </div>

                      <div className="mb-6 rounded-md border-2 border-blue-400 bg-blue-50 p-4">
                        <p className="text-sm font-semibold text-blue-900">[빠른 정답 체크]</p>
                        <p className="mt-2 text-2xl font-bold tracking-wide text-blue-950">
                          {quickAnswer}
                        </p>
                      </div>

                      <article
                        key={`explanation-preview-${questionNo}`}
                        className="newspaper-columns text-[15px] leading-7 text-slate-800"
                      >
                        {renderMethodBlocks(selectedExplanationBody)}
                      </article>
                    </>
                  ) : explanationGenerationBusy ? (
                    <div className="rounded-md border border-sky-300 bg-sky-50 p-10 text-center text-sky-900">
                      <p className="text-base font-semibold">해설 생성 중입니다</p>
                      <p className="mt-2 text-sm text-sky-800">
                        {questionNo ? `${questionNo}번 문항` : "선택 문항"}의 해설을 준비하고 있습니다.
                        잠시만 기다려 주세요.
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-md border border-slate-300 bg-slate-50 p-10 text-center text-slate-700">
                      <p className="text-base font-semibold">이 문항의 해설이 아직 없습니다</p>
                      <p className="mt-2 text-sm text-slate-600">
                        해설 제작이 끝난 뒤에도 보이지 않으면, 해당 문항 생성이 실패했을 수 있습니다.
                        좌측 결과 목록을 확인하거나 문항을 다시 생성해 주세요.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : null}

          {!isCropOnlyUi && currentStep === 3 && exportDocEntriesForSave.length > 0 && (
            <div className="mt-4 grid grid-cols-1 gap-3">
              <div
                className={`rounded-md border px-3 py-2 text-xs ${
                  exportGatePreview.ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                    : "border-amber-200 bg-amber-50 text-amber-950"
                }`}
              >
                <p className="font-semibold">내보내기 전 점검 (저장 시 자동 정리·보정 반영 기준)</p>
                {exportGatePreview.ok ? (
                  <p className="mt-1">
                    규칙 통과 예상입니다. 내보내기 시 $…$ 수식은 평문(√ 등)으로 바꾼 뒤 검증합니다.
                  </p>
                ) : (
                  <>
                    <p className="mt-1 font-medium">
                      아래를 수정하면 저장이 막히지 않습니다. (자동 보정으로 일부 해결될 수 있습니다.)
                    </p>
                    <ul className="mt-2 list-inside list-disc space-y-0.5">
                      {exportGatePreview.issues.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
              <button
                onClick={handleSaveCurrentDocx}
                disabled={cardQuestionNos.length === 0 || isExportChecking}
                className="w-full rounded-md bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isExportChecking ? "내보내기 전 규칙 검증 중..." : "해설 제작 (DOCX)"}
              </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
