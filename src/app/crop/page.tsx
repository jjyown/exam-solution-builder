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
};

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
  const [model, setModel] = useState<"gemini" | "openai">("openai"); // 비용 절감 — 기본 OpenAI
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

  async function processCrop(entry: CropEntry) {
    setCrops((prev) =>
      prev.map((c) => (c.id === entry.id ? { ...c, status: "processing", error: undefined } : c)),
    );
    try {
      // dataUrl 에서 base64 부분만 추출
      const base64 = entry.imageDataUrl.split(",")[1] || "";
      const res = await fetch("/api/auto-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examName: examName || undefined,
          questionNo: entry.questionNo,
          model,
          fileData: base64,
          fileName: `crop_${entry.questionNo}.png`,
          fileType: entry.imageMimeType,
          explanationMode: "full",
          topK: 3,
          maxRetries: 1,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || data.errors?.[0] || `서버 ${res.status}`);
      }
      const row = data.runs?.[0] ?? data;
      setCrops((prev) =>
        prev.map((c) =>
          c.id === entry.id
            ? {
                ...c,
                status: "done",
                parsed: row.parsed ?? null,
                error: row.parsed ? undefined : (row.errors || []).join(" / "),
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

  async function downloadDocxAll() {
    const successRuns = crops
      .filter((c) => c.parsed)
      .map((c) => ({
        questionNo: c.questionNo,
        questionText: `(크롭 이미지 — ${c.pageLabel})`,
        parsed: c.parsed,
      }));
    if (successRuns.length === 0) {
      alert("성공한 크롭이 없습니다.");
      return;
    }
    const res = await fetch("/api/auto-pipeline/docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        examName: examName || `크롭_해설지`,
        runs: successRuns,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`DOCX 생성 실패: ${err.error ?? res.statusText}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${examName || "크롭_해설지"}_${successRuns.length}q.docx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const activeSrc = sources[activePage];

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-slate-900">✂️ 크롭으로 해설 제작</h1>
        <p className="mt-1 text-xs text-slate-600">
          시험지 PDF/이미지에서 <strong>필요한 문항만 잘라</strong> OCR·풀이합니다 — Gemini API 비용을
          최소 20배 이상 절약. 풀이 모델은 기본 OpenAI 사용 (Gemini 한도 보호).
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
              <option value="openai">OpenAI (권장 — Gemini 한도 보호)</option>
              <option value="gemini">Gemini</option>
            </select>
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
              className="relative overflow-auto rounded border border-slate-200 bg-slate-50 p-2"
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
            <div className="flex gap-2">
              <button
                onClick={processAll}
                disabled={crops.every((c) => c.status !== "idle")}
                className="rounded-md border border-indigo-700 bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ▶ 모두 풀이
              </button>
              <button
                onClick={downloadDocxAll}
                disabled={crops.filter((c) => c.parsed).length === 0}
                className="rounded-md border border-emerald-700 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                📄 전체 DOCX 다운로드
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
                    {c.parsed && (
                      <details className="mt-1 rounded bg-white p-2">
                        <summary className="cursor-pointer text-[11px] font-semibold text-slate-700">
                          정답: {c.parsed.answer} (단계 {c.parsed.explanation_steps.length})
                        </summary>
                        <ol className="mt-1 list-decimal pl-4 text-[11px] text-slate-700">
                          {c.parsed.explanation_steps.slice(0, 5).map((s, i) => (
                            <li key={i}>{s.text.slice(0, 200)}</li>
                          ))}
                        </ol>
                      </details>
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
