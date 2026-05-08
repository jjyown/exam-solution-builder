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
  /** Google CDN(lh3.googleusercontent.com) 직접 URL — 사이드바 썸네일에 즉시 사용 */
  thumbnailLink: string | null;
};

type NaturalBox = { x: number; y: number; width: number; height: number };
/**
 * 정규화 박스 — 이미지 가로/세로 대비 0~1 비율로 저장.
 * 이미지 해상도(s1600 썸네일 vs 풀 원본) 가 바뀌어도 같은 영역을 가리킴.
 * 캔버스 그리기·자르기 시 현재 imageEl 의 naturalWidth/Height 와 곱해 픽셀 좌표로 환산.
 */
type CropNorm = { x: number; y: number; width: number; height: number };

function normToNaturalBox(
  n: CropNorm,
  naturalW: number,
  naturalH: number,
): NaturalBox {
  return {
    x: n.x * naturalW,
    y: n.y * naturalH,
    width: n.width * naturalW,
    height: n.height * naturalH,
  };
}

/** 편집 슬롯 — 한 장의 원본 이미지(또는 PDF 한 페이지)에 대응. */
type Slot = {
  id: string;
  /**
   * 원본 풀 이미지 dataUrl. Drive 슬롯은 사용자가 클릭해 활성화하기 전엔 null —
   * 그때 /api/drive/exam-originals/fetch 로 다운로드해 채워넣는다 (지연 로드).
   * 로컬 업로드는 처음부터 채워져 있다.
   */
  sourceDataUrl: string | null;
  /** 사이드바·작업 영역에서 미리보기로 쓸 작은 이미지 URL. Drive: /api/drive/thumb, 로컬: sourceDataUrl 같음. */
  thumbUrl: string;
  sourceLabel: string;
  /** 사용자가 부여한 페이지 번호 — 출력 PDF 의 정렬 기준 */
  pageNo: number;
  /** 자연 좌표 박스 — 비어있으면 미설정. 자르기 결과 imageDataUrl 도 같이 보관 */
  /** 자른 영역 — 정규화 0~1 좌표. null 이면 미설정. 이미지 해상도 변경에 안전. */
  cropNorm: CropNorm | null;
  croppedDataUrl: string | null;
  /** Gemini 가 추출해 준 시험명 한 줄 — 「묶음 이름」으로 사용 가능 */
  suggestedName: string | null;
  /** AI 호출 진행 상태 */
  busy: null | "detecting" | "mimicking" | "naming" | "trashing" | "loading";
  error?: string;
  /** Drive 「시험지 편집 전」 폴더에서 가져온 파일이면 그 fileId — 처리 끝난 후 휴지통으로 이동 가능 */
  driveFileId?: string;
  /** 이미 휴지통으로 이동되었으면 true (UI 상태 표시용) */
  trashed?: boolean;
  /** PDF 출력 포함 여부 — 좌측 사이드바 체크박스. Drive 자동로드는 false, 로컬은 true. */
  includeInPdf: boolean;
};

type RangePreset = { id: string; name: string; range: string };

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
  /** 4점 클릭 모드 — 모서리 4개 찍으면 그 점들로 둘러싼 사각형으로 cropNorm 자동 설정 */
  const [pointMode, setPointMode] = useState(false);
  /** 클릭으로 찍은 모서리 점들 (display 좌표). 4개 채워지면 자동 적용. */
  const [cornerPoints, setCornerPoints] = useState<Array<{ x: number; y: number }>>([]);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Drive 「시험지 원안」 폴더
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [driveStatus, setDriveStatus] = useState<
    "idle" | "loading" | "ready" | "no-config" | "no-folder" | "error"
  >("idle");
  const [driveError, setDriveError] = useState<string | null>(null);

  // 범위 입력·묶음 preset (사진 편집기 UX 차용)
  const [rangeText, setRangeText] = useState("");
  const [presets, setPresets] = useState<RangePreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** 체크 순서 입력 편집 상태 — 한 슬롯에서만 편집 중. 빈문자/숫자 허용. */
  const [orderEdit, setOrderEdit] = useState<{ id: string; value: string } | null>(null);

  const active = slots.find((s) => s.id === activeId) ?? null;

  // ── 묶음 preset: localStorage 영속화 ─────────────────────────────────
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("edit_page_range_presets_v1");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setPresets(parsed.filter((p) => p && p.id && p.name && p.range));
      }
    } catch {
      /* silent */
    }
  }, []);
  function persistPresets(next: RangePreset[]): void {
    setPresets(next);
    try {
      window.localStorage.setItem("edit_page_range_presets_v1", JSON.stringify(next));
    } catch {
      /* silent */
    }
  }

  function applyRangeToInclude(text: string): void {
    const wanted = parsePageRanges(text, slots.length);
    if (wanted.size === 0) {
      // 비어 있으면 전체 해제
      setSlots((prev) => prev.map((s) => ({ ...s, includeInPdf: false })));
      return;
    }
    setSlots((prev) =>
      prev
        .slice()
        .sort((a, b) => a.pageNo - b.pageNo)
        .reduce<Slot[]>((acc, s, i) => {
          // 「순서 N」 = 정렬된 인덱스 + 1
          acc.push({ ...s, includeInPdf: wanted.has(i + 1) });
          return acc;
        }, [])
        .sort((a, b) => a.pageNo - b.pageNo),
    );
  }

  function savePreset(): void {
    const name = presetName.trim();
    const range = rangeText.trim();
    if (!name || !range) {
      alert("묶음 이름과 범위를 모두 입력하세요.");
      return;
    }
    const id = `preset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    persistPresets([...presets, { id, name, range }]);
    setPresetName("");
  }
  function applyPreset(p: RangePreset): void {
    setRangeText(p.range);
    applyRangeToInclude(p.range);
  }
  function removePreset(id: string): void {
    persistPresets(presets.filter((p) => p.id !== id));
  }

  function selectAllSlots(): void {
    setSlots((prev) => prev.map((s) => ({ ...s, includeInPdf: true })));
  }
  function clearAllSelection(): void {
    setSlots((prev) => prev.map((s) => ({ ...s, includeInPdf: false })));
  }
  /**
   * 체크된 슬롯들을 일괄 삭제 — 사이드바 X 버튼의 묶음 버전.
   * Drive 출처는 「휴지통」 폴더로 이동, 로컬·이미 trashed 는 단순 제거.
   * 작업 흐름: 체크 4개 → AI 박스 → AI 학교명 → ☁ Drive 업로드 → 「선택항목 삭제」
   *           로 4개 한 번에 정리 → 다음 묶음으로 이동.
   */
  async function trashCheckedSlots(): Promise<void> {
    const checked = slots.filter((s) => s.includeInPdf);
    if (checked.length === 0) {
      alert("체크된 페이지가 없습니다.");
      return;
    }
    const driveFileIds = Array.from(
      new Set(
        checked.filter((s) => s.driveFileId && !s.trashed).map((s) => s.driveFileId!),
      ),
    );
    const localOnly = checked.length - driveFileIds.length;

    const message =
      driveFileIds.length > 0
        ? `체크된 ${checked.length}개 항목을 삭제합니다.\n\nDrive 원본 ${driveFileIds.length}개는 「휴지통」 폴더로 이동되며, 「시험지 편집 전」 폴더에서 사라집니다.${localOnly > 0 ? `\n로컬 ${localOnly}개는 목록에서만 제거.` : ""}\n실수했을 땐 Drive 「휴지통」에서 다시 옮기면 복구됩니다.\n\n진행할까요?`
        : `체크된 ${checked.length}개 항목을 목록에서 제거합니다.\n\n진행할까요?`;
    if (!confirm(message)) return;

    setBulkBusy(true);
    let failCount = 0;
    for (const fid of driveFileIds) {
      // 같은 fileId 공유 슬롯들 모두 trashing 표시
      setSlots((prev) =>
        prev.map((x) => (x.driveFileId === fid ? { ...x, busy: "trashing" } : x)),
      );
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch("/api/drive/move-to-trash", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: fid }),
        });
        // eslint-disable-next-line no-await-in-loop
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "휴지통 이동 실패");
      } catch {
        failCount += 1;
      }
    }
    // 체크된 슬롯들을 일괄 제거 (휴지통 실패분도 사이드바에선 제거 — 깨끗하게 다음 작업)
    setSlots((prev) => {
      const next = prev.filter((s) => !s.includeInPdf);
      if (next.length === 0) {
        setActiveId(null);
      } else if (activeId && !next.find((s) => s.id === activeId)) {
        setActiveId(next[0].id);
      }
      return next;
    });
    // 다음 묶음 작업을 위해 묶음 관련 상태 초기화
    // (시험명·범위 입력·체크 순서 편집 모두 이 묶음 한정 상태)
    setExamName("");
    setRangeText("");
    setOrderEdit(null);
    setBulkBusy(false);
    if (failCount > 0) {
      alert(
        `Drive 휴지통 이동 실패 ${failCount}건 — 사이드바에서는 제거되었지만 Drive 원본은 「시험지 편집 전」에 남아있을 수 있음.`,
      );
    }
  }
  function clearAllSlots(): void {
    if (slots.length === 0) return;
    if (!confirm(`전체 ${slots.length}개 슬롯을 비웁니다. 진행할까요? (Drive 원본은 그대로)`)) return;
    setSlots([]);
    setActiveId(null);
  }

  // ── 드래그 reorder ─────────────────────────────────────────────────
  function onDragStartSlot(id: string) {
    setDraggingId(id);
  }
  function onDropSlot(targetId: string) {
    if (!draggingId || draggingId === targetId) return;
    setSlots((prev) => {
      const fromIdx = prev.findIndex((s) => s.id === draggingId);
      const toIdx = prev.findIndex((s) => s.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      // pageNo 재부여 — 정렬 순서대로 1, 2, 3 ...
      return next.map((s, i) => ({ ...s, pageNo: i + 1 }));
    });
    setDraggingId(null);
  }

  /**
   * 체크된 슬롯의 「체크 순서」를 사용자 입력대로 재배치.
   * - 체크된 N 개를 사용자 입력 순서로 1..N
   * - 체크 안 된 슬롯은 그 뒤(N+1..M)에 기존 상대 순서 유지하며 배치
   * - 사이드바 array 순서·pageNo 모두 일치시킴 (드래그 동작과 같은 규칙)
   */
  function setCheckedSlotOrder(slotId: string, newOneBasedPos: number): void {
    setSlots((prev) => {
      const checkedSorted = prev
        .filter((s) => s.includeInPdf)
        .slice()
        .sort((a, b) => a.pageNo - b.pageNo);
      const fromIdx = checkedSorted.findIndex((c) => c.id === slotId);
      if (fromIdx < 0) return prev;
      const toIdx = Math.max(
        0,
        Math.min(newOneBasedPos - 1, checkedSorted.length - 1),
      );
      if (fromIdx === toIdx) return prev;

      const [moved] = checkedSorted.splice(fromIdx, 1);
      checkedSorted.splice(toIdx, 0, moved);

      // 체크 안 된 슬롯은 기존 array 순서 유지 (드래그로 잡아놓은 순서 보존)
      const checkedIdSet = new Set(checkedSorted.map((c) => c.id));
      const uncheckedKeepOrder = prev.filter((s) => !checkedIdSet.has(s.id));

      const merged = [...checkedSorted, ...uncheckedKeepOrder];
      return merged.map((s, i) => ({ ...s, pageNo: i + 1 }));
    });
  }

  /** 슬롯 → 체크 순서 (1-based, 체크 안 됐으면 0) */
  function checkedOrderOf(s: Slot): number {
    if (!s.includeInPdf) return 0;
    const idx = slots
      .filter((x) => x.includeInPdf)
      .slice()
      .sort((a, b) => a.pageNo - b.pageNo)
      .findIndex((c) => c.id === s.id);
    return idx + 1;
  }
  function onDragEndSlot() {
    setDraggingId(null);
  }

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
      const list: DriveFile[] = Array.isArray(data.files) ? data.files : [];
      setDriveFiles(list);
      setDriveStatus("ready");
      // 모든 Drive 파일을 사이드바 슬롯으로 자동 생성 (풀 다운로드는 클릭 시 지연 로드)
      autoCreateSlotsFromDriveList(list);
    } catch (e) {
      setDriveStatus("error");
      setDriveError((e as Error).message);
    }
    // autoCreateSlotsFromDriveList 의 setSlots 클로저 안정 — slots 의존성 비움
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Drive 파일 목록 → 사이드바 슬롯으로 자동 변환 (풀 파일은 다운로드 안 함).
   * 같은 driveFileId 가 이미 슬롯에 있으면 건너뛴다 (중복 방지).
   * 사용자가 슬롯을 클릭해야 ensureSlotSource() 가 풀 파일을 받아온다.
   */
  function autoCreateSlotsFromDriveList(files: DriveFile[]): void {
    if (files.length === 0) return;
    setSlots((prev) => {
      const have = new Set(prev.filter((s) => s.driveFileId).map((s) => s.driveFileId!));
      let nextNo = prev.reduce((m, s) => (s.pageNo > m ? s.pageNo : m), 0);
      const additions: Slot[] = [];
      for (const f of files) {
        if (have.has(f.id)) continue;
        nextNo += 1;
        // thumbnailLink 가 있으면 Google CDN 직접 URL (서버 hop 0회 — 거의 즉시 표시).
        // =s220 같은 사이즈 접미를 320 으로 치환해 사이드바 카드에 적합한 크기로.
        // 없거나 만료되어 실패 시 onError → /api/drive/thumb 프록시로 fallback (UI 측 처리).
        const directThumb = f.thumbnailLink
          ? f.thumbnailLink.replace(/=s\d+(-[a-z])?$/, "=s320")
          : `/api/drive/thumb?fileId=${encodeURIComponent(f.id)}&size=320`;
        additions.push({
          id: makeId(),
          driveFileId: f.id,
          sourceDataUrl: null, // 지연 로드
          thumbUrl: directThumb,
          sourceLabel: f.name,
          pageNo: nextNo,
          cropNorm: null,
          croppedDataUrl: null,
          suggestedName: null,
          busy: null,
          // 자동 로드된 Drive 슬롯은 기본 미체크 — 사용자가 묶음별로 직접 체크
          includeInPdf: false,
        });
      }
      return [...prev, ...additions];
    });
  }

  /**
   * 슬롯의 풀 sourceDataUrl 이 비어 있으면 다운로드해 채워넣는다.
   * 클릭 활성화·자르기·AI 호출 직전에 호출. 이미 채워져 있으면 즉시 반환.
   *
   * 속도 최적화:
   *  1) Drive thumbnailLink 가 있으면 먼저 큰 사이즈(s1600) 로 즉시 표시 — Google CDN 직접
   *     이미지 한 장만 받아 dataURL 로 변환. 4MB 원본 대비 보통 100~400KB → 거의 즉시.
   *  2) AI 호출/자르기 실행 정확도를 위해 풀 원본도 백그라운드에서 받아 sourceDataUrl 갱신.
   *     자르기·AI 는 갱신된 풀 이미지를 사용 (조용히 더 선명한 이미지로 교체됨).
   *  PDF 는 풀 원본 다운로드 후 페이지 렌더 (썸네일로는 부족).
   */
  async function ensureSlotSource(slotId: string): Promise<string | null> {
    const cur = slots.find((s) => s.id === slotId);
    if (!cur) return null;
    if (cur.sourceDataUrl) return cur.sourceDataUrl;
    if (!cur.driveFileId) return null;
    setSlot(slotId, { busy: "loading", error: undefined });

    // 1차: thumbnailLink 의 고해상도 (s1600) URL 을 sourceDataUrl 로 바로 설정 → 즉시 표시
    // (fetch + blob + FileReader 단계 생략 — img 가 CDN 에서 직접 받음)
    const driveFile = driveFiles.find((d) => d.id === cur.driveFileId);
    const isPdf =
      driveFile?.mimeType === "application/pdf" ||
      /\.pdf$/i.test(driveFile?.name ?? cur.sourceLabel);

    if (!isPdf && driveFile?.thumbnailLink) {
      const bigUrl = driveFile.thumbnailLink.replace(/=s\d+(-[a-z])?$/, "=s1600");
      // 즉시 표시 — img.src 가 CDN 에서 직접 다운로드 (브라우저 native, 병렬)
      // 풀 원본은 자르기·AI 호출할 때 ensureFullDataUrlSource 가 on-demand 받음
      // → 단순 브라우징 시 낭비되는 백그라운드 4MB 다운로드 제거.
      setSlot(slotId, { sourceDataUrl: bigUrl, busy: null });
      return bigUrl;
    }

    // 2차: 풀 원본 다운로드 (PDF 또는 thumbnailLink 실패 시)
    try {
      const fetched = await fetchDriveFile(cur.driveFileId);
      const f = fetched.file;
      let dataUrl = "";
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
        const pages = await renderPdfToImages(f);
        dataUrl = pages[0]?.dataUrl || "";
        const pageHint =
          pages.length > 1 ? ` (PDF ${pages.length}쪽 중 첫 페이지만)` : "";
        setSlot(slotId, {
          sourceDataUrl: dataUrl,
          thumbUrl: dataUrl,
          sourceLabel: cur.sourceLabel + pageHint,
          busy: null,
        });
      } else {
        dataUrl = await fileToDataUrl(f);
        setSlot(slotId, { sourceDataUrl: dataUrl, busy: null });
      }
      return dataUrl;
    } catch (e) {
      setSlot(slotId, { busy: null, error: `다운로드 실패: ${(e as Error).message}` });
      return null;
    }
  }

  /**
   * 자르기·AI 호출용 — 반드시 dataURL(`data:image/...;base64,...`) 을 반환.
   * sourceDataUrl 이 CDN URL("https://...") 인 경우 풀 원본을 받아 dataURL 로 교체하고 반환.
   * 이미 dataURL 이면 그대로 반환 (중복 다운로드 없음).
   */
  async function ensureFullDataUrlSource(slotId: string): Promise<string | null> {
    const cur = slots.find((s) => s.id === slotId);
    if (!cur) return null;
    if (cur.sourceDataUrl?.startsWith("data:")) return cur.sourceDataUrl;
    if (!cur.driveFileId) return cur.sourceDataUrl ?? null; // 로컬은 항상 dataURL
    setSlot(slotId, { busy: "loading", error: undefined });
    try {
      const fetched = await fetchDriveFile(cur.driveFileId);
      const f = fetched.file;
      let dataUrl = "";
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
        const pages = await renderPdfToImages(f);
        dataUrl = pages[0]?.dataUrl || "";
      } else {
        dataUrl = await fileToDataUrl(f);
      }
      setSlot(slotId, { sourceDataUrl: dataUrl, busy: null });
      return dataUrl;
    } catch (e) {
      setSlot(slotId, { busy: null, error: `풀 원본 다운로드 실패: ${(e as Error).message}` });
      return null;
    }
  }

  /** 단일 fileId 다운로드 → File + driveFileId 객체 반환 */
  async function fetchDriveFile(
    fileId: string,
  ): Promise<{ file: File; driveFileId: string }> {
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
    return { file, driveFileId: fileId };
  }

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
              thumbUrl: p.dataUrl,
              sourceLabel: `${f.name} ${p.pageLabel}`,
              pageNo: 0,
              cropNorm: null,
              croppedDataUrl: null,
              suggestedName: null,
              busy: null,
              // PDF 원본은 Drive 한 파일이지만 페이지마다 슬롯이 됨 → fileId 동일하게 부여.
              // 한 페이지만 휴지통 이동은 의미 없음 → 모든 페이지 슬롯이 동일 fileId 공유.
              driveFileId: it.driveFileId,
              includeInPdf: true,
            });
          }
        } else {
          const dataUrl = await fileToDataUrl(f);
          newSlots.push({
            id: makeId(),
            sourceDataUrl: dataUrl,
            thumbUrl: dataUrl,
            sourceLabel: f.name,
            pageNo: 0,
            cropNorm: null,
            croppedDataUrl: null,
            suggestedName: null,
            busy: null,
            driveFileId: it.driveFileId,
            includeInPdf: true,
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

  /**
   * 슬롯 삭제 — Drive 출처면 「휴지통」 폴더로 이동(복구 가능) + 목록에서 제거.
   * 로컬 업로드 슬롯이거나 이미 trashed 면 단순 목록 제거만.
   * 실수 방지: Drive 휴지통 이동 시 확인 다이얼로그.
   */
  async function removeSlot(id: string) {
    const s = slots.find((x) => x.id === id);
    if (!s) return;

    const removeFromList = () => {
      setSlots((prev) => {
        const next = prev.filter((x) => x.id !== id);
        if (activeId === id) setActiveId(next[0]?.id ?? null);
        return next;
      });
    };

    // Drive 미연결·이미 휴지통 → 단순 제거
    if (!s.driveFileId || s.trashed) {
      removeFromList();
      return;
    }

    // Drive 휴지통 이동 + 제거 (실수 시 Drive 「휴지통」 폴더에서 복구 가능)
    if (
      !confirm(
        `${s.sourceLabel} 을(를) 삭제합니다.\n\n원본은 Drive 「휴지통」 폴더로 이동되며, 「시험지 편집 전」 폴더에서 사라집니다.\n실수했을 땐 Drive 에서 「휴지통」 → 원래 폴더로 다시 옮기면 복구됩니다.\n\n진행할까요?`,
      )
    ) {
      return;
    }
    setSlot(id, { busy: "trashing", error: undefined });
    try {
      const res = await fetch("/api/drive/move-to-trash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: s.driveFileId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "휴지통 이동 실패");
      // 같은 driveFileId 공유하는 다른 슬롯(같은 PDF 페이지 등) 도 trashed 표시 후 제거
      setSlots((prev) =>
        prev.filter(
          (x) => !(x.driveFileId === s.driveFileId) || x.id === id,
        ),
      );
      removeFromList();
    } catch (e) {
      const msg = (e as Error).message;
      // 실패 시 그냥 목록에서만 제거할지 사용자에게 선택권
      if (
        confirm(
          `Drive 휴지통 이동 실패: ${msg}\n\n그래도 목록에서만 제거할까요? (Drive 원본은 그대로 남음)`,
        )
      ) {
        removeFromList();
      } else {
        setSlot(id, { busy: null, error: msg });
      }
    }
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

  /**
   * 4점 클릭 모드 — 캔버스 영역 클릭 시 점 추가. 4번째 클릭이면 자동 적용.
   * 점들의 axis-aligned bounding rectangle 을 cropNorm 으로 저장.
   * (perspective 보정은 추후 — 우선 사각 범위만)
   */
  async function handlePointClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!pointMode || !active || !imgRef.current) return;
    const img = imgRef.current;
    const rect = img.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (px < 0 || px > img.width || py < 0 || py > img.height) return;
    const next = [...cornerPoints, { x: px, y: py }];
    setCornerPoints(next);
    if (next.length < 4) return;

    // 4점 모임 → bounding rect 계산 후 cropNorm 적용
    const xs = next.map((p) => p.x);
    const ys = next.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    if (maxX - minX < 10 || maxY - minY < 10 || !img.width || !img.height) {
      // 너무 작거나 이미지 크기 모름 — 점만 초기화하고 종료
      setCornerPoints([]);
      return;
    }
    const cropNorm: CropNorm = {
      x: minX / img.width,
      y: minY / img.height,
      width: (maxX - minX) / img.width,
      height: (maxY - minY) / img.height,
    };
    setSlot(active.id, { cropNorm, error: undefined });
    // 잘라낸 dataURL 도 만들기 (현재 표시 이미지 기준 — tainted 면 폴백)
    const naturalBox = normToNaturalBox(
      cropNorm,
      img.naturalWidth,
      img.naturalHeight,
    );
    try {
      const croppedDataUrl = captureCrop(img, naturalBox);
      setSlot(active.id, { croppedDataUrl });
    } catch {
      // CDN URL 로 tainted — 풀 dataURL 받아 재시도
      const fullSrc = await ensureFullDataUrlSource(active.id);
      if (fullSrc) {
        try {
          const fullImg = await loadImage(fullSrc);
          const fullBox = normToNaturalBox(
            cropNorm,
            fullImg.naturalWidth,
            fullImg.naturalHeight,
          );
          const croppedDataUrl = captureCrop(fullImg, fullBox);
          setSlot(active.id, { croppedDataUrl });
        } catch {
          /* silent */
        }
      }
    }
    // 점 초기화 — 다음 슬롯/다음 영역 마킹 가능하도록
    setCornerPoints([]);
  }

  function clearPointMarkers(): void {
    setCornerPoints([]);
  }

  // 활성 슬롯 변경 또는 모드 토글 시 점 초기화
  useEffect(() => {
    setCornerPoints([]);
  }, [activeId, pointMode]);

  async function handleCropComplete(sel: PixelCrop) {
    if (!active || !imgRef.current) return;
    if (sel.width < 10 || sel.height < 10) return;
    const imageEl = imgRef.current;
    if (!imageEl.width || !imageEl.height) return;
    // 표시 좌표 → 정규화 0~1 (이미지 해상도 변경에 안전)
    const cropNorm: CropNorm = {
      x: sel.x / imageEl.width,
      y: sel.y / imageEl.height,
      width: sel.width / imageEl.width,
      height: sel.height / imageEl.height,
    };
    // 빨간 박스 즉시 표시 — cropNorm 만 먼저 저장.
    setSlot(active.id, { cropNorm, error: undefined });

    // captureCrop 시도 — imgRef 가 dataURL 이면 즉시 OK, CDN URL 이면 SecurityError.
    const naturalBox = normToNaturalBox(
      cropNorm,
      imageEl.naturalWidth,
      imageEl.naturalHeight,
    );
    try {
      const croppedDataUrl = captureCrop(imageEl, naturalBox);
      setSlot(active.id, { croppedDataUrl });
      return;
    } catch {
      /* tainted — 풀 dataURL 받아 다시 시도 */
    }
    // 폴백: 풀 dataURL 다운로드 → 별도 Image 로 풀 해상도 기준 다시 환산해 자르기
    const fullSrc = await ensureFullDataUrlSource(active.id);
    if (!fullSrc) return;
    try {
      const fullImg = await loadImage(fullSrc);
      const fullBox = normToNaturalBox(
        cropNorm,
        fullImg.naturalWidth,
        fullImg.naturalHeight,
      );
      const croppedDataUrl = captureCrop(fullImg, fullBox);
      setSlot(active.id, { croppedDataUrl });
    } catch (e) {
      setSlot(active.id, { error: `자르기 실패: ${(e as Error).message}` });
    }
    // crop state 는 useEffect 가 active.cropNorm 변화 감지해 자동으로 다시 그려줌
  }

  /**
   * 빠른 휴리스틱 박스 — API 호출 없이 즉시 기본 크롭 비율 적용.
   * 태블릿 스크린샷 기준 (대부분 케이스 커버):
   *  - 상단 8% 제외 (앱 헤더/툴바)
   *  - 하단 6% 제외 (앱 네비/인디케이터)
   *  - 좌우 1% 베젤 제외
   * 사용자가 박스 모서리 1~2번 드래그로 미세조정 → AI 호출 1~2초 대비 0초.
   */
  const FAST_BOX_DEFAULT: CropNorm = { x: 0.01, y: 0.08, width: 0.98, height: 0.86 };

  async function detectBoxForSlot(s: Slot): Promise<void> {
    setSlot(s.id, { busy: "detecting", error: undefined });
    // 풀 소스가 이미 dataURL 이면 그대로, 아니면 잠깐 받아 자른다.
    // (캔버스 자르기를 풀 해상도로 해야 PDF 화질 유지)
    const src = s.sourceDataUrl?.startsWith("data:")
      ? s.sourceDataUrl
      : await ensureFullDataUrlSource(s.id);
    try {
      if (src) {
        const img = await loadImage(src);
        const naturalBox = normToNaturalBox(
          FAST_BOX_DEFAULT,
          img.naturalWidth,
          img.naturalHeight,
        );
        const croppedDataUrl = captureCrop(img, naturalBox);
        setSlot(s.id, { cropNorm: FAST_BOX_DEFAULT, croppedDataUrl, busy: null });
      } else {
        // 이미지 못 받았어도 박스 좌표만이라도 적용 (미리보기 박스 표시)
        setSlot(s.id, { cropNorm: FAST_BOX_DEFAULT, busy: null });
      }
    } catch (e) {
      setSlot(s.id, { busy: null, error: (e as Error).message });
    }
  }

  /**
   * 「전체 빠른 박스」 — 체크된 슬롯들에 픽셀 분석으로 자동 감지된 종이 영역 적용.
   * - 태블릿 베젤·앱 헤더·하단 툴바 자동 제외 (밝기·색상 분석)
   * - API 호출 0회, 보통 슬롯당 ~10~30ms
   * - 감지 실패 시 기본 비율(빠른 박스) 폴백
   * - 기존 cropNorm 이 있어도 덮어씀 (사용자가 일괄 재감지 의도)
   */
  async function detectAllBoxes() {
    const targets = slots.filter((s) => s.includeInPdf);
    if (targets.length === 0) {
      alert("체크된 페이지가 없습니다.");
      return;
    }
    const overwriteCount = targets.filter((t) => t.cropNorm).length;
    if (overwriteCount > 0) {
      if (
        !confirm(
          `체크된 ${targets.length}개 페이지에 자동 감지를 적용합니다 (이미 박스가 있는 ${overwriteCount}개는 덮어쓰기). 진행할까요?`,
        )
      )
        return;
    }
    setBulkBusy(true);
    try {
      for (const s of targets) {
        // 풀 dataURL 보장 (썸네일 URL 은 canvas tainted 위험)
        // eslint-disable-next-line no-await-in-loop
        const src = await ensureFullDataUrlSource(s.id);
        if (!src) continue;
        // 1차: 픽셀 분석으로 자동 감지
        // eslint-disable-next-line no-await-in-loop
        let cropNorm = await detectPaperBoxByPixels(src);
        // 2차: 감지 실패 시 기본 비율 폴백
        if (!cropNorm) cropNorm = FAST_BOX_DEFAULT;
        try {
          // eslint-disable-next-line no-await-in-loop
          const img = await loadImage(src);
          const naturalBox = normToNaturalBox(
            cropNorm,
            img.naturalWidth,
            img.naturalHeight,
          );
          const croppedDataUrl = captureCrop(img, naturalBox);
          setSlot(s.id, { cropNorm, croppedDataUrl });
        } catch {
          // 캔버스 자르기 실패 — 박스만이라도 저장
          setSlot(s.id, { cropNorm });
        }
      }
    } finally {
      setBulkBusy(false);
    }
  }

  // ── AI 박스 모방 (현재 슬롯 박스를 기준으로 나머지에 같은 의도 적용) ────
  async function mimicBoxFromActive() {
    if (!active?.cropNorm || !active?.croppedDataUrl) {
      alert("현재 페이지에 박스가 잡혀 있어야 합니다 (드래그 또는 AI 자동).");
      return;
    }
    // Gemini 는 base64 dataURL 필요
    const refSrc = await ensureFullDataUrlSource(active.id);
    if (!refSrc) {
      alert("기준 페이지 풀 원본을 불러오지 못했습니다.");
      return;
    }
    // cropNorm 자체가 정규화 0~1 — 그대로 Gemini 모방 API 의 referenceBox 로 전송
    const refBox = {
      nx: active.cropNorm.x,
      ny: active.cropNorm.y,
      nw: active.cropNorm.width,
      nh: active.cropNorm.height,
    };
    // 체크된 슬롯 전체 대상 (active 제외) — 기존 cropNorm 이 있어도 모방 결과로 덮어씀
    const targets = slots.filter((s) => s.id !== active.id && s.includeInPdf);
    if (targets.length === 0) {
      alert("모방 대상이 없습니다. 사이드바에서 같은 묶음 페이지들을 체크하세요.");
      return;
    }
    const overwriteCount = targets.filter((t) => t.cropNorm).length;
    if (overwriteCount > 0) {
      if (
        !confirm(
          `체크된 ${targets.length}개 페이지에 모방을 적용합니다 (이미 박스가 있는 ${overwriteCount}개는 덮어쓰기). 진행할까요?`,
        )
      ) {
        return;
      }
    }
    setBulkBusy(true);
    try {
      for (const s of targets) {
        // Gemini 는 base64 dataURL 필요 (CDN URL 직접 못 받음)
        // eslint-disable-next-line no-await-in-loop
        const tgtSrc = await ensureFullDataUrlSource(s.id);
        if (!tgtSrc) {
          setSlot(s.id, { busy: null, error: "원본 다운로드 실패" });
          continue;
        }
        setSlot(s.id, { busy: "mimicking", error: undefined });
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await fetch("/api/photo-edit/mimic-box", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              referenceImage: refSrc,
              referenceBox: refBox,
              targetImage: tgtSrc,
            }),
          });
          // eslint-disable-next-line no-await-in-loop
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || "박스 모방 실패");
          const tgtBox = data.box as { nx: number; ny: number; nw: number; nh: number };
          // Gemini 응답은 정규화 — 그대로 cropNorm
          const cropNorm: CropNorm = {
            x: tgtBox.nx,
            y: tgtBox.ny,
            width: tgtBox.nw,
            height: tgtBox.nh,
          };
          // eslint-disable-next-line no-await-in-loop
          const tgtImg = await loadImage(tgtSrc);
          const naturalBox = normToNaturalBox(
            cropNorm,
            tgtImg.naturalWidth,
            tgtImg.naturalHeight,
          );
          const croppedDataUrl = captureCrop(tgtImg, naturalBox);
          setSlot(s.id, { cropNorm, croppedDataUrl, busy: null });
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
    // 속도 최적화: 잘라낸 작은 이미지(헤더 영역) 우선 사용. 4MB 다운로드 회피.
    let sourceForName: string | null = active.croppedDataUrl;
    if (!sourceForName) {
      sourceForName = await ensureFullDataUrlSource(active.id);
    }
    if (!sourceForName) return;
    setSlot(active.id, { busy: "naming", error: undefined });
    // Gemini 직접 — 작은 이미지 + thinking 끔 + maxOutputTokens 256 으로 보통 1~2초.
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
  async function buildPdfBlob(opts?: { onlyChecked?: boolean }): Promise<Blob | null> {
    const onlyChecked = !!opts?.onlyChecked;
    const pages = slots
      .filter((s) => s.croppedDataUrl)
      .filter((s) => (onlyChecked ? s.includeInPdf : true))
      .sort((a, b) => a.pageNo - b.pageNo);
    if (pages.length === 0) {
      alert(
        onlyChecked
          ? "체크되어 있고 자르기가 적용된 페이지가 없습니다."
          : "자르기가 적용된 페이지가 없습니다.",
      );
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

  async function downloadPdf(opts?: { onlyChecked?: boolean }) {
    const blob = await buildPdfBlob(opts);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const suffix = opts?.onlyChecked ? "_체크" : "";
    a.download = `${sanitizeFilename(examName || "편집_시험지")}${suffix}.pdf`;
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

  async function uploadToDriveExamEditAfterFolder(opts?: { onlyChecked?: boolean }) {
    setSavingToDrive(true);
    setSaveResult(null);
    try {
      const blob = await buildPdfBlob(opts);
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

  // ── 페이지 마운트 시 Drive 자동 로드 — 사이드바에 모든 파일이 즉시 보이도록 ──
  useEffect(() => {
    void loadDriveFiles();
    // 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 활성 슬롯의 naturalBox → ReactCrop 표시용 percent crop 동기화 ──
  // 슬롯 전환 / box 변경 / 이미지 로드 완료 시 메인 캔버스에 빨간 박스가 자동 표시됨.
  // 이미지 자연 크기는 img 가 로드돼야 알 수 있어 imgLoadTick 으로 재트리거.
  const [imgLoadTick, setImgLoadTick] = useState(0);
  useEffect(() => {
    if (!active || !active.cropNorm) {
      setCrop(undefined);
      return;
    }
    // cropNorm 은 정규화 0~1 — 이미지 자연 크기와 무관하게 % 로 직접 변환 가능
    setCrop({
      unit: "%",
      x: active.cropNorm.x * 100,
      y: active.cropNorm.y * 100,
      width: active.cropNorm.width * 100,
      height: active.cropNorm.height * 100,
    });
  }, [
    active,
    active?.id,
    active?.cropNorm?.x,
    active?.cropNorm?.y,
    active?.cropNorm?.width,
    active?.cropNorm?.height,
    active?.sourceDataUrl,
    imgLoadTick,
  ]);

  // ── 활성 슬롯 풀 소스 지연 로드 — 사이드바에서 클릭한 순간 다운로드 ──
  useEffect(() => {
    if (!activeId) return;
    const idx = slots.findIndex((x) => x.id === activeId);
    if (idx < 0) return;
    const s = slots[idx];
    if (s.driveFileId && !s.sourceDataUrl) void ensureSlotSource(activeId);

    // 인접 슬롯 ±2 프리페치 — 사용자가 키보드 ↑↓/클릭 이동할 때 즉시 표시
    // 풀 다운로드는 안 함 (4MB×4 = 메모리·트래픽 부담). thumbnailLink s1600 만 미리 깔아둠.
    const neighbors = [idx - 2, idx - 1, idx + 1, idx + 2]
      .filter((i) => i >= 0 && i < slots.length && i !== idx)
      .map((i) => slots[i])
      .filter((n) => n.driveFileId && !n.sourceDataUrl);
    for (const n of neighbors) {
      if (!n.driveFileId) continue;
      const meta = driveFiles.find((d) => d.id === n.driveFileId);
      const isPdf =
        meta?.mimeType === "application/pdf" ||
        /\.pdf$/i.test(meta?.name ?? n.sourceLabel);
      if (isPdf || !meta?.thumbnailLink) continue;
      const bigUrl = meta.thumbnailLink.replace(/=s\d+(-[a-z])?$/, "=s1600");
      // 브라우저 백그라운드 디코드 — `<link rel=prefetch>` 효과
      // crossOrigin 미설정 → 실제 표시용 img 와 같은 cache 엔트리 사용 (matched cache)
      const img = new Image();
      img.src = bigUrl;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

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
              onClick={loadDriveFiles}
              disabled={driveStatus === "loading"}
              className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              title="Drive 「시험지 편집 전」 폴더 다시 읽어 사이드바에 추가"
            >
              {driveStatus === "loading" ? "불러오는 중…" : "🔄 Drive 새로고침"}
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

        {/* Drive 상태줄 — 사이드바에 자동 로드된 파일 수 안내 */}
        <div className="mt-2 text-[11px]">
          {driveStatus === "loading" && <span className="text-emerald-900">Drive 목록 로드 중…</span>}
          {driveStatus === "no-config" && (
            <span className="text-amber-900">
              Drive 키 미설정 — Railway Variables 에 GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN 등록 필요.
              {driveError ? ` (${driveError})` : ""}
            </span>
          )}
          {driveStatus === "no-folder" && (
            <span className="text-amber-900">
              「시험지 편집 전」 폴더가 Drive 에 없습니다.
              {driveError ? ` (${driveError})` : ""}
            </span>
          )}
          {driveStatus === "error" && <span className="text-rose-900">✗ {driveError ?? "Drive 오류"}</span>}
          {driveStatus === "ready" && (
            <span className="text-emerald-900">
              ✓ Drive 「시험지 편집 전」: <strong>{driveFiles.length}장</strong> 자동 로드됨 · 로컬:{" "}
              <strong>{slots.filter((s) => !s.driveFileId).length}장</strong> · 사이드바에서 묶음 선택 후 작업하세요.
            </span>
          )}
        </div>

        {loadingFile && <p className="mt-2 text-xs text-slate-600">파일 처리 중…</p>}
      </section>

      {/* 2단계: 슬롯 목록 + 작업 영역 — 항상 표시. Drive 자동 로드된 파일이 사이드바에 즉시 채워짐. */}
      {(
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
          {/* 좌측 슬롯 목록 — 사진 편집기 UX 차용 */}
          <aside className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-bold text-slate-900">
                페이지 순서 (드래그) · {slots.length}장
              </h2>
              <span className="text-[10px] text-emerald-700">
                체크 {slots.filter((s) => s.includeInPdf).length}
              </span>
            </div>

            {/* 전체 선택/해제 */}
            <div className="mb-2 grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={selectAllSlots}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
              >
                전체 선택
              </button>
              <button
                type="button"
                onClick={clearAllSelection}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
              >
                전체 해제
              </button>
            </div>

            {/* 범위 입력 */}
            <label className="block text-[11px] font-semibold text-slate-700">
              PDF 포함할 순서 번호
              <div className="mt-1 flex gap-1">
                <input
                  type="text"
                  value={rangeText}
                  onChange={(e) => setRangeText(e.target.value)}
                  placeholder="예: 1,3,5-8"
                  className="flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs font-normal"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyRangeToInclude(rangeText);
                  }}
                />
                <button
                  type="button"
                  onClick={() => applyRangeToInclude(rangeText)}
                  className="rounded border border-indigo-700 bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700"
                >
                  적용
                </button>
              </div>
            </label>
            <p className="mt-1 text-[10px] text-slate-500">
              「순서 N」 기준 1번부터. 비우고 적용하면 전체 해제. 1-4, 1~4, 5–10 모두 OK.
            </p>

            {/* 묶음 preset (학교·시험지 형식) */}
            <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2">
              <p className="text-[10px] font-semibold text-slate-700">미리 묶음 (학교·시험지 형식)</p>
              {presets.length === 0 ? (
                <p className="mt-1 text-[10px] text-slate-500">저장된 묶음 없음</p>
              ) : (
                <div className="mt-1 flex flex-wrap gap-1">
                  {presets.map((p) => (
                    <span
                      key={p.id}
                      className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10px]"
                    >
                      <button
                        type="button"
                        onClick={() => applyPreset(p)}
                        className="font-semibold text-slate-800 hover:text-indigo-700"
                        title={`범위 ${p.range} 적용`}
                      >
                        {p.name}{" "}
                        <span className="text-slate-500">({p.range})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => removePreset(p.id)}
                        className="text-slate-400 hover:text-rose-600"
                        title="묶음 삭제"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2 flex gap-1">
                <input
                  type="text"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  placeholder="묶음 이름 (예: ㅇㅇ중)"
                  className="flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs font-normal"
                />
                <button
                  type="button"
                  onClick={savePreset}
                  className="rounded border border-emerald-700 bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700"
                >
                  묶음 저장
                </button>
              </div>
              <p className="mt-1 text-[10px] text-slate-500">
                범위 입력 후 「묶음 저장」. 칩을 누르면 범위가 채워지고 바로 적용됩니다.
              </p>
            </div>

            {/* 페이지 카드 리스트 — 드래그 reorder + 체크박스 + 큰 썸네일 */}
            {slots.length === 0 ? (
              <p className="mt-3 rounded border border-dashed border-slate-300 p-3 text-center text-[11px] text-slate-500">
                Drive 「시험지 편집 전」 폴더가 비어 있거나 로드 중입니다.
                <br />
                위 「🔄 Drive 새로고침」 또는 「로컬 파일 추가」를 사용하세요.
              </p>
            ) : (
            <ul className="mt-3 max-h-[640px] space-y-1 overflow-y-auto">
              {slots.map((s, i) => {
                const orderIdx = i + 1; // 「순서 N」 = 현재 목록상 위치
                return (
                  <li
                    key={s.id}
                    draggable
                    onDragStart={() => onDragStartSlot(s.id)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => onDropSlot(s.id)}
                    onDragEnd={onDragEndSlot}
                    className={`flex cursor-pointer items-center gap-2 rounded border p-2 ${
                      draggingId === s.id
                        ? "border-amber-400 bg-amber-50 opacity-60"
                        : s.id === activeId
                          ? "border-indigo-500 bg-indigo-50"
                          : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                    onClick={() => setActiveId(s.id)}
                  >
                    {/* 드래그 핸들 표시 */}
                    <span
                      className="cursor-grab select-none text-slate-400"
                      title="드래그로 순서 변경"
                    >
                      ⋮⋮
                    </span>
                    {/* PDF 포함 체크박스 */}
                    <input
                      type="checkbox"
                      checked={s.includeInPdf}
                      onChange={(e) => setSlot(s.id, { includeInPdf: e.target.checked })}
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 cursor-pointer accent-indigo-600"
                      title="체크된 페이지만 「체크한 것만 PDF」 에 포함"
                    />
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={s.croppedDataUrl || s.thumbUrl || s.sourceDataUrl || ""}
                      alt={s.sourceLabel}
                      loading="lazy"
                      className="h-14 w-14 rounded border border-slate-200 bg-slate-100 object-cover"
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        // CDN 직접 URL 만료/실패 → 서버 프록시로 자동 폴백 (1회만)
                        const img = e.currentTarget as HTMLImageElement & { _fallback?: boolean };
                        if (img._fallback || !s.driveFileId) return;
                        img._fallback = true;
                        img.src = `/api/drive/thumb?fileId=${encodeURIComponent(s.driveFileId)}&size=320`;
                      }}
                    />
                    <div className="min-w-0 flex-1 text-[11px]">
                      <div className="flex items-center gap-1">
                        {s.includeInPdf ? (
                          // 체크된 슬롯: 「체크 N」 + 입력 필드 (타이핑으로 묶음 안에서 순서 지정)
                          (() => {
                            const co = checkedOrderOf(s);
                            const isEditing = orderEdit?.id === s.id;
                            const display = isEditing ? orderEdit!.value : String(co);
                            return (
                              <span
                                className="inline-flex items-center gap-0.5 rounded bg-emerald-200 px-1 text-[10px] font-bold text-emerald-900"
                                title="체크 묶음 안에서의 순서 — 타이핑으로 위치 변경"
                              >
                                체크
                                <input
                                  type="number"
                                  min={1}
                                  value={display}
                                  onClick={(e) => e.stopPropagation()}
                                  onFocus={(e) => {
                                    e.stopPropagation();
                                    setOrderEdit({ id: s.id, value: String(co) });
                                  }}
                                  onChange={(e) => {
                                    e.stopPropagation();
                                    setOrderEdit({ id: s.id, value: e.target.value });
                                  }}
                                  onBlur={(e) => {
                                    e.stopPropagation();
                                    if (orderEdit?.id === s.id) {
                                      const n = Number.parseInt(orderEdit.value, 10);
                                      if (Number.isFinite(n) && n >= 1) {
                                        setCheckedSlotOrder(s.id, n);
                                      }
                                      setOrderEdit(null);
                                    }
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      (e.currentTarget as HTMLInputElement).blur();
                                    } else if (e.key === "Escape") {
                                      setOrderEdit(null);
                                      (e.currentTarget as HTMLInputElement).blur();
                                    }
                                  }}
                                  className="w-9 rounded border border-emerald-300 bg-white px-0.5 text-center text-[10px] font-bold text-emerald-900"
                                />
                              </span>
                            );
                          })()
                        ) : (
                          <span className="rounded bg-slate-200 px-1 text-[10px] font-bold text-slate-800">
                            순서 {orderIdx}
                          </span>
                        )}
                        {s.driveFileId && (
                          <span
                            className="rounded bg-emerald-100 px-1 text-[9px] font-medium text-emerald-800"
                            title="Drive 출처 — 처리 후 휴지통으로 이동 가능"
                          >
                            Drive
                          </span>
                        )}
                        {s.trashed && (
                          <span className="rounded bg-rose-100 px-1 text-[9px] font-medium text-rose-700">
                            🗑 이동됨
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-slate-700" title={s.sourceLabel}>
                        {s.sourceLabel}
                      </div>
                      <div className="truncate text-slate-500">
                        {s.cropNorm ? "✓ 박스" : "박스 없음"}
                        {s.busy && ` · ${labelBusy(s.busy)}`}
                        {s.error && ` · ✗`}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      {s.driveFileId && !s.trashed && s.croppedDataUrl && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            trashOneSlot(s);
                          }}
                          disabled={s.busy === "trashing"}
                          className="rounded border border-rose-400 bg-white px-1.5 text-[11px] text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                          title="이 원본 한 개를 Drive 휴지통으로 이동"
                        >
                          🗑
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeSlot(s.id);
                        }}
                        disabled={s.busy === "trashing"}
                        className="rounded border border-rose-300 bg-white px-1.5 text-[10px] font-bold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                        title={
                          s.driveFileId && !s.trashed
                            ? "Drive 「휴지통」으로 이동 + 목록에서 제거 (실수 시 Drive 휴지통에서 복구 가능)"
                            : "목록에서 제거"
                        }
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            )}
          </aside>

          {/* 우측 작업 영역 */}
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => active && detectBoxForSlot(active)}
                  disabled={!active || active.busy === "detecting" || bulkBusy}
                  className="rounded-md border border-indigo-700 bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                  title="현재 페이지에 기본 크롭 비율 즉시 적용 (API 호출 없음, 0초). 모서리 드래그로 미세조정"
                >
                  ⚡ 빠른 박스
                </button>
                <button
                  onClick={detectAllBoxes}
                  disabled={bulkBusy || slots.every((s) => s.cropNorm)}
                  className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-50 disabled:opacity-50"
                  title="체크된 모든 페이지의 시험지 종이 영역을 픽셀 분석으로 자동 검출 — 베젤·앱 UI 자동 제외 (감지 실패 시 기본 비율 폴백)"
                >
                  {bulkBusy ? "처리 중…" : "🔍 전체 자동 감지"}
                </button>
                <button
                  onClick={mimicBoxFromActive}
                  disabled={!active?.cropNorm || bulkBusy}
                  className="rounded-md border border-purple-700 bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
                  title="현재 박스를 기준으로 나머지 페이지에 같은 의도의 박스 복제"
                >
                  🪄 기준 박스로 모방
                </button>
                <button
                  onClick={() => setPointMode((v) => !v)}
                  disabled={!active}
                  className={`rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
                    pointMode
                      ? "border-amber-700 bg-amber-500 text-white hover:bg-amber-600"
                      : "border-amber-300 bg-white text-amber-800 hover:bg-amber-50"
                  }`}
                  title="모서리 4개를 클릭하면 그 점들로 둘러싼 영역이 박스로 자동 설정됩니다"
                >
                  📍 4점 클릭{pointMode ? ` (${cornerPoints.length}/4)` : ""}
                </button>
                {pointMode && cornerPoints.length > 0 && (
                  <button
                    onClick={clearPointMarkers}
                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    title="찍은 점 모두 초기화"
                  >
                    초기화
                  </button>
                )}
                <span className="mx-1 h-5 w-px bg-slate-200" />
                <button
                  onClick={suggestNameForActive}
                  disabled={!active || active.busy === "naming"}
                  className="rounded-md border border-emerald-700 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  title="현재 페이지 헤더에서 시험명을 한 줄 형식으로 추출 → 묶음 이름 자동 채움"
                >
                  🏫 AI 학교명
                </button>
                <span className="mx-1 h-5 w-px bg-slate-200" />
                {/* PDF / 정리 액션 — 사진 편집기와 같은 위치 */}
                {/* 주 동작은 Drive 「시험지 편집 후」 업로드, 보조 동작은 로컬 다운로드 */}
                <button
                  onClick={() => uploadToDriveExamEditAfterFolder({ onlyChecked: true })}
                  disabled={
                    savingToDrive || !slots.some((s) => s.croppedDataUrl && s.includeInPdf)
                  }
                  className="rounded-md border border-indigo-700 bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
                  title="체크된 페이지를 묶어 Drive 「시험지 편집 후」 폴더에 PDF 로 업로드"
                >
                  {savingToDrive ? "업로드 중…" : "☁ 체크 PDF → Drive 「편집 후」"}
                </button>
                <button
                  onClick={() => downloadPdf({ onlyChecked: true })}
                  disabled={!slots.some((s) => s.croppedDataUrl && s.includeInPdf)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  title="체크된 페이지만 로컬 PDF 로 다운로드 (Drive 업로드 안 함)"
                >
                  💾 로컬 다운로드
                </button>
                <button
                  onClick={() => downloadPdf({ onlyChecked: false })}
                  disabled={!slots.some((s) => s.croppedDataUrl)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  title="자르기 적용된 모든 페이지를 로컬 PDF 로 다운로드"
                >
                  전체 PDF
                </button>
                <button
                  onClick={trashCheckedSlots}
                  disabled={
                    bulkBusy || slots.length === 0 || !slots.some((s) => s.includeInPdf)
                  }
                  className="rounded-md border border-rose-700 bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                  title="체크된 페이지들을 묶어 삭제 — Drive 원본은 「휴지통」 폴더로 이동(복구 가능)"
                >
                  🗑 선택항목 삭제
                </button>
                <button
                  onClick={clearAllSlots}
                  disabled={slots.length === 0}
                  className="rounded-md border border-rose-700 bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
                  title="모든 페이지를 비우기 (Drive 원본은 그대로)"
                >
                  전부 비우기
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
                active.sourceDataUrl ? (
                  <div className="overflow-auto rounded border border-slate-200 bg-slate-50 p-2">
                    {pointMode ? (
                      // 4점 클릭 모드 — ReactCrop 비활성, 클릭 캡처 + SVG 오버레이
                      <div
                        className="relative inline-block cursor-crosshair"
                        onClick={handlePointClick}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          ref={imgRef}
                          src={active.sourceDataUrl}
                          alt={active.sourceLabel}
                          className="block max-w-full select-none"
                          draggable={false}
                          onLoad={() => setImgLoadTick((t) => t + 1)}
                        />
                        {/* 점 + 연결선 SVG 오버레이 */}
                        {imgRef.current && (
                          <svg
                            className="pointer-events-none absolute left-0 top-0"
                            width={imgRef.current.width}
                            height={imgRef.current.height}
                          >
                            {cornerPoints.length > 1 && (
                              <polyline
                                points={cornerPoints.map((p) => `${p.x},${p.y}`).join(" ")}
                                fill="none"
                                stroke="rgba(245, 158, 11, 0.9)"
                                strokeWidth={2}
                                strokeDasharray="4 3"
                              />
                            )}
                            {cornerPoints.length === 4 && (
                              // 4번째 점 → 1번째로 닫힘선
                              <line
                                x1={cornerPoints[3].x}
                                y1={cornerPoints[3].y}
                                x2={cornerPoints[0].x}
                                y2={cornerPoints[0].y}
                                stroke="rgba(245, 158, 11, 0.9)"
                                strokeWidth={2}
                                strokeDasharray="4 3"
                              />
                            )}
                            {cornerPoints.map((p, i) => (
                              <g key={i}>
                                <circle
                                  cx={p.x}
                                  cy={p.y}
                                  r={8}
                                  fill="rgba(245, 158, 11, 0.95)"
                                  stroke="white"
                                  strokeWidth={2}
                                />
                                <text
                                  x={p.x}
                                  y={p.y + 3}
                                  textAnchor="middle"
                                  fontSize={10}
                                  fontWeight="bold"
                                  fill="white"
                                >
                                  {i + 1}
                                </text>
                              </g>
                            ))}
                          </svg>
                        )}
                      </div>
                    ) : (
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
                          onLoad={() => setImgLoadTick((t) => t + 1)}
                        />
                      </ReactCrop>
                    )}
                  </div>
                ) : (
                  <div className="rounded border border-emerald-200 bg-emerald-50 p-6 text-center text-xs text-emerald-900">
                    {active.busy === "loading"
                      ? "📥 Drive 에서 풀 이미지 다운로드 중…"
                      : "이 페이지의 풀 이미지가 아직 로드되지 않았습니다. 잠시 기다리거나 다시 클릭하세요."}
                    {active.error && (
                      <div className="mt-1 text-rose-700">✗ {active.error}</div>
                    )}
                  </div>
                )
              ) : (
                <p className="rounded border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
                  좌측 목록에서 페이지를 선택하세요. (Drive 자동 로드 후 슬롯 클릭하면 풀 이미지가 다운로드됩니다.)
                </p>
              )}
              <p className="mt-2 text-[11px] text-slate-500">
                🖱 드래그 → 즉시 자르기 · ⚡ 빠른 박스 → 기본 크롭비율 즉시 적용 (모서리 드래그로 미세조정) · 🪄 모방 → 현재 박스를 다른 체크 페이지에 복제
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
              <span className="font-semibold text-slate-800">Drive 업로드 / 휴지통 정리</span>
              <span className="ml-2 text-slate-600">
                자르기 적용 페이지 {slots.filter((s) => s.croppedDataUrl).length} / {slots.length}
                {" · "}체크 {slots.filter((s) => s.croppedDataUrl && s.includeInPdf).length}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => uploadToDriveExamEditAfterFolder({ onlyChecked: true })}
                disabled={
                  savingToDrive || !slots.some((s) => s.croppedDataUrl && s.includeInPdf)
                }
                className="rounded-md border border-indigo-700 bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
                title="체크된 페이지만 묶어 「시험지 편집 후」 폴더에 PDF 로 업로드"
              >
                {savingToDrive ? "업로드 중…" : "☁ 체크 PDF Drive 업로드"}
              </button>
              <button
                onClick={() => uploadToDriveExamEditAfterFolder({ onlyChecked: false })}
                disabled={savingToDrive || !slots.some((s) => s.croppedDataUrl)}
                className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-50 disabled:opacity-50"
                title="자르기 적용된 모든 페이지를 「시험지 편집 후」 폴더에 PDF 로 업로드"
              >
                전체 PDF Drive 업로드
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

/**
 * "1,3,5-8" → Set([1, 3, 5, 6, 7, 8])
 * - 분리자: , 또는 공백
 * - 범위: -, ~, –(en dash) 모두 허용
 * - maxN 을 넘으면 자름. 0/음수/뒤집힌 범위는 무시.
 */
function parsePageRanges(text: string, maxN: number): Set<number> {
  const out = new Set<number>();
  const tokens = String(text || "")
    .replace(/[~–]/g, "-")
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const n = Number.parseInt(tok, 10);
      if (n >= 1 && n <= maxN) out.add(n);
      continue;
    }
    const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) continue;
    let a = Number.parseInt(m[1], 10);
    let b = Number.parseInt(m[2], 10);
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(maxN, b); i++) out.add(i);
  }
  return out;
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

/**
 * 태블릿 스크린샷 안의 「흰 종이(시험지)」 영역을 픽셀 밝기 분석으로 자동 검출.
 * - 다운샘플 256px 캔버스에서 R≈G≈B + 밝기≥170 픽셀을 「종이」로 판정
 * - 행 점수(가로줄 종이 픽셀 비율) 가 0.4 이상인 가장 긴 연속 구간 = 종이 세로 범위
 * - 그 안에서 열 점수가 0.4 이상인 좌·우 끝 = 종이 가로 범위
 * - 헤더·하단 앱 UI(어두운 베젤·툴바·도구박스)는 자연스럽게 제외됨
 * - 실패 시 null → 호출자가 기본 비율 폴백
 *
 * 처리 시간: 1장당 ~10~30ms (API 호출 0).
 */
async function detectPaperBoxByPixels(imageDataUrl: string): Promise<CropNorm | null> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(imageDataUrl);
  } catch {
    return null;
  }
  const SAMPLE_W = 256;
  const sampleH = Math.max(64, Math.round((img.naturalHeight * SAMPLE_W) / img.naturalWidth));
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_W;
  canvas.height = sampleH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SAMPLE_W, sampleH);
  let imgData: ImageData;
  try {
    imgData = ctx.getImageData(0, 0, SAMPLE_W, sampleH);
  } catch {
    return null; // canvas tainted (cross-origin)
  }
  const data = imgData.data;

  const PAPER_BRIGHTNESS_MIN = 170;
  const PAPER_COLOR_VAR_MAX = 32;

  function isPaperPixel(x: number, y: number): boolean {
    const i = (y * SAMPLE_W + x) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const minRGB = Math.min(r, g, b);
    const maxRGB = Math.max(r, g, b);
    return minRGB >= PAPER_BRIGHTNESS_MIN && maxRGB - minRGB <= PAPER_COLOR_VAR_MAX;
  }

  // 행별 종이 픽셀 비율
  const rowScores = new Array<number>(sampleH);
  for (let y = 0; y < sampleH; y += 1) {
    let cnt = 0;
    for (let x = 0; x < SAMPLE_W; x += 1) {
      if (isPaperPixel(x, y)) cnt += 1;
    }
    rowScores[y] = cnt / SAMPLE_W;
  }

  // 행 점수 0.4 이상 연속구간 중 가장 긴 것 = 종이 세로 범위
  const ROW_THRESHOLD = 0.4;
  let bestStart = -1;
  let bestEnd = -1;
  let bestLen = 0;
  let curStart = -1;
  for (let y = 0; y < sampleH; y += 1) {
    if (rowScores[y] >= ROW_THRESHOLD) {
      if (curStart < 0) curStart = y;
    } else if (curStart >= 0) {
      const len = y - curStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = curStart;
        bestEnd = y - 1;
      }
      curStart = -1;
    }
  }
  if (curStart >= 0) {
    const len = sampleH - curStart;
    if (len > bestLen) {
      bestLen = len;
      bestStart = curStart;
      bestEnd = sampleH - 1;
    }
  }
  // 종이 너무 작으면 신뢰 불가 — 폴백
  if (bestStart < 0 || bestLen < sampleH * 0.2) return null;

  // 그 안에서 열별 종이 픽셀 비율 → 좌·우 끝
  const colScores = new Array<number>(SAMPLE_W);
  const sliceH = bestEnd - bestStart + 1;
  for (let x = 0; x < SAMPLE_W; x += 1) {
    let cnt = 0;
    for (let y = bestStart; y <= bestEnd; y += 1) {
      if (isPaperPixel(x, y)) cnt += 1;
    }
    colScores[x] = cnt / sliceH;
  }
  let leftX = 0;
  for (let x = 0; x < SAMPLE_W; x += 1) {
    if (colScores[x] >= ROW_THRESHOLD) {
      leftX = x;
      break;
    }
  }
  let rightX = SAMPLE_W - 1;
  for (let x = SAMPLE_W - 1; x >= 0; x -= 1) {
    if (colScores[x] >= ROW_THRESHOLD) {
      rightX = x;
      break;
    }
  }

  // 정규화 좌표 — 1px 안전 마진
  const x = Math.max(0, leftX / SAMPLE_W);
  const y = Math.max(0, bestStart / sampleH);
  const width = Math.min(1 - x, (rightX - leftX + 1) / SAMPLE_W);
  const height = Math.min(1 - y, (bestEnd - bestStart + 1) / sampleH);
  if (width < 0.2 || height < 0.2) return null;
  return { x, y, width, height };
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

/** Blob → 전체 dataURL 그대로 (data:mime;base64,...) — img.src 로 즉시 사용 가능 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
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
