"use client";

/**
 * src/app/edit/page.tsx
 * ────────────────────────────────────────────────────────────────────────────
 *  시험지 편집 탭 — 「시험지 원안」(Drive) 또는 로컬 사진/스캔에서:
 *
 *  1) 여러 이미지 업로드 (Drive 「시험지 원안」 폴더 OR 로컬)
 *  2) 각 이미지에 페이지 번호 부여, 묶음 이름(시험명) 지정
 *  3) 영역 자르기 — 직접 드래그 OR Gemini 자동 검출 OR 기준 박스 모방
 *  4) 헤더에서 학교/연도/지역/과목/학년·학기 자동 추출 (한 줄 형식)
 *  5) 잘라낸 결과를 「시험지」 폴더에 PDF로 일괄 업로드 → 해설 제작 탭에서 사용
 *
 *  비용 보호:
 *   - GEMINI_OCR_DISABLED=true 면 AI 버튼들이 안내 메시지로 거절됨 (수동 가능)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ReactCrop, { type Crop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  size: number | null;
};

type NaturalBox = { x: number; y: number; width: number; height: number };

/** 편집 슬롯 — 한 장의 원본 이미지(또는 PDF 한 페이지)에 대응. */
type Slot = {
  id: string;
  /** 원본 dataUrl (PDF 한 페이지를 캔버스로 렌더한 결과 포함) */
  sourceDataUrl: string;
  sourceLabel: string;
  /** 사용자가 부여한 페이지 번호 — 출력 PDF 의 정렬 기준 */
  pageNo: number;
  /** 자연 좌표 박스 — 비어있으면 미설정. 자르기 결과 imageDataUrl 도 같이 보관 */
  naturalBox: NaturalBox | null;
  croppedDataUrl: string | null;
  /** Gemini 가 추출해 준 시험명 한 줄 — 「묶음 이름」으로 사용 가능 */
  suggestedName: string | null;
  /** AI 호출 진행 상태 */
  busy: null | "detecting" | "mimicking" | "naming" | "trashing";
  error?: string;
  /** Drive 「시험지 편집 전」 폴더에서 가져온 파일이면 그 fileId — 처리 끝난 후 휴지통으로 이동 가능 */
  driveFileId?: string;
  /** 이미 휴지통으로 이동되었으면 true (UI 상태 표시용) */
  trashed?: boolean;
};

const ACCEPTED_FILE_PATTERN = /\.(pdf|png|jpe?g|webp|heic|heif|gif)$/i;

export default function EditPage() {
  const [examName, setExamName] = useState(""); // 묶음(시험) 이름 — 출력 PDF 기본 파일명
  const [slots, setSlots] = useState<Slot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [savingToDrive, setSavingToDrive] = useState(false);
  const [saveResult, setSaveResult] = useState<
    null | { ok: true; link: string; name: string } | { ok: false; error: string }
  >(null);
  const [crop, setCrop] = useState<Crop>();
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Drive 「시험지 원안」 폴더
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [driveStatus, setDriveStatus] = useState<
    "idle" | "loading" | "ready" | "no-config" | "no-folder" | "error"
  >("idle");
  const [driveError, setDriveError] = useState<string | null>(null);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [drivePicking, setDrivePicking] = useState(false);

  const active = slots.find((s) => s.id === activeId) ?? null;

  // ── Drive 시험지 원안 ────────────────────────────────────────────────
  const loadDriveFiles = useCallback(async () => {
    setDriveStatus("loading");
    setDriveError(null);
    try {
      const res = await fetch("/api/drive/exam-originals");
      const data = await res.json();
      if (data.configured === false) {
        setDriveStatus("no-config");
        setDriveError(data.reason ?? null);
        return;
      }
      if (data.folderResolved === false) {
        setDriveStatus("no-folder");
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

  const pickDriveFile = useCallback(async (fileId: string) => {
    setDrivePicking(true);
    try {
      const res = await fetch("/api/drive/exam-originals/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "다운로드 실패");
      const bin = atob(data.fileData);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], data.fileName, { type: data.mimeType });
      // Drive 출처 표시 — driveFileId 를 슬롯에 보존해 나중에 「휴지통 이동」 가능
      await addFiles([{ file, driveFileId: fileId }]);
    } catch (e) {
      alert(`Drive 가져오기 실패: ${(e as Error).message}`);
    } finally {
      setDrivePicking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 파일 → Slot 추가 ────────────────────────────────────────────────
  async function addFiles(items: Array<{ file: File; driveFileId?: string }>) {
    setLoadingFile(true);
    try {
      const newSlots: Slot[] = [];
      for (const it of items) {
        const f = it.file;
        if (!ACCEPTED_FILE_PATTERN.test(f.name) && !f.type.startsWith("image/") && f.type !== "application/pdf") {
          continue;
        }
        if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
          const pages = await renderPdfToImages(f);
          for (const p of pages) {
            newSlots.push({
              id: makeId(),
              sourceDataUrl: p.dataUrl,
              sourceLabel: `${f.name} ${p.pageLabel}`,
              pageNo: 0,
              naturalBox: null,
              croppedDataUrl: null,
              suggestedName: null,
              busy: null,
              // PDF 원본은 Drive 한 파일이지만 페이지마다 슬롯이 됨 → fileId 동일하게 부여.
              // 한 페이지만 휴지통 이동은 의미 없음 → 모든 페이지 슬롯이 동일 fileId 공유.
              driveFileId: it.driveFileId,
            });
          }
        } else {
          const dataUrl = await fileToDataUrl(f);
          newSlots.push({
            id: makeId(),
            sourceDataUrl: dataUrl,
            sourceLabel: f.name,
            pageNo: 0,
            naturalBox: null,
            croppedDataUrl: null,
            suggestedName: null,
            busy: null,
            driveFileId: it.driveFileId,
          });
        }
      }
      setSlots((prev) => {
        const startNo =
          prev.reduce((m, s) => (s.pageNo > m ? s.pageNo : m), 0) || 0;
        const merged = [
          ...prev,
          ...newSlots.map((s, i) => ({ ...s, pageNo: startNo + i + 1 })),
        ];
        if (!activeId && merged.length > 0) setActiveId(merged[0].id);
        return merged;
      });
    } catch (e) {
      alert(`파일 처리 실패: ${(e as Error).message}`);
    } finally {
      setLoadingFile(false);
    }
  }

  function removeSlot(id: string) {
    setSlots((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
      return next;
    });
  }

  function reorderByPageNo() {
    setSlots((prev) => [...prev].sort((a, b) => a.pageNo - b.pageNo));
  }

  function setSlot(id: string, patch: Partial<Slot>) {
    setSlots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  // ── 자르기 (수동) ─────────────────────────────────────────────────────
  function captureCrop(imageEl: HTMLImageElement, box: NaturalBox): string {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(box.width));
    canvas.height = Math.max(1, Math.round(box.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(imageEl, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.92);
  }

  function handleCropComplete(sel: PixelCrop) {
    if (!active || !imgRef.current) return;
    if (sel.width < 10 || sel.height < 10) return;
    const imageEl = imgRef.current;
    const scaleX = imageEl.naturalWidth / imageEl.width;
    const scaleY = imageEl.naturalHeight / imageEl.height;
    const naturalBox: NaturalBox = {
      x: sel.x * scaleX,
      y: sel.y * scaleY,
      width: sel.width * scaleX,
      height: sel.height * scaleY,
    };
    const croppedDataUrl = captureCrop(imageEl, naturalBox);
    setSlot(active.id, { naturalBox, croppedDataUrl, error: undefined });
    setCrop(undefined);
  }

  // ── AI 박스 자동 검출 ─────────────────────────────────────────────────
  async function detectBoxForSlot(s: Slot): Promise<void> {
    setSlot(s.id, { busy: "detecting", error: undefined });
    try {
      const res = await fetch("/api/photo-edit/detect-box", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: s.sourceDataUrl }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "AI 박스 검출 실패");
      const box = data.box as { nx: number; ny: number; nw: number; nh: number };
      const dim = await imageDimensions(s.sourceDataUrl);
      const naturalBox: NaturalBox = {
        x: box.nx * dim.w,
        y: box.ny * dim.h,
        width: box.nw * dim.w,
        height: box.nh * dim.h,
      };
      const img = await loadImage(s.sourceDataUrl);
      const croppedDataUrl = captureCrop(img, naturalBox);
      setSlot(s.id, { naturalBox, croppedDataUrl, busy: null });
    } catch (e) {
      setSlot(s.id, { busy: null, error: (e as Error).message });
    }
  }

  async function detectAllBoxes() {
    setBulkBusy(true);
    try {
      for (const s of slots) {
        if (s.naturalBox) continue; // 이미 잡힌 건 건너뜀
        // eslint-disable-next-line no-await-in-loop
        await detectBoxForSlot(s);
      }
    } finally {
      setBulkBusy(false);
    }
  }

  // ── AI 박스 모방 (현재 슬롯 박스를 기준으로 나머지에 같은 의도 적용) ────
  async function mimicBoxFromActive() {
    if (!active?.naturalBox || !active?.croppedDataUrl) {
      alert("현재 페이지에 박스가 잡혀 있어야 합니다 (드래그 또는 AI 자동).");
      return;
    }
    const refImg = await loadImage(active.sourceDataUrl);
    const refBox = {
      nx: active.naturalBox.x / refImg.naturalWidth,
      ny: active.naturalBox.y / refImg.naturalHeight,
      nw: active.naturalBox.width / refImg.naturalWidth,
      nh: active.naturalBox.height / refImg.naturalHeight,
    };
    setBulkBusy(true);
    try {
      for (const s of slots) {
        if (s.id === active.id) continue;
        if (s.naturalBox) continue;
        setSlot(s.id, { busy: "mimicking", error: undefined });
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await fetch("/api/photo-edit/mimic-box", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              referenceImage: active.sourceDataUrl,
              referenceBox: refBox,
              targetImage: s.sourceDataUrl,
            }),
          });
          // eslint-disable-next-line no-await-in-loop
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || "박스 모방 실패");
          const tgtBox = data.box as { nx: number; ny: number; nw: number; nh: number };
          // eslint-disable-next-line no-await-in-loop
          const tgtImg = await loadImage(s.sourceDataUrl);
          const naturalBox: NaturalBox = {
            x: tgtBox.nx * tgtImg.naturalWidth,
            y: tgtBox.ny * tgtImg.naturalHeight,
            width: tgtBox.nw * tgtImg.naturalWidth,
            height: tgtBox.nh * tgtImg.naturalHeight,
          };
          const croppedDataUrl = captureCrop(tgtImg, naturalBox);
          setSlot(s.id, { naturalBox, croppedDataUrl, busy: null });
        } catch (e) {
          setSlot(s.id, { busy: null, error: (e as Error).message });
        }
      }
    } finally {
      setBulkBusy(false);
    }
  }

  // ── AI 학교명 추출 ────────────────────────────────────────────────────
  async function suggestNameForActive() {
    if (!active) return;
    const sourceForName = active.croppedDataUrl || active.sourceDataUrl;
    setSlot(active.id, { busy: "naming", error: undefined });
    try {
      const res = await fetch("/api/photo-edit/suggest-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: sourceForName }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "AI 시험명 추출 실패");
      setSlot(active.id, { suggestedName: data.name, busy: null });
      // 묶음 이름이 비어 있으면 자동으로 채움
      if (!examName.trim()) setExamName(data.name);
    } catch (e) {
      setSlot(active.id, { busy: null, error: (e as Error).message });
    }
  }

  // ── 출력: PDF 만들기 + Drive 「시험지」 폴더에 업로드 ─────────────────
  async function buildPdfBlob(): Promise<Blob | null> {
    const pages = slots
      .filter((s) => s.croppedDataUrl)
      .sort((a, b) => a.pageNo - b.pageNo);
    if (pages.length === 0) {
      alert("자르기가 적용된 페이지가 없습니다.");
      return null;
    }
    type JsPDFInstance = {
      addPage: (size?: [number, number], orientation?: "portrait" | "landscape") => void;
      addImage: (
        data: string,
        format: "JPEG" | "PNG",
        x: number,
        y: number,
        w: number,
        h: number,
      ) => void;
      output: (type: "blob") => Blob;
    };
    type JsPDFCtor = new (opts?: {
      orientation?: "portrait" | "landscape";
      unit?: string;
      format?: string | [number, number];
      compress?: boolean;
    }) => JsPDFInstance;
    const jspdfMod = (await import("jspdf")) as { jsPDF: JsPDFCtor };
    const JsPDF = jspdfMod.jsPDF;
    let doc: JsPDFInstance | null = null;
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const img = await loadImage(p.croppedDataUrl!);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const orientation: "portrait" | "landscape" = w >= h ? "landscape" : "portrait";
      // 픽셀 단위 페이지 — 이미지 그대로 1:1 매핑
      const size: [number, number] = orientation === "portrait" ? [w, h] : [w, h];
      if (i === 0) {
        doc = new JsPDF({ orientation, unit: "px", format: size, compress: true });
      } else if (doc) {
        doc.addPage(size, orientation);
      }
      const fmt: "JPEG" | "PNG" = /^data:image\/png/i.test(p.croppedDataUrl!) ? "PNG" : "JPEG";
      doc!.addImage(p.croppedDataUrl!, fmt, 0, 0, w, h);
    }
    if (!doc) return null;
    return doc.output("blob");
  }

  async function downloadPdf() {
    const blob = await buildPdfBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizeFilename(examName || "편집_시험지")}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Drive 「휴지통」으로 원본 이동 ───────────────────────────────────
  async function trashOneSlot(s: Slot): Promise<{ ok: boolean; error?: string }> {
    if (!s.driveFileId) return { ok: false, error: "Drive 출처가 아님" };
    setSlot(s.id, { busy: "trashing", error: undefined });
    try {
      const res = await fetch("/api/drive/move-to-trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: s.driveFileId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "휴지통 이동 실패");
      setSlot(s.id, { busy: null, trashed: true });
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      setSlot(s.id, { busy: null, error: msg });
      return { ok: false, error: msg };
    }
  }

  /** 같은 driveFileId 가 여러 슬롯(=PDF 페이지) 에 걸쳐 있을 수 있으므로 한 번씩만 처리. */
  async function trashAllProcessedOriginals(): Promise<void> {
    const fileIds = new Set<string>();
    for (const s of slots) {
      if (s.driveFileId && !s.trashed && s.croppedDataUrl) fileIds.add(s.driveFileId);
    }
    if (fileIds.size === 0) {
      alert("처리(자르기 적용)된 Drive 원본이 없습니다.");
      return;
    }
    if (!confirm(`Drive 원본 파일 ${fileIds.size}개를 「휴지통」 폴더로 이동합니다. 진행할까요?`)) return;
    setBulkBusy(true);
    let okCount = 0;
    let failCount = 0;
    for (const fileId of fileIds) {
      // 같은 fileId 를 공유하는 모든 슬롯 — 첫 번째 것을 대표로 호출
      const slot = slots.find((s) => s.driveFileId === fileId);
      if (!slot) continue;
      // eslint-disable-next-line no-await-in-loop
      const r = await trashOneSlot(slot);
      if (r.ok) {
        // 같은 fileId 의 나머지 슬롯에도 trashed 표시
        setSlots((prev) =>
          prev.map((s) => (s.driveFileId === fileId ? { ...s, trashed: true, busy: null } : s)),
        );
        okCount += 1;
      } else {
        failCount += 1;
      }
    }
    setBulkBusy(false);
    alert(
      `휴지통 이동 완료 — 성공 ${okCount}건${failCount > 0 ? ` · 실패 ${failCount}건 (슬롯 에러 메시지 확인)` : ""}.`,
    );
  }

  async function uploadToDriveExamEditAfterFolder() {
    setSavingToDrive(true);
    setSaveResult(null);
    try {
      const blob = await buildPdfBlob();
      if (!blob) return;
      const base64 = await blobToBase64(blob);
      const fileName = `${sanitizeFilename(examName || "편집_시험지")}.pdf`;
      const res = await fetch("/api/drive/exam-edit-after/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName, fileData: base64, mimeType: "application/pdf" }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "업로드 실패");
      setSaveResult({ ok: true, link: data.webViewLink, name: data.name });
    } catch (e) {
      setSaveResult({ ok: false, error: (e as Error).message });
    } finally {
      setSavingToDrive(false);
    }
  }

  // ── 키보드 ↑/↓ 로 슬롯 전환 ──────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target && (e.target as HTMLElement).tagName.match(/INPUT|TEXTAREA/)) return;
      if (slots.length === 0) return;
      const idx = slots.findIndex((s) => s.id === activeId);
      if (e.key === "ArrowDown" || e.key === "j") {
        if (idx < slots.length - 1) setActiveId(slots[idx + 1].id);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        if (idx > 0) setActiveId(slots[idx - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slots, activeId]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <header className="mb-3">
        <h1 className="text-xl font-bold text-slate-900">📝 시험지 편집</h1>
        <p className="mt-1 text-xs text-slate-600">
          「시험지 편집 전」 폴더 사진/스캔 → 자동·수동 자르기 → 학교명 자동 추출 → 「시험지 편집 후」
          폴더에 PDF 로 일괄 업로드. (Drive 경로: 해설제작 / 분석용 자료 / 시험지 편집 / …)
        </p>
      </header>

      {/* 1단계: 묶음 이름 + 입력 */}
      <section className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
          <label className="block text-xs font-semibold text-slate-700">
            묶음(시험) 이름 — 출력 PDF 파일명
            <input
              type="text"
              value={examName}
              onChange={(e) => setExamName(e.target.value)}
              placeholder="예: 고2) 2026 부산 동래구 부산중앙여고 1학기 중간고사"
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal"
            />
            <span className="mt-0.5 text-[10px] text-slate-500">
              비워두면 첫 페이지에 「AI 학교명」 누를 때 자동 채워집니다.
            </span>
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <button
              type="button"
              onClick={() => {
                if (!drivePickerOpen && driveStatus !== "ready") loadDriveFiles();
                setDrivePickerOpen((v) => !v);
              }}
              className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              {drivePickerOpen ? "Drive 패널 닫기" : "Drive 「시험지 편집 전」"}
            </button>
            <label className="cursor-pointer rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              로컬 파일 추가
              <input
                type="file"
                accept="application/pdf,image/*,.pdf,.png,.jpg,.jpeg,.webp,.heic,.heif"
                multiple
                hidden
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length > 0) await addFiles(files.map((file) => ({ file })));
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>

        {drivePickerOpen && (
          <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs">
            {driveStatus === "loading" && <p className="text-emerald-900">목록 불러오는 중…</p>}
            {driveStatus === "no-config" && (
              <p className="text-amber-900">
                Drive 키 미설정 — Railway Variables 에 GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN 등록 필요.
                {driveError ? ` (${driveError})` : ""}
              </p>
            )}
            {driveStatus === "no-folder" && (
              <p className="text-amber-900">
                「시험지 편집 전」 폴더가 Drive 에 없습니다. 「해설제작 / 분석용 자료 / 시험지
                편집」 안에 「시험지 편집 전」 폴더를 만들거나
                GOOGLE_DRIVE_EXAM_EDIT_BEFORE_FOLDER_ID 를 직접 지정하세요.
                {driveError ? ` (${driveError})` : ""}
              </p>
            )}
            {driveStatus === "error" && (
              <p className="text-rose-900">✗ {driveError ?? "Drive 오류"}</p>
            )}
            {driveStatus === "ready" && driveFiles.length === 0 && (
              <p className="text-slate-700">「시험지 원안」 폴더가 비어 있습니다.</p>
            )}
            {driveStatus === "ready" && driveFiles.length > 0 && (
              <div className="space-y-1">
                <p className="mb-1 text-emerald-900">최신순 {driveFiles.length}개:</p>
                <ul className="max-h-44 overflow-y-auto divide-y divide-emerald-100 rounded border border-emerald-200 bg-white">
                  {driveFiles.map((f) => (
                    <li key={f.id} className="flex items-center justify-between gap-2 px-2 py-1">
                      <div className="flex-1 truncate">
                        <span className="font-semibold text-slate-800">{f.name}</span>
                        {f.size !== null && (
                          <span className="ml-2 text-slate-500">{(f.size / 1024 / 1024).toFixed(1)}MB</span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => pickDriveFile(f.id)}
                        disabled={drivePicking}
                        className="rounded border border-emerald-600 bg-white px-2 py-0.5 font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
                      >
                        {drivePicking ? "가져오는 중…" : "추가"}
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={loadDriveFiles} className="mt-1 text-emerald-800 underline">
                  목록 새로고침
                </button>
              </div>
            )}
          </div>
        )}
        {loadingFile && <p className="mt-2 text-xs text-slate-600">파일 처리 중…</p>}
      </section>

      {/* 2단계: 슬롯 목록 + 작업 영역 */}
      {slots.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
          {/* 좌측 슬롯 목록 */}
          <aside className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-bold text-slate-900">페이지 ({slots.length})</h2>
              <button
                onClick={reorderByPageNo}
                className="text-[10px] text-slate-600 underline hover:text-slate-900"
                title="페이지 번호 순으로 목록 재정렬"
              >
                번호순 정렬
              </button>
            </div>
            <ul className="max-h-[640px] space-y-1 overflow-y-auto">
              {slots.map((s) => (
                <li
                  key={s.id}
                  className={`flex cursor-pointer items-center gap-2 rounded border p-2 ${
                    s.id === activeId
                      ? "border-indigo-500 bg-indigo-50"
                      : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                  onClick={() => setActiveId(s.id)}
                >
                  <input
                    type="number"
                    value={s.pageNo}
                    onChange={(e) =>
                      setSlot(s.id, {
                        pageNo: Number.parseInt(e.target.value, 10) || 0,
                      })
                    }
                    onClick={(e) => e.stopPropagation()}
                    className="w-12 rounded border border-slate-300 px-1 py-0.5 text-center text-xs"
                    title="페이지 번호 — PDF 정렬 기준"
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={s.croppedDataUrl || s.sourceDataUrl}
                    alt={s.sourceLabel}
                    className="h-12 w-12 rounded border border-slate-200 bg-slate-100 object-cover"
                  />
                  <div className="min-w-0 flex-1 text-[11px]">
                    <div className="truncate font-semibold text-slate-800">
                      {s.sourceLabel}
                      {s.driveFileId && (
                        <span
                          className="ml-1 rounded bg-emerald-100 px-1 text-[9px] font-medium text-emerald-800"
                          title="Drive 「시험지 편집 전」 폴더에서 가져옴 → 처리 후 휴지통으로 이동 가능"
                        >
                          Drive
                        </span>
                      )}
                      {s.trashed && (
                        <span
                          className="ml-1 rounded bg-rose-100 px-1 text-[9px] font-medium text-rose-700"
                          title="원본이 「휴지통」 폴더로 이동됨"
                        >
                          🗑 이동됨
                        </span>
                      )}
                    </div>
                    <div className="truncate text-slate-500">
                      {s.naturalBox ? "✓ 박스" : "박스 없음"}
                      {s.busy && ` · ${labelBusy(s.busy)}`}
                      {s.error && ` · ✗`}
                    </div>
                  </div>
                  {s.driveFileId && !s.trashed && s.croppedDataUrl && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        trashOneSlot(s);
                      }}
                      disabled={s.busy === "trashing"}
                      className="rounded border border-rose-400 bg-white px-1.5 text-[12px] text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                      title="이 원본 한 개를 Drive 휴지통으로 이동"
                    >
                      🗑
                    </button>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeSlot(s.id);
                    }}
                    className="rounded border border-rose-300 bg-white px-1.5 text-[10px] font-bold text-rose-700 hover:bg-rose-50"
                    title="목록에서 제거 (Drive 파일은 그대로)"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {/* 우측 작업 영역 */}
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => active && detectBoxForSlot(active)}
                  disabled={!active || active.busy === "detecting" || bulkBusy}
                  className="rounded-md border border-indigo-700 bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                  title="현재 페이지에서 시험지 영역만 자동으로 박스 잡기 (Gemini)"
                >
                  🤖 AI 박스 자동
                </button>
                <button
                  onClick={detectAllBoxes}
                  disabled={bulkBusy || slots.every((s) => s.naturalBox)}
                  className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-50 disabled:opacity-50"
                  title="박스 없는 모든 페이지에 AI 자동 박스 적용"
                >
                  {bulkBusy ? "처리 중…" : "전체 AI 박스"}
                </button>
                <button
                  onClick={mimicBoxFromActive}
                  disabled={!active?.naturalBox || bulkBusy}
                  className="rounded-md border border-purple-700 bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
                  title="현재 박스를 기준으로 나머지 페이지에 같은 의도의 박스 복제"
                >
                  🪄 기준 박스로 모방
                </button>
                <span className="mx-1 h-5 w-px bg-slate-200" />
                <button
                  onClick={suggestNameForActive}
                  disabled={!active || active.busy === "naming"}
                  className="rounded-md border border-emerald-700 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  title="현재 페이지 헤더에서 시험명을 한 줄 형식으로 추출 → 묶음 이름 자동 채움"
                >
                  🏫 AI 학교명
                </button>
                {active?.busy && (
                  <span className="text-[11px] text-slate-600">
                    ⏳ {labelBusy(active.busy)}…
                  </span>
                )}
                {active?.error && (
                  <span className="text-[11px] text-rose-700">✗ {active.error}</span>
                )}
              </div>

              {active ? (
                <div className="overflow-auto rounded border border-slate-200 bg-slate-50 p-2">
                  <ReactCrop
                    crop={crop}
                    onChange={(_, percentCrop) => setCrop(percentCrop)}
                    onComplete={handleCropComplete}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      ref={imgRef}
                      src={active.sourceDataUrl}
                      alt={active.sourceLabel}
                      className="block max-w-full"
                    />
                  </ReactCrop>
                </div>
              ) : (
                <p className="rounded border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
                  목록에서 페이지를 선택하세요.
                </p>
              )}
              <p className="mt-2 text-[11px] text-slate-500">
                🖱 드래그 → 즉시 자르기 적용 · 🤖 AI 박스 자동 → 시험지 영역만 자동 검출 · 🪄 모방 → 현재 박스를 다른 페이지에도 같은 의도로
              </p>
            </div>

            {active?.croppedDataUrl && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <div className="text-xs font-semibold text-emerald-900">
                  잘라낸 결과 미리보기
                  {active.suggestedName && (
                    <span className="ml-2 text-emerald-700">
                      · 추출된 이름: {active.suggestedName}
                    </span>
                  )}
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={active.croppedDataUrl}
                  alt="cropped"
                  className="mt-2 max-h-72 rounded border border-emerald-200 bg-white"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3단계: 출력 */}
      {slots.some((s) => s.croppedDataUrl) && (
        <section className="mt-4 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs">
              <span className="font-semibold text-slate-800">출력</span>
              <span className="ml-2 text-slate-600">
                자르기 적용 페이지 {slots.filter((s) => s.croppedDataUrl).length} / {slots.length}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={downloadPdf}
                className="rounded-md border border-slate-700 bg-slate-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
              >
                💾 PDF 다운로드
              </button>
              <button
                onClick={uploadToDriveExamEditAfterFolder}
                disabled={savingToDrive}
                className="rounded-md border border-indigo-700 bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
                title="Drive 「해설제작 / 분석용 자료 / 시험지 편집 / 시험지 편집 후」 폴더로 업로드"
              >
                {savingToDrive ? "업로드 중…" : "☁ Drive 「시험지 편집 후」에 업로드"}
              </button>
              {(() => {
                const trashable = new Set(
                  slots
                    .filter((s) => s.driveFileId && !s.trashed && s.croppedDataUrl)
                    .map((s) => s.driveFileId!),
                ).size;
                return (
                  <button
                    onClick={trashAllProcessedOriginals}
                    disabled={bulkBusy || trashable === 0}
                    className="rounded-md border border-rose-700 bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                    title="자르기 적용된 Drive 원본을 「해설제작/휴지통」 폴더로 이동 — 「시험지 편집 전」 폴더에서 사라져 다음 작업 목록을 깨끗하게 유지"
                  >
                    🗑 처리된 원본 휴지통으로 ({trashable})
                  </button>
                );
              })()}
            </div>
          </div>
          {saveResult && saveResult.ok && (
            <div className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-2 text-xs text-emerald-900">
              ✓ 업로드 완료 —{" "}
              <a href={saveResult.link} target="_blank" rel="noreferrer" className="underline">
                {saveResult.name}
              </a>
              <span className="ml-2 text-emerald-800">
                Drive 「시험지 편집 후」 폴더에 저장됨.
              </span>
            </div>
          )}
          {saveResult && !saveResult.ok && (
            <div className="mt-2 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900">
              ✗ 업로드 실패: {saveResult.error}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ── 헬퍼들 ───────────────────────────────────────────────────────────────

function makeId(): string {
  return `slot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeFilename(s: string): string {
  return (s || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function labelBusy(b: NonNullable<Slot["busy"]>): string {
  if (b === "detecting") return "AI 박스 검출";
  if (b === "mimicking") return "박스 모방";
  if (b === "naming") return "시험명 추출";
  if (b === "trashing") return "휴지통 이동";
  return b;
}

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

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지 로드 실패"));
    img.src = dataUrl;
  });
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error || new Error("blob 변환 실패"));
    reader.readAsDataURL(blob);
  });
}

async function renderPdfToImages(file: File): Promise<Array<{ dataUrl: string; pageLabel: string }>> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages: Array<{ dataUrl: string; pageLabel: string }> = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas context 실패");
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    pages.push({ dataUrl: canvas.toDataURL("image/jpeg", 0.92), pageLabel: `${i}p` });
  }
  return pages;
}
