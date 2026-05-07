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
import { useRef, useState } from "react";
import ReactCrop, { type Crop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

type ParsedExplanation = {
  answer: string;
  explanation_steps: { text: string; equation: string }[];
  summary?: string;
};

type CropEntry = {
  id: string;
  questionNo: string;
  pageLabel: string;
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
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [crops, setCrops] = useState<CropEntry[]>([]);
  const [model, setModel] = useState<"gemini" | "openai">("openai"); // 비용 절감 — 기본 OpenAI
  const [autoNo, setAutoNo] = useState(1); // 새 크롭 자동 번호

  async function handleFile(file: File) {
    setLoadingFile(true);
    setSources([]);
    setActivePage(0);
    setCrop(undefined);
    setCompletedCrop(null);
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

  function addCropFromSelection() {
    const src = sources[activePage];
    const sel = completedCrop;
    if (!src || !sel || !imgRef.current || sel.width < 10 || sel.height < 10) {
      alert("드래그로 영역을 선택한 뒤 추가하세요.");
      return;
    }
    const imageEl = imgRef.current;
    const scaleX = imageEl.naturalWidth / imageEl.width;
    const scaleY = imageEl.naturalHeight / imageEl.height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sel.width * scaleX);
    canvas.height = Math.round(sel.height * scaleY);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(
      imageEl,
      sel.x * scaleX,
      sel.y * scaleY,
      sel.width * scaleX,
      sel.height * scaleY,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    const dataUrl = canvas.toDataURL("image/png");
    const id = `crop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setCrops((prev) => [
      ...prev,
      {
        id,
        questionNo: String(autoNo),
        pageLabel: src.pageLabel,
        imageDataUrl: dataUrl,
        imageMimeType: "image/png",
        parsed: null,
        status: "idle",
      },
    ]);
    setAutoNo((n) => n + 1);
    setCompletedCrop(null);
    setCrop(undefined);
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
        <label className="mt-3 block text-xs font-semibold text-slate-700">
          시험지 파일 (PDF / 이미지)
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
              페이지 선택 · {sources.length}쪽
            </div>
            <button
              onClick={addCropFromSelection}
              disabled={!completedCrop}
              className="rounded-md border border-emerald-700 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="드래그로 선택한 영역을 크롭 목록에 추가"
            >
              ➕ 이 영역을 문항 {autoNo}번으로 추가
            </button>
          </div>
          {sources.length > 1 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {sources.map((s, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setActivePage(i);
                    setCrop(undefined);
                    setCompletedCrop(null);
                  }}
                  className={`rounded px-2 py-1 text-[11px] font-semibold ${
                    i === activePage
                      ? "bg-indigo-700 text-white"
                      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {s.pageLabel}
                </button>
              ))}
            </div>
          )}
          {activeSrc && (
            <div className="overflow-auto rounded border border-slate-200 bg-slate-50 p-2">
              <ReactCrop
                crop={crop}
                onChange={(_, percentCrop) => setCrop(percentCrop)}
                onComplete={(c) => setCompletedCrop(c)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={activeSrc.dataUrl}
                  alt={activeSrc.pageLabel}
                  className="max-w-full"
                  style={{ display: "block" }}
                />
              </ReactCrop>
            </div>
          )}
          <p className="mt-2 text-[11px] text-slate-500">
            💡 마우스로 문제 영역을 드래그한 뒤 위 「추가」 버튼을 누르세요. 한 페이지에서 여러
            문항을 차례로 추가할 수 있습니다.
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
