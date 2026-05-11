"use client";

/**
 * src/app/crop/page.tsx
 * ────────────────────────────────────────────────────────────────────────────
 *  크롭 탭 — 시험지 PDF/이미지에서 필요한 문항만 잘라 OCR/풀이.
 *
 *  목적: Gemini API 비용 절감.
 *   - 전체 시험지 OCR (수십 페이지) 대신 1~2 문항만 잘라 보내면 토큰 사용량이
 *     20~50배 줄어듦. 한도 임박·테스트 단계에서 유용.
 *
 *  흐름:
 *   1) PDF / 이미지 파일 업로드 (PDF 는 페이지별 캔버스 렌더 후 선택)
 *   2) 마우스로 영역 드래그 → 크롭 추가 (여러 개 가능)
 *   3) 각 크롭에 문항 번호 / 시험명 입력
 *   4) "이 크롭으로 해설 제작" → /api/auto-pipeline 에 cropped image 전송
 *
 *  의존성: react-image-crop (이미 설치됨), pdfjs-dist (이미 설치됨)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ReactCrop, { type Crop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import {
  readSharedOptions,
  writeSharedOptions,
  SHARED_OPTIONS_DEFAULT,
} from "@/lib/explanationOptions";
import { ExplanationMarkdownMath } from "@/components/ExplanationMarkdownMath";

type ParsedExplanation = {
  answer: string;
  explanation_steps: { text: string; equation: string }[];
  summary?: string;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  size: number | null;
};

/** 자연(원본) 픽셀 좌표의 박스 — 페이지 이미지 위에서의 크롭 영역. */
type NaturalBox = { x: number; y: number; width: number; height: number };

type CropEntry = {
  id: string;
  questionNo: string;
  /** 어느 page (sources index) 에 속한 크롭인지 */
  pageIdx: number;
  pageLabel: string;
  /** 이미지 자연 픽셀 좌표 — overlay 위치·이동·재추출의 진실 소스 */
  naturalBox: NaturalBox;
  /** 이 박스 영역만 캔버스로 잘라낸 결과(미리보기·풀이 호출용). 박스 이동 시 재생성. */
  imageDataUrl: string;
  imageMimeType: string;
  /** 풀이 결과 — 처리 전엔 null */
  parsed: ParsedExplanation | null;
  status: "idle" | "processing" | "done" | "error";
  error?: string;
  /** 풀이 결과 영속화 ID — Supabase 에 기록된 row. 피드백 저장에 사용. */
  runId?: string | null;
  /** 사용자 피드백 (1~5 별점 + 메모) — 다음 풀이 호출에 반영됨 */
  rating?: number | null;
  feedbackNote?: string;
  feedbackSaving?: boolean;
  feedbackSaved?: boolean;
  /** OCR 결과 텍스트 — 품질 감지·디버깅에 사용 (서버 응답의 questionText 보관) */
  extractedText?: string;
  /** 미리보기(KaTeX 렌더) 펼침 여부 */
  previewOpen?: boolean;
};

/**
 * OCR 결과 품질을 감지해 경고/액션을 제안.
 * 「LLM 답이 입력 이미지와 무관한 결과」가 반복되는 근본 원인은 거의 항상
 * OCR 단계에서 텍스트가 거의 추출되지 않았거나 (LLM 이 RAG 예시를 모방함),
 * 의미 없는 짧은 fragment 만 추출됐을 때다. 사람이 매번 검수하는 부담을
 * 줄이기 위해 클라이언트가 즉시 판정해 「다시 크롭」 액션을 제안한다.
 */
type OcrIssue = {
  level: "warn" | "high";
  reason: string;
  suggestion: string;
};

function detectOcrIssue(c: CropEntry): OcrIssue | null {
  if (c.status !== "done" || !c.parsed) return null;
  const text = (c.extractedText || "").trim();
  const answer = (c.parsed.answer || "").trim();

  // 비전 모드는 OCR 단계 자체를 건너뛰므로 questionText 가 placeholder
  // ("[비전 직접 풀이] 이미지 입력") 로 옴 — 이 경우 OCR 길이/수식 비율 룰은
  // 의미가 없으니 skip. AI 답변 자체에 대한 룰만 적용.
  const isVisionRun = text.startsWith("[비전 직접 풀이]") || text.startsWith("[vision");

  // 1) OCR 텍스트가 너무 짧음 — 거의 확실히 인식 실패 (OCR 모드만 적용)
  if (!isVisionRun && text.length > 0 && text.length < 30) {
    return {
      level: "high",
      reason: `OCR 텍스트가 ${text.length}자로 매우 짧음`,
      suggestion: "크롭 영역을 더 크게 (문제 본문 + 보기 ①~⑤ 모두 포함) 다시 잡아주세요.",
    };
  }

  // 2) 수식·숫자가 거의 없음 — 수학 문제는 거의 항상 숫자/연산자 포함 (OCR 모드만)
  if (!isVisionRun && text.length >= 30) {
    const mathChars = (text.match(/[0-9+\-=×÷·()²³⁴⁵√∫∑∞≤≥≠≈π×∂Δ]|\\frac|\\int|\\sum|\\sqrt/g) || []).length;
    const ratio = mathChars / text.length;
    if (ratio < 0.05) {
      return {
        level: "warn",
        reason: `OCR 텍스트에 수식/숫자가 거의 없음 (${Math.round(ratio * 100)}%)`,
        suggestion: "수학 문제인데 수식이 인식 안 됐습니다. 더 선명한 영역으로 다시 크롭하거나 Mathpix 잔여량을 확인하세요.",
      };
    }
  }

  // 3) LLM 이 「문제가 제공되지 않음」을 정직하게 답함
  const noInputPatterns = /확인\s*필요|주어지지\s*않|문제가\s*제공|정보\s*부족|내용이\s*없|주어진\s*내용은/;
  const firstStep = c.parsed.explanation_steps?.[0]?.text || "";
  if (noInputPatterns.test(answer) || noInputPatterns.test(firstStep)) {
    return {
      level: "high",
      reason: "AI가 「입력에서 문제를 찾지 못함」 으로 응답",
      suggestion: "OCR 이 본문 추출에 실패했습니다. 크롭 영역을 다시 잡고 「다시 풀이」를 눌러주세요.",
    };
  }

  // 4) 단계 수가 1~2 로 극단적으로 적음 + 답이 너무 단순 → 피상적 응답 의심
  if ((c.parsed.explanation_steps?.length ?? 0) <= 2 && answer.length <= 2) {
    return {
      level: "warn",
      reason: "풀이 단계가 매우 적고 답이 단순 — 피상적 응답일 수 있음",
      suggestion: "미리보기로 내용 확인 후, 의심되면 더 큰 크롭으로 다시 풀이를 권장합니다.",
    };
  }

  return null;
}

/** parsed 결과 → KaTeX 미리보기용 마크다운 본문 변환 */
function parsedToMarkdown(parsed: ParsedExplanation, questionNo: string): string {
  const head = questionNo ? `**[문항 ${questionNo}]**\n\n` : "";
  const ans = `**[정답]** ${parsed.answer}\n\n`;
  const steps = parsed.explanation_steps
    .map((s, i) => {
      const eq = s.equation ? `\n\n$$${s.equation}$$` : "";
      return `${i + 1}. ${s.text}${eq}`;
    })
    .join("\n");
  const summary = parsed.summary ? `\n\n**요약** ${parsed.summary}` : "";
  return `${head}${ans}**[해설]**\n\n${steps}${summary}`;
}

type SourceImage = {
  /** 원본(또는 PDF 한 페이지) data URL */
  dataUrl: string;
  pageLabel: string;
  /** PDF 일 때 페이지 번호 (1-based) */
  pdfPage?: number;
  width: number;
  height: number;
};

export default function CropPage() {
  const [examName, setExamName] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sources, setSources] = useState<SourceImage[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [loadingFile, setLoadingFile] = useState(false);
  const [crop, setCrop] = useState<Crop>();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [crops, setCrops] = useState<CropEntry[]>([]);
  // /auto 와 동일 옵션 — 모델·profile·topK·maxRetries 까지 사용자가 동기화된 상태로 사용.
  const [model, setModel] = useState<"gemini" | "openai">(SHARED_OPTIONS_DEFAULT.model);
  const [profile, setProfile] = useState<"auto" | "easy" | "balanced" | "killer">(
    SHARED_OPTIONS_DEFAULT.profile,
  );
  const [topK, setTopK] = useState<number>(SHARED_OPTIONS_DEFAULT.topK);
  const [maxRetries, setMaxRetries] = useState<number>(SHARED_OPTIONS_DEFAULT.maxRetries);
  /**
   * 비전 모드 — true 면 OCR(Mathpix) 단계를 건너뛰고 이미지를 Gemini Vision 에
   * 직접 전달해 한 번에 풀이. OCR 텍스트 누락으로 「입력과 무관한 풀이」 가
   * 나오는 사고를 근본적으로 피한다. localStorage 영속화 (기본 OFF — 안정화 후 ON 권장).
   */
  const [useVision, setUseVision] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const v = window.localStorage.getItem("highroad:crop:use-vision");
      if (v === "true") setUseVision(true);
    } catch {
      /* best-effort */
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("highroad:crop:use-vision", String(useVision));
    } catch {
      /* QuotaExceeded 등 — 조용히 무시 */
    }
  }, [useVision]);
  const pageContainerRef = useRef<HTMLDivElement | null>(null);
  /** 이미지 로드/리렌더 시 overlay 위치 다시 계산하도록 강제 — img 의 display 크기가 바뀌었을 때 */
  const [overlayTick, setOverlayTick] = useState(0);
  /** 다음 자동 부여 번호 미리보기 (UI 안내용) */
  const nextAutoNo = (() => {
    const used = crops
      .map((c) => Number.parseInt(c.questionNo, 10))
      .filter((n) => Number.isFinite(n));
    return (used.length > 0 ? Math.max(...used) : 0) + 1;
  })();

  // /inbox 에서 「크롭에서 이어서」 로 들어온 경우 — 시험명 prefill (마운트 시 1회)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = (params.get("examName") || "").trim();
      if (fromQuery) {
        setExamName((prev) => (prev.trim() ? prev : fromQuery));
        // URL 깔끔히 — 이후 새로고침에 다시 prefill 되지 않도록
        const url = new URL(window.location.href);
        url.searchParams.delete("examName");
        window.history.replaceState({}, "", url.toString());
      }
    } catch {
      /* best-effort */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 마운트 시 공유 옵션 1회 적용 — /auto 에서 가장 최근에 설정한 옵션을 그대로 사용.
  useEffect(() => {
    const opts = readSharedOptions();
    if (opts) {
      setModel(opts.model);
      setProfile(opts.profile);
      setTopK(opts.topK);
      setMaxRetries(opts.maxRetries);
    }
    // /auto 또는 다른 탭에서 옵션이 바뀌면 즉시 반영
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent).detail as ReturnType<typeof readSharedOptions>;
      if (!detail) return;
      setModel(detail.model);
      setProfile(detail.profile);
      setTopK(detail.topK);
      setMaxRetries(detail.maxRetries);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "highroad:explanation-options:v1") return;
      const opts = readSharedOptions();
      if (!opts) return;
      setModel(opts.model);
      setProfile(opts.profile);
      setTopK(opts.topK);
      setMaxRetries(opts.maxRetries);
    };
    window.addEventListener("highroad:options-changed", onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("highroad:options-changed", onCustom);
      window.removeEventListener("storage", onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 사용자가 옵션 바를 만질 때마다 공유 옵션에 즉시 반영(throttle 없음 — 옵션은 가벼움).
  useEffect(() => {
    writeSharedOptions({
      model,
      profile,
      topK,
      maxRetries,
      // /crop 자체에는 explanationMode 가 없으므로 default 'full' 유지(있을 시 보존).
      explanationMode: readSharedOptions()?.explanationMode ?? "full",
    });
  }, [model, profile, topK, maxRetries]);

  // 윈도우 리사이즈 → overlay 위치 재계산
  useEffect(() => {
    const onResize = () => setOverlayTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // 페이지 전환 시 overlay 다시 그리기
  useEffect(() => {
    setOverlayTick((t) => t + 1);
  }, [activePage]);

  // Google Drive 시험지 폴더 연동
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [driveStatus, setDriveStatus] = useState<
    "idle" | "loading" | "ready" | "no-config" | "error"
  >("idle");
  const [driveError, setDriveError] = useState<string | null>(null);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [drivePicking, setDrivePicking] = useState(false);

  const loadDriveFiles = useCallback(async () => {
    setDriveStatus("loading");
    setDriveError(null);
    try {
      const res = await fetch("/api/drive/exams");
      const data = await res.json();
      if (data.configured === false) {
        setDriveStatus("no-config");
        setDriveError(data.reason ?? null);
        return;
      }
      if (!data.ok) {
        setDriveStatus("error");
        setDriveError(data.error ?? "Drive 목록 조회 실패");
        return;
      }
      setDriveFiles(Array.isArray(data.files) ? data.files : []);
      setDriveStatus("ready");
    } catch (e) {
      setDriveStatus("error");
      setDriveError((e as Error).message);
    }
  }, []);

  const pickDriveFile = useCallback(
    async (fileId: string) => {
      setDrivePicking(true);
      try {
        const res = await fetch("/api/drive/exams/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error ?? "Drive 파일 다운로드 실패");
        // base64 → Blob → File 객체로 변환 (handleFile 재사용)
        const bin = atob(data.fileData);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], data.fileName, { type: data.mimeType });
        setDrivePickerOpen(false);
        await handleFile(file);
      } catch (e) {
        alert(`Drive 가져오기 실패: ${(e as Error).message}`);
      } finally {
        setDrivePicking(false);
      }
    },
    // handleFile 은 클로저로 안정 — 의존성 비움
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  async function handleFile(file: File) {
    setLoadingFile(true);
    setSources([]);
    setActivePage(0);
    setCrop(undefined);
    try {
      if (file.type === "application/pdf") {
        const pages = await renderPdfToImages(file);
        setSources(pages);
      } else if (file.type.startsWith("image/")) {
        const dataUrl = await fileToDataUrl(file);
        const dim = await imageDimensions(dataUrl);
        setSources([{ dataUrl, pageLabel: file.name, width: dim.w, height: dim.h }]);
      } else {
        alert("지원 형식: PDF / PNG / JPG / WEBP");
      }
      setSourceFile(file);
      if (!examName.trim()) {
        const base = file.name.replace(/\.[a-z0-9]+$/i, "");
        setExamName(base);
      }
    } catch (e) {
      alert(`파일 처리 실패: ${(e as Error).message}`);
    } finally {
      setLoadingFile(false);
    }
  }

  /** 자연 좌표 박스 → 캔버스로 잘라 PNG dataUrl 반환 */
  function extractCropDataUrl(imageEl: HTMLImageElement, box: NaturalBox): string {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(box.width));
    canvas.height = Math.max(1, Math.round(box.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(
      imageEl,
      box.x,
      box.y,
      box.width,
      box.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas.toDataURL("image/png");
  }

  /** ReactCrop onComplete — 사용자가 마우스 떼면 자동으로 다음 번호 부여하고 추가. */
  function handleCropComplete(sel: PixelCrop) {
    if (sel.width < 10 || sel.height < 10 || !imgRef.current) return;
    const imageEl = imgRef.current;
    const src = sources[activePage];
    if (!src) return;
    const scaleX = imageEl.naturalWidth / imageEl.width;
    const scaleY = imageEl.naturalHeight / imageEl.height;
    const naturalBox: NaturalBox = {
      x: sel.x * scaleX,
      y: sel.y * scaleY,
      width: sel.width * scaleX,
      height: sel.height * scaleY,
    };
    const imageDataUrl = extractCropDataUrl(imageEl, naturalBox);
    if (!imageDataUrl) return;

    // 자동 번호 = 기존 번호들의 최댓값 + 1 (삭제로 인한 빈 번호는 채우지 않음)
    setCrops((prev) => {
      const usedNumbers = prev
        .map((c) => Number.parseInt(c.questionNo, 10))
        .filter((n) => Number.isFinite(n));
      const nextNo = (usedNumbers.length > 0 ? Math.max(...usedNumbers) : 0) + 1;
      const id = `crop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return [
        ...prev,
        {
          id,
          questionNo: String(nextNo),
          pageIdx: activePage,
          pageLabel: src.pageLabel,
          naturalBox,
          imageDataUrl,
          imageMimeType: "image/png",
          parsed: null,
          status: "idle",
        },
      ];
    });
    // 새 박스 그릴 수 있도록 ReactCrop 선택 영역 초기화
    setCrop(undefined);
  }

  /** 박스 이동/리사이즈 후 호출 — 자연 좌표 갱신 + 자른 이미지 재생성. */
  function updateCropBox(id: string, nextBox: NaturalBox) {
    if (!imgRef.current) return;
    const imageEl = imgRef.current;
    const newDataUrl = extractCropDataUrl(imageEl, nextBox);
    setCrops((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              naturalBox: nextBox,
              imageDataUrl: newDataUrl,
              // 이미 풀이된 박스를 옮기면 결과도 무효화 → idle 로 되돌림
              parsed: null,
              status: "idle",
              error: undefined,
            }
          : c,
      ),
    );
  }

  function removeCrop(id: string) {
    setCrops((prev) => prev.filter((c) => c.id !== id));
  }

  function updateCropNo(id: string, no: string) {
    setCrops((prev) => prev.map((c) => (c.id === id ? { ...c, questionNo: no } : c)));
  }

  /** 별점·메모를 Supabase 에 저장 — 다음 풀이 호출 프롬프트에 같은 문항 피드백이 반영됨 */
  async function saveFeedbackForCrop(entry: CropEntry) {
    if (!entry.runId) {
      alert("Supabase 영속화가 비활성화되어 있어 피드백을 저장할 수 없습니다. (auto_pipeline_runs 테이블·환경변수 확인)");
      return;
    }
    setCrops((prev) =>
      prev.map((c) => (c.id === entry.id ? { ...c, feedbackSaving: true } : c)),
    );
    try {
      const res = await fetch("/api/auto-pipeline/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: entry.runId,
          userRating: entry.rating ?? undefined,
          userFeedback: entry.feedbackNote || undefined,
        }),
      });
      const data = await res.json();
      setCrops((prev) =>
        prev.map((c) =>
          c.id === entry.id
            ? { ...c, feedbackSaving: false, feedbackSaved: !!data.ok }
            : c,
        ),
      );
    } catch {
      setCrops((prev) =>
        prev.map((c) =>
          c.id === entry.id ? { ...c, feedbackSaving: false, feedbackSaved: false } : c,
        ),
      );
    }
  }

  async function processCrop(entry: CropEntry) {
    setCrops((prev) =>
      prev.map((c) => (c.id === entry.id ? { ...c, status: "processing", error: undefined } : c)),
    );
    try {
      // dataUrl 에서 base64 부분만 추출
      const base64 = entry.imageDataUrl.split(",")[1] || "";
      // 비전 모드: OCR 단계 건너뛰고 이미지 → Gemini Vision 직접
      // 일반 모드: 이미지 → Mathpix/Gemini OCR → 텍스트 → RAG → LLM
      const endpoint = useVision ? "/api/auto-pipeline/vision" : "/api/auto-pipeline";
      const requestBody = useVision
        ? {
            examName: examName || undefined,
            questionNo: entry.questionNo,
            // 비전은 Gemini 만 — model 필드는 무시되지만 의도 명시
            model: "gemini",
            profile: profile === "auto" ? undefined : profile,
            fileData: base64,
            fileType: entry.imageMimeType,
          }
        : {
            examName: examName || undefined,
            questionNo: entry.questionNo,
            model,
            // /auto 와 동일 옵션 — 사용자가 「크롭만 다르고 나머지 동일」 동선을 가질 수 있게.
            profile: profile === "auto" ? undefined : profile,
            topK,
            maxRetries,
            fileData: base64,
            fileName: `crop_${entry.questionNo}.png`,
            fileType: entry.imageMimeType,
            // 크롭은 본질적으로 단일 문항 — explanationMode 는 의미 없음(서버는 단일 모드로 처리).
            explanationMode: "full",
          };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const data = await res.json();
      const row0 = data.runs?.[0];
      // 서버가 ok=false 로 응답할 때 진짜 원인 메시지를 끝까지 추출.
      //   1) data.error (top-level error string — invalid body 등)
      //   2) data.errors[0] (top-level errors 배열 첫 항목)
      //   3) row0.errors[0] (단일 문항 row 의 errors)
      //   4) row0.manualReviewChecklist[0] (검증기가 errors 대신 체크리스트로만 표시한 경우)
      //   5) parsed=null 이지만 모든 배열이 비어 있는 진짜 휑한 케이스
      //      → runId 가 있으면 /auto 로 가서 trace 확인 가능하다는 안내
      function extractError(): string {
        if (typeof data.error === "string" && data.error) return data.error;
        if (Array.isArray(data.errors) && data.errors[0]) return String(data.errors[0]);
        if (row0) {
          if (Array.isArray(row0.errors) && row0.errors[0]) return String(row0.errors[0]);
          if (Array.isArray(row0.manualReviewChecklist) && row0.manualReviewChecklist[0])
            return String(row0.manualReviewChecklist[0]);
          if (row0.parsed === null) {
            const tail = row0.runId
              ? ` (runId=${String(row0.runId).slice(0, 8)}… — 「자동에서 열기」로 trace 확인)`
              : "";
            return `풀이 결과가 비었습니다 (parsed=null, errors=[]).${tail}`;
          }
        }
        return `서버 ${res.status} — 진단 정보 없음`;
      }
      if (!res.ok || !data.ok) {
        throw new Error(extractError());
      }
      const row = row0 ?? data;
      setCrops((prev) =>
        prev.map((c) =>
          c.id === entry.id
            ? {
                ...c,
                status: "done",
                parsed: row.parsed ?? null,
                runId: row.runId ?? null,
                error: row.parsed ? undefined : (row.errors || []).join(" / "),
                // 새 풀이 도착 → 이전 피드백 상태 초기화
                feedbackSaved: false,
                // OCR 결과 텍스트 저장 — detectOcrIssue() · 미리보기 디버깅용
                extractedText: typeof row.questionText === "string" ? row.questionText : "",
                // 새 풀이가 도착하면 미리보기 자동 펼침 — 사용자가 즉시 KaTeX 렌더로 확인
                previewOpen: true,
              }
            : c,
        ),
      );
    } catch (e) {
      setCrops((prev) =>
        prev.map((c) =>
          c.id === entry.id ? { ...c, status: "error", error: (e as Error).message } : c,
        ),
      );
    }
  }

  async function processAll() {
    for (const c of crops.filter((c) => c.status === "idle")) {
      // eslint-disable-next-line no-await-in-loop
      await processCrop(c);
    }
  }

  /**
   * 성공한 크롭들로 묶음 다운로드를 수행한다.
   * format='hml' 이 메인(한컴 한글) — /auto 와 동일.
   * format='docx' 는 외부 공유·Drive 미리보기용 보조.
   */
  async function downloadAll(format: "hml" | "docx") {
    const successRuns = crops
      .filter((c) => c.parsed)
      .map((c) => ({
        questionNo: c.questionNo,
        // 잘라낸 이미지를 마크다운 이미지 라인으로 전달 → DOCX/HML 빌더가 dataURL 디코드해 임베드
        questionText: `![문제 원본 — ${c.pageLabel}](${c.imageDataUrl})`,
        parsed: c.parsed,
      }));
    if (successRuns.length === 0) {
      alert("성공한 크롭이 없습니다.");
      return;
    }
    const endpoint =
      format === "hml" ? "/api/auto-pipeline/hml" : "/api/auto-pipeline/docx";
    const labelUpper = format === "hml" ? "HWP/HML" : "DOCX";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        examName: examName || `크롭_해설지`,
        runs: successRuns,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`${labelUpper} 생성 실패: ${err.error ?? res.statusText}`);
      return;
    }
    const blob = await res.blob();
    // /auto 와 동일하게 서버가 content-disposition 으로 파일명 지정해 주면 그걸 우선 사용
    const cd = res.headers.get("content-disposition") ?? "";
    const filenameMatch = cd.match(/filename="?([^";]+)"?/);
    const fallback = `${examName || "크롭_해설지"}_${successRuns.length}q.${format}`;
    const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : fallback;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  // 호출 편의 wrapper — 버튼에서 직접 호출 시 가독성용
  const downloadHmlAll = () => downloadAll("hml");
  const downloadDocxAll = () => downloadAll("docx");

  const activeSrc = sources[activePage];

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-slate-900">✂️ 크롭으로 해설 제작</h1>
        <p className="mt-1 text-xs text-slate-600">
          시험지 PDF/이미지에서 <strong>필요한 문항만 잘라</strong> OCR·풀이합니다 — Gemini API 비용을
          최소 20배 이상 절약. 풀이 모델은 기본 Gemini 사용 (해설 자동 제작과 동일), OpenAI 는 보조.
        </p>
      </header>

      {/* 1단계: 파일 업로드 + 시험명 */}
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="block text-xs font-semibold text-slate-700">
            시험 이름
            <input
              type="text"
              value={examName}
              onChange={(e) => setExamName(e.target.value)}
              placeholder="예: 2026 모의고사 1회"
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal"
            />
          </label>
          <label className="block text-xs font-semibold text-slate-700">
            풀이 모델
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as "gemini" | "openai")}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal"
            >
              <option value="gemini">Gemini (권장 — 해설 자동 제작과 통일)</option>
              <option value="openai">OpenAI (보조 — Gemini 한도 초과 시)</option>
            </select>
          </label>
        </div>

        {/* 자동 해설 페이지와 공유되는 옵션 — 한쪽에서 바꾸면 다른쪽에도 즉시 적용 */}
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block text-xs font-semibold text-slate-700">
            난이도 라우팅 (profile)
            <select
              value={profile}
              onChange={(e) =>
                setProfile(e.target.value as "auto" | "easy" | "balanced" | "killer")
              }
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal"
              title="문항 난이도에 따라 모델·프롬프트 깊이를 다르게 — '자동' 권장"
            >
              <option value="auto">자동 (난이도 추정)</option>
              <option value="easy">쉬움 (저비용)</option>
              <option value="balanced">중간</option>
              <option value="killer">킬러 (심층)</option>
            </select>
          </label>
          <label className="block text-xs font-semibold text-slate-700">
            참고 예시 수 (topK)
            <input
              type="number"
              min={0}
              max={10}
              value={topK}
              onChange={(e) => setTopK(Math.max(0, Math.min(10, Number(e.target.value) || 0)))}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal"
              title="RAG 컨텍스트로 넣을 유사 문제·해설 개수 (3 권장, 0 이면 RAG 미사용)"
            />
          </label>
          <label className="block text-xs font-semibold text-slate-700">
            재시도 한도 (maxRetries)
            <input
              type="number"
              min={0}
              max={5}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Math.max(0, Math.min(5, Number(e.target.value) || 0)))}
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal"
              title="검증 실패 시 자동 재시도 횟수 (2 권장, 한도 보호 시 0~1)"
            />
          </label>
        </div>
        <p className="mt-1 text-[11px] text-slate-500">
          ↑ 「해설 제작」 탭과 자동 동기화되는 옵션입니다 — 한 곳에서 바꾸면 양쪽에 즉시 반영됩니다.
        </p>

        {/* 비전 모드 토글 — OCR 누락으로 「입력과 무관한 풀이」가 나오는 사고 방지 */}
        <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-2.5 text-xs">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={useVision}
              onChange={(e) => setUseVision(e.target.checked)}
              className="mt-0.5 h-4 w-4 cursor-pointer accent-emerald-600"
            />
            <div className="flex-1">
              <div className="font-semibold text-emerald-900">
                🔭 비전 모드 (Gemini Vision 직접 풀이){" "}
                <span className="ml-1 rounded bg-emerald-200 px-1.5 py-0.5 text-[10px] font-bold text-emerald-900">
                  추천
                </span>
              </div>
              <p className="mt-0.5 leading-snug text-emerald-800">
                OCR(Mathpix) 단계를 건너뛰고 이미지를 Gemini 가 직접 보고 풀이합니다.
                {" "}OCR 텍스트가 깨져서 「엉뚱한 풀이」가 나오는 사고를 근본적으로 방지.
                {useVision ? (
                  <span className="block mt-0.5 text-emerald-900 font-semibold">
                    ✓ 활성화 — 「이 크롭 풀이」 클릭 시 비전 엔드포인트로 호출됩니다.
                  </span>
                ) : (
                  <span className="block mt-0.5 text-emerald-700/70">
                    OFF — 기존 OCR + LLM 파이프라인 사용 (RAG·재시도 활용 가능).
                  </span>
                )}
              </p>
            </div>
          </label>
        </div>
        {/* Google Drive 「시험지」 폴더 — 로컬 업로드 위에 노출 */}
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <label className="block text-xs font-semibold text-slate-700">
              Google Drive 「시험지」 폴더에서 가져오기
            </label>
            <button
              type="button"
              onClick={() => {
                if (!drivePickerOpen && driveStatus !== "ready") loadDriveFiles();
                setDrivePickerOpen((v) => !v);
              }}
              className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              {drivePickerOpen ? "Drive 패널 닫기" : "Drive에서 가져오기"}
            </button>
          </div>
          {drivePickerOpen && (
            <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs">
              {driveStatus === "loading" && (
                <p className="text-emerald-900">목록 불러오는 중…</p>
              )}
              {driveStatus === "no-config" && (
                <p className="text-amber-900">
                  Drive 키 미설정 — Railway Variables 에 GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN
                  추가가 필요합니다.
                  {driveError ? ` (${driveError})` : ""}
                </p>
              )}
              {driveStatus === "error" && (
                <p className="text-rose-900">✗ {driveError ?? "Drive 오류"}</p>
              )}
              {driveStatus === "ready" && driveFiles.length === 0 && (
                <p className="text-slate-700">
                  「해설제작/시험지」 폴더가 비어 있습니다. PDF/이미지를 업로드하세요.
                </p>
              )}
              {driveStatus === "ready" && driveFiles.length > 0 && (
                <div className="space-y-1">
                  <p className="mb-1 text-emerald-900">최신순 {driveFiles.length}개:</p>
                  <ul className="max-h-48 overflow-y-auto divide-y divide-emerald-100 rounded border border-emerald-200 bg-white">
                    {driveFiles.map((f) => (
                      <li
                        key={f.id}
                        className="flex items-center justify-between gap-2 px-2 py-1"
                      >
                        <div className="flex-1 truncate">
                          <span className="font-semibold text-slate-800">{f.name}</span>
                          {f.size !== null && (
                            <span className="ml-2 text-slate-500">
                              {(f.size / 1024 / 1024).toFixed(1)}MB
                            </span>
                          )}
                          {f.modifiedTime && (
                            <span className="ml-2 text-slate-400">
                              {new Date(f.modifiedTime).toLocaleDateString("ko-KR")}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => pickDriveFile(f.id)}
                          disabled={drivePicking}
                          className="rounded border border-emerald-600 bg-white px-2 py-0.5 font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
                        >
                          {drivePicking ? "가져오는 중…" : "가져오기"}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={loadDriveFiles}
                    className="mt-1 text-emerald-800 underline"
                  >
                    목록 새로고침
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <label className="mt-3 block text-xs font-semibold text-slate-700">
          또는 시험지 파일 직접 업로드 (PDF / 이미지)
          <input
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
            className="mt-1 block w-full text-xs text-slate-700"
          />
        </label>
        {loadingFile && (
          <p className="mt-2 text-xs text-slate-600">파일 처리 중… (PDF 는 페이지마다 렌더링)</p>
        )}
      </section>

      {/* 2단계: 페이지 선택 + 크롭 */}
      {sources.length > 0 && (
        <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-semibold text-slate-700">
              페이지 {sources.length}쪽 · 이 페이지의 박스{" "}
              {crops.filter((c) => c.pageIdx === activePage).length}개
            </div>
            <span className="text-[11px] text-slate-500">
              마우스로 영역을 드래그하면 자동으로 다음 번호({nextAutoNo})로 추가됩니다.
            </span>
          </div>
          {sources.length > 1 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {sources.map((s, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setActivePage(i);
                    setCrop(undefined);
                  }}
                  className={`rounded px-2 py-1 text-[11px] font-semibold ${
                    i === activePage
                      ? "bg-indigo-700 text-white"
                      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {s.pageLabel}
                  {crops.some((c) => c.pageIdx === i) && (
                    <span className="ml-1 rounded-full bg-emerald-200 px-1.5 text-[10px] text-emerald-900">
                      {crops.filter((c) => c.pageIdx === i).length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          {activeSrc && (
            <div
              className="crop-canvas relative overflow-auto rounded border border-slate-200 bg-slate-50 p-2"
              ref={pageContainerRef}
            >
              <div className="relative inline-block">
                <ReactCrop
                  crop={crop}
                  onChange={(_, percentCrop) => setCrop(percentCrop)}
                  onComplete={handleCropComplete}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    ref={imgRef}
                    src={activeSrc.dataUrl}
                    alt={activeSrc.pageLabel}
                    className="block max-w-full"
                    onLoad={() => {
                      // 이미지 로드 후 overlay 가 정확한 비율로 다시 그려지도록 강제 리렌더
                      setOverlayTick((t) => t + 1);
                    }}
                  />
                </ReactCrop>
                {/* 기존 박스들을 overlay 로 표시 — 드래그로 이동, 핸들로 리사이즈, ✕ 로 삭제 */}
                {imgRef.current &&
                  crops
                    .filter((c) => c.pageIdx === activePage)
                    .map((c) => (
                      <CropBoxOverlay
                        key={c.id + ":" + overlayTick}
                        entry={c}
                        imageEl={imgRef.current!}
                        onCommit={(nextBox) => updateCropBox(c.id, nextBox)}
                        onDelete={() => removeCrop(c.id)}
                      />
                    ))}
              </div>
            </div>
          )}
          <p className="mt-2 text-[11px] text-slate-500">
            💡 영역 드래그 → 자동 번호 부여. 추가된 박스는 가운데를 잡고 드래그해 위치 조정,
            모서리 핸들로 크기 변경. ✕ 로 삭제. 다른 페이지에 가서도 계속 추가 가능합니다.
          </p>
        </section>
      )}

      {/* 3단계: 크롭 목록 + 풀이 */}
      {crops.length > 0 && (
        <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-900">
              크롭 목록 ({crops.length}) · 성공{" "}
              {crops.filter((c) => c.parsed).length}
            </h2>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={processAll}
                disabled={crops.every((c) => c.status !== "idle")}
                className="rounded-md border border-indigo-700 bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ▶ 모두 풀이
              </button>
              {/* HWP — 메인 포맷 (한컴 한글). /auto 와 동일하게 인디고 채움 버튼. */}
              <button
                onClick={downloadHmlAll}
                disabled={crops.filter((c) => c.parsed).length === 0}
                className="rounded-md border border-indigo-700 bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
                title="성공한 크롭들을 한 HWP/HML 파일로 묶어 다운로드 — 한컴 한글에서 바로 열림 (메인 포맷)"
              >
                📕 전체 HWP ({crops.filter((c) => c.parsed).length}문항)
              </button>
              {/* DOCX — 보조 포맷 (외부 공유·Drive 미리보기용). 흰 배경 outline 버튼. */}
              <button
                onClick={downloadDocxAll}
                disabled={crops.filter((c) => c.parsed).length === 0}
                className="rounded-md border border-slate-400 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                title="외부 공유·Google Drive 미리보기용 (보조 포맷). 학원 내부 작업은 HWP 권장"
              >
                DOCX ({crops.filter((c) => c.parsed).length})
              </button>
            </div>
          </div>
          <ul className="space-y-3">
            {crops.map((c) => (
              <li
                key={c.id}
                className="rounded-md border border-slate-200 bg-slate-50 p-3"
              >
                <div className="flex flex-wrap items-start gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.imageDataUrl}
                    alt={`크롭 ${c.questionNo}`}
                    className="max-h-40 max-w-[260px] rounded border border-slate-300 bg-white"
                  />
                  <div className="flex-1 space-y-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      <label className="font-semibold text-slate-700">문항 번호</label>
                      <input
                        value={c.questionNo}
                        onChange={(e) => updateCropNo(c.id, e.target.value)}
                        className="w-20 rounded border border-slate-300 px-2 py-0.5 text-sm"
                      />
                      <span className="text-slate-500">· {c.pageLabel}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => processCrop(c)}
                        disabled={c.status === "processing"}
                        className="rounded border border-indigo-600 bg-white px-2.5 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                      >
                        {c.status === "processing"
                          ? "처리 중…"
                          : c.status === "done"
                            ? "다시 풀이"
                            : "이 크롭 풀이"}
                      </button>
                      <button
                        onClick={() => removeCrop(c.id)}
                        className="rounded border border-rose-300 bg-white px-2 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50"
                      >
                        삭제
                      </button>
                      {/* runId 가 있는(=Supabase 영속화 성공한) 결과는 자동 페이지 풍부 검수 UI 로 이동 가능 */}
                      {c.parsed && c.runId && (
                        <a
                          href={`/auto?restoreRun=${encodeURIComponent(c.runId)}`}
                          className="rounded border border-slate-400 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                          title="자동 해설 페이지에서 풍부한 검수 패널·DOCX·재시도로 이어서 작업"
                        >
                          ↗ 자동에서 열기
                        </a>
                      )}
                      {c.status === "done" && c.parsed && (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-900">
                          ✓ 풀이 완료
                        </span>
                      )}
                      {c.status === "error" && (
                        <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-900">
                          ✗ {c.error?.slice(0, 80)}
                        </span>
                      )}
                    </div>
                    {/* OCR 품질 자동 감지 — 입력과 무관한 결과가 나오는 가장 큰 원인을 표면화 */}
                    {(() => {
                      const issue = detectOcrIssue(c);
                      if (!issue) return null;
                      const colorCls =
                        issue.level === "high"
                          ? "border-rose-300 bg-rose-50 text-rose-900"
                          : "border-amber-300 bg-amber-50 text-amber-900";
                      return (
                        <div className={`mt-2 rounded border ${colorCls} p-2 text-[11px]`}>
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold">
                              {issue.level === "high" ? "⚠️ 인식 문제 감지" : "ℹ️ 인식 의심"}
                            </span>
                            <span className="text-[10px] opacity-80">{issue.reason}</span>
                          </div>
                          <p className="mt-1">{issue.suggestion}</p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <button
                              onClick={() => processCrop(c)}
                              className="rounded border border-current bg-white px-2 py-0.5 text-[10px] font-semibold hover:bg-white/70"
                              title="현재 크롭으로 다시 풀이 (OCR 재시도)"
                            >
                              ↻ 다시 풀이
                            </button>
                            <button
                              onClick={() => removeCrop(c.id)}
                              className="rounded border border-current bg-white px-2 py-0.5 text-[10px] font-semibold hover:bg-white/70"
                              title="이 크롭 삭제 후 더 큰 영역으로 다시 잡기"
                            >
                              ✂ 삭제 → 다시 크롭
                            </button>
                            {c.extractedText !== undefined && (
                              <details className="ml-1">
                                <summary className="cursor-pointer text-[10px] font-semibold underline">
                                  OCR 결과 보기({c.extractedText.length}자)
                                </summary>
                                <pre className="mt-1 max-h-32 overflow-auto rounded bg-white/80 p-1.5 text-[10px] font-mono whitespace-pre-wrap break-words">
                                  {c.extractedText || "(빈 텍스트 — OCR 실패)"}
                                </pre>
                              </details>
                            )}
                          </div>
                        </div>
                      );
                    })()}

                    {/* 결과 미리보기 — KaTeX 로 수식 렌더 (\overline{...}, $...$ 등이 그림으로 보임) */}
                    {c.parsed && (
                      <div className="mt-2 rounded border border-indigo-200 bg-white p-2">
                        <div className="flex items-center gap-2 border-b border-slate-100 pb-1.5">
                          <span className="text-[11px] font-bold text-slate-700">
                            정답: {c.parsed.answer}
                          </span>
                          <span className="text-[10px] text-slate-500">
                            단계 {c.parsed.explanation_steps.length}
                          </span>
                          <button
                            onClick={() =>
                              setCrops((prev) =>
                                prev.map((x) =>
                                  x.id === c.id ? { ...x, previewOpen: !x.previewOpen } : x,
                                ),
                              )
                            }
                            className="ml-auto rounded border border-indigo-300 bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-100"
                          >
                            {c.previewOpen ? "▾ 미리보기 접기" : "▸ 미리보기"}
                          </button>
                        </div>
                        {c.previewOpen && (
                          <div className="mt-2">
                            <ExplanationMarkdownMath
                              source={parsedToMarkdown(c.parsed, c.questionNo)}
                              className="text-[13px] leading-6"
                            />
                            <details className="mt-2">
                              <summary className="cursor-pointer text-[10px] font-semibold text-slate-500 hover:text-slate-700">
                                📝 원본 텍스트 (디버깅용)
                              </summary>
                              <ol className="mt-1 list-decimal pl-4 text-[10px] text-slate-600">
                                {c.parsed.explanation_steps.map((s, i) => (
                                  <li key={i}>
                                    {s.text}
                                    {s.equation && (
                                      <span className="ml-1 text-slate-500">
                                        ({s.equation})
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ol>
                            </details>
                          </div>
                        )}
                      </div>
                    )}

                    {/* 피드백 패널 — 풀이 후 별점·메모 → 다음 호출 프롬프트에 반영 */}
                    {c.parsed && c.runId && (
                      <div className="mt-2 rounded border border-indigo-200 bg-indigo-50 p-2 text-[11px] text-indigo-950">
                        <p className="font-semibold">결과 피드백</p>
                        <div className="mt-1 flex items-center gap-1">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <button
                              key={n}
                              onClick={() =>
                                setCrops((prev) =>
                                  prev.map((x) =>
                                    x.id === c.id ? { ...x, rating: n, feedbackSaved: false } : x,
                                  ),
                                )
                              }
                              className={`h-6 w-6 rounded-full border text-xs font-bold ${
                                c.rating === n
                                  ? "border-indigo-700 bg-indigo-700 text-white"
                                  : "border-indigo-300 bg-white text-indigo-800 hover:bg-indigo-100"
                              }`}
                              title={`${n}점`}
                            >
                              {n}
                            </button>
                          ))}
                          <span className="ml-1 text-[10px] text-indigo-900">
                            1=재생성 · 5=그대로 사용
                          </span>
                        </div>
                        <textarea
                          value={c.feedbackNote ?? ""}
                          onChange={(e) =>
                            setCrops((prev) =>
                              prev.map((x) =>
                                x.id === c.id
                                  ? { ...x, feedbackNote: e.target.value, feedbackSaved: false }
                                  : x,
                              ),
                            )
                          }
                          placeholder="이 결과의 문제점·개선 메모 (선택, 객관식인데 단답으로 답함 등)"
                          rows={2}
                          className="mt-1 w-full rounded border border-indigo-200 bg-white p-1.5 text-[11px]"
                        />
                        <div className="mt-1 flex items-center gap-2">
                          <button
                            onClick={() => saveFeedbackForCrop(c)}
                            disabled={
                              c.feedbackSaving || (c.rating == null && !c.feedbackNote?.trim())
                            }
                            className="rounded border border-indigo-700 bg-indigo-700 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
                          >
                            {c.feedbackSaving ? "저장 중…" : "피드백 저장"}
                          </button>
                          {c.feedbackSaved && (
                            <span className="text-[10px] text-emerald-700">✓ 저장됨</span>
                          )}
                        </div>
                      </div>
                    )}
                    {c.parsed && !c.runId && (
                      <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-900">
                        Supabase 영속화 비활성 — 피드백은 auto_pipeline_runs 테이블이 있어야 저장됩니다.
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-4 text-[11px] text-slate-500">
        ✂️ 한 문항만 잘라 보내면 OCR 토큰이 거의 안 들어갑니다 (전체 시험지 대비 1/20 ~ 1/50). 비용
        한도가 임박했을 때 / 1~2 문항만 빠르게 처리하고 싶을 때 사용하세요.
      </p>

      {sourceFile && (
        <p className="mt-2 text-[11px] text-slate-400">
          업로드: {sourceFile.name} ({(sourceFile.size / 1024).toFixed(0)} KB)
        </p>
      )}
    </div>
  );
}

// ── 박스 overlay 컴포넌트 ────────────────────────────────────────────────
/**
 * 이미지 위에 절대 위치로 띄우는 크롭 박스.
 * - 본체 드래그 → 위치 이동
 * - 4 모서리 핸들 → 크기 조정
 * - ✕ → 삭제
 * 좌표는 imageEl 의 자연 픽셀 (naturalBox) 로 보관, 화면에는 display 크기 비율로 환산해 표시.
 * onCommit 은 마우스 떼는 순간(mouseup)에만 호출 — 드래그 중에는 시각적 위치만 업데이트.
 */
function CropBoxOverlay({
  entry,
  imageEl,
  onCommit,
  onDelete,
}: {
  entry: CropEntry;
  imageEl: HTMLImageElement;
  onCommit: (next: NaturalBox) => void;
  onDelete: () => void;
}) {
  const [box, setBox] = useState<NaturalBox>(entry.naturalBox);
  // entry 가 외부에서 갱신되면(다른 곳에서 박스 옮긴 등) 동기화
  useEffect(() => {
    setBox(entry.naturalBox);
  }, [entry.naturalBox]);

  const dispScaleX = imageEl.width / imageEl.naturalWidth;
  const dispScaleY = imageEl.height / imageEl.naturalHeight;
  const left = box.x * dispScaleX;
  const top = box.y * dispScaleY;
  const width = box.width * dispScaleX;
  const height = box.height * dispScaleY;

  function startDrag(
    e: React.MouseEvent,
    mode: "move" | "nw" | "ne" | "sw" | "se",
  ) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startBox = { ...box };
    const natScaleX = imageEl.naturalWidth / imageEl.width;
    const natScaleY = imageEl.naturalHeight / imageEl.height;

    function clampMove(next: NaturalBox): NaturalBox {
      const nW = imageEl.naturalWidth;
      const nH = imageEl.naturalHeight;
      const minSize = 10;
      let x = next.x;
      let y = next.y;
      let w = Math.max(minSize, next.width);
      let h = Math.max(minSize, next.height);
      x = Math.max(0, Math.min(nW - w, x));
      y = Math.max(0, Math.min(nH - h, y));
      // 리사이즈 결과가 이미지 경계를 넘지 않도록
      w = Math.min(w, nW - x);
      h = Math.min(h, nH - y);
      return { x, y, width: w, height: h };
    }

    function onMove(ev: MouseEvent) {
      const dx = (ev.clientX - startX) * natScaleX;
      const dy = (ev.clientY - startY) * natScaleY;
      let next: NaturalBox;
      if (mode === "move") {
        next = {
          x: startBox.x + dx,
          y: startBox.y + dy,
          width: startBox.width,
          height: startBox.height,
        };
      } else if (mode === "se") {
        next = {
          x: startBox.x,
          y: startBox.y,
          width: startBox.width + dx,
          height: startBox.height + dy,
        };
      } else if (mode === "ne") {
        next = {
          x: startBox.x,
          y: startBox.y + dy,
          width: startBox.width + dx,
          height: startBox.height - dy,
        };
      } else if (mode === "sw") {
        next = {
          x: startBox.x + dx,
          y: startBox.y,
          width: startBox.width - dx,
          height: startBox.height + dy,
        };
      } else {
        // nw
        next = {
          x: startBox.x + dx,
          y: startBox.y + dy,
          width: startBox.width - dx,
          height: startBox.height - dy,
        };
      }
      setBox(clampMove(next));
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // 마지막 상태로 commit (state 가 비동기라서 closure 의 최종값 잡기 위해 setBox 한 번 더 호출)
      setBox((curr) => {
        onCommit(curr);
        return curr;
      });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  const handleClassBase =
    "absolute h-3 w-3 rounded-sm border border-emerald-700 bg-white shadow";

  return (
    <div
      className="absolute z-20 box-border border-2 border-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/15"
      style={{
        left,
        top,
        width,
        height,
        cursor: "move",
      }}
      onMouseDown={(e) => startDrag(e, "move")}
    >
      {/* 번호 배지 */}
      <span className="absolute -left-1 -top-3 select-none rounded-md bg-emerald-700 px-1.5 py-0.5 text-[10px] font-bold text-white shadow">
        {entry.questionNo}번
      </span>
      {/* 삭제 */}
      <button
        type="button"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-rose-700 bg-white text-[11px] font-bold text-rose-700 shadow hover:bg-rose-50"
        title="이 박스 삭제"
      >
        ✕
      </button>
      {/* 4 모서리 리사이즈 핸들 */}
      <span
        className={`${handleClassBase} -left-1.5 -top-1.5 cursor-nwse-resize`}
        onMouseDown={(e) => startDrag(e, "nw")}
      />
      <span
        className={`${handleClassBase} -right-1.5 -top-1.5 cursor-nesw-resize`}
        onMouseDown={(e) => startDrag(e, "ne")}
      />
      <span
        className={`${handleClassBase} -bottom-1.5 -left-1.5 cursor-nesw-resize`}
        onMouseDown={(e) => startDrag(e, "sw")}
      />
      <span
        className={`${handleClassBase} -bottom-1.5 -right-1.5 cursor-nwse-resize`}
        onMouseDown={(e) => startDrag(e, "se")}
      />
    </div>
  );
}

// ── 헬퍼들 ────────────────────────────────────────────────────────────────

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error("파일 읽기 실패"));
    reader.readAsDataURL(file);
  });
}

async function imageDimensions(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("이미지 로드 실패"));
    img.src = dataUrl;
  });
}

/**
 * PDF → 페이지별 PNG dataUrl 배열.
 * pdfjs-dist 의 worker 를 dynamic import 로 로드해 SSR 충돌 방지.
 */
async function renderPdfToImages(file: File): Promise<SourceImage[]> {
  const pdfjs = await import("pdfjs-dist");
  // worker — pdfjs-dist 와 같은 버전의 CDN worker 를 사용 (브라우저 전용 경로)
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages: SourceImage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    // 1.8 배율 — 너무 크면 메모리·렌더 시간 증가
    const viewport = page.getViewport({ scale: 1.8 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas context 생성 실패");
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    pages.push({
      dataUrl: canvas.toDataURL("image/png"),
      pageLabel: `PDF ${i}p`,
      pdfPage: i,
      width: canvas.width,
      height: canvas.height,
    });
  }
  return pages;
}
