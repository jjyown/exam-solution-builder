"use client";

/**
 * /textbook-ocr — 시중교재 PDF 선택 → 백그라운드 OCR.
 *
 * 자동 빌더(textbook-build-auto)가 비용 폭탄 위험으로 정지된 상황의 대안.
 * 사용자가 명시적으로 책을 골라 시작하면 Railway 서버가 백그라운드에서 순차 OCR.
 * PC/브라우저 꺼도 진행 — 나중에 다시 들어와서 진행률·결과 확인.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextbookOcrBookInfo, TextbookOcrBookStatus } from "../api/textbook-ocr/list/route";
import type { TextbookOcrProgress } from "@/lib/textbookOcrProgress";

type ProgressResponse = TextbookOcrProgress & { elapsedMs: number };

const STATUS_LABEL: Record<TextbookOcrBookStatus, { text: string; color: string }> = {
  untouched: { text: "미처리", color: "bg-slate-100 text-slate-600" },
  partial: { text: "부분", color: "bg-amber-100 text-amber-700" },
  completed: { text: "완료", color: "bg-emerald-100 text-emerald-700" },
  has_failures: { text: "실패 있음", color: "bg-rose-100 text-rose-700" },
};

function formatBytes(b: number): string {
  if (b === 0) return "-";
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}분 ${s}초` : `${s}초`;
}

export default function TextbookOcrPage() {
  const [books, setBooks] = useState<TextbookOcrBookInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [force, setForce] = useState(false);
  const [maxPages, setMaxPages] = useState<string>("");
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [expandedBook, setExpandedBook] = useState<string | null>(null);

  const isRunning = progress?.stage === "preparing" || progress?.stage === "processing";

  const loadBooks = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/textbook-ocr/list", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) {
        setLoadError(data.error ?? "책 목록 조회 실패");
        setBooks([]);
        return;
      }
      setBooks(data.books as TextbookOcrBookInfo[]);
    } catch (e) {
      setLoadError((e as Error).message);
      setBooks([]);
    }
  }, []);

  // 마운트 시 책 목록 + 진행률 한 번 조회 (외부 시스템에서 데이터 fetch — 정당한 effect 사용)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBooks();
    void (async () => {
      try {
        const res = await fetch("/api/textbook-ocr/progress", { cache: "no-store" });
        if (res.ok) setProgress(await res.json());
      } catch {
        /* silent */
      }
    })();
  }, [loadBooks]);

  // 진행 중이면 1.5초마다 progress 폴링
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!isRunning) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/textbook-ocr/progress", { cache: "no-store" });
        if (!res.ok) return;
        const next: ProgressResponse = await res.json();
        setProgress(next);
        // 끝났으면 책 목록 새로고침 (manifest 갱신 반영)
        if (next.stage === "completed" || next.stage === "failed") {
          void loadBooks();
        }
      } catch {
        /* silent */
      }
    }, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [isRunning, loadBooks]);

  const toggleBook = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectByStatus = useCallback(
    (predicate: (status: TextbookOcrBookStatus) => boolean) => {
      if (!books) return;
      const next = new Set<string>();
      for (const b of books) if (predicate(b.status)) next.add(b.id);
      setSelected(next);
    },
    [books],
  );

  const onStart = useCallback(
    async (overrideBookIds?: string[]) => {
      const bookIds = overrideBookIds ?? Array.from(selected);
      if (bookIds.length === 0) {
        setStartError("처리할 책을 1권 이상 선택하세요.");
        return;
      }
      setStarting(true);
      setStartError(null);
      try {
        const maxP = maxPages.trim() ? Number(maxPages.trim()) : 0;
        const res = await fetch("/api/textbook-ocr/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookIds,
            force: overrideBookIds ? true : force, // 책 단위 재처리 버튼은 항상 force
            maxPages: Number.isFinite(maxP) && maxP > 0 ? maxP : 0,
          }),
        });
        const data = await res.json();
        if (!data.ok) {
          setStartError(data.error ?? "시작 실패");
          if (data.progress) setProgress({ ...data.progress, elapsedMs: data.progress.elapsedMs ?? 0 });
          return;
        }
        // 시작 성공 — 폴링이 progress 알아서 받음
        setProgress({
          stage: "preparing",
          startedAt: Date.now(),
          updatedAt: Date.now(),
          totalBooks: bookIds.length,
          currentBookFolder: null,
          currentBookName: null,
          currentPageNo: 0,
          currentBookTotal: 0,
          successPageCount: 0,
          failedPageCount: 0,
          finishedBookCount: 0,
          result: null,
          error: null,
          elapsedMs: 0,
        });
      } catch (e) {
        setStartError((e as Error).message);
      } finally {
        setStarting(false);
      }
    },
    [selected, force, maxPages],
  );

  const selectedCount = selected.size;
  const startDisabled = isRunning || starting || selectedCount === 0;

  const stageLabel = useMemo(() => {
    if (!progress) return null;
    switch (progress.stage) {
      case "idle":
        return null;
      case "preparing":
        return "준비 중...";
      case "processing":
        return progress.currentBookName
          ? `${progress.currentBookName} — ${progress.currentPageNo}/${progress.currentBookTotal || "?"} 페이지`
          : "처리 중...";
      case "completed":
        return `완료 — 성공 ${progress.successPageCount}쪽 / 실패 ${progress.failedPageCount}쪽`;
      case "failed":
        return `실패: ${progress.error ?? "알 수 없는 오류"}`;
    }
  }, [progress]);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <h1 className="text-2xl font-bold">📚 교재 OCR</h1>
      <p className="mt-2 text-sm text-slate-600">
        Drive 「분석용 자료/시중교재」 폴더의 PDF 를 선택해 OCR 진행합니다. 시작 후 PC/브라우저 꺼도 Railway
        서버에서 자동으로 진행 — 나중에 다시 들어와서 진행률·결과를 확인할 수 있습니다.
      </p>

      {/* 진행률 패널 */}
      {progress && progress.stage !== "idle" && (
        <div
          className={`mt-4 rounded-lg border p-4 ${
            progress.stage === "completed"
              ? "border-emerald-300 bg-emerald-50"
              : progress.stage === "failed"
                ? "border-rose-300 bg-rose-50"
                : "border-indigo-300 bg-indigo-50"
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="font-semibold text-slate-800">{stageLabel}</div>
            <div className="text-xs text-slate-500">
              경과 {formatElapsed(progress.elapsedMs)} · 책 {progress.finishedBookCount}/{progress.totalBooks}
            </div>
          </div>
          {isRunning && progress.currentBookTotal > 0 && (
            <div className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-200">
              <div
                className="h-full bg-indigo-500 transition-all"
                style={{
                  width: `${Math.min(100, (progress.currentPageNo / progress.currentBookTotal) * 100)}%`,
                }}
              />
            </div>
          )}
          <div className="mt-2 text-xs text-slate-600">
            누적 성공 {progress.successPageCount}쪽 · 실패 {progress.failedPageCount}쪽
          </div>
        </div>
      )}

      {/* 컨트롤 */}
      <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-500">선택:</span>
        <button
          onClick={() => selectByStatus(() => true)}
          className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50"
          disabled={!books}
        >
          전체
        </button>
        <button
          onClick={() => selectByStatus((s) => s === "untouched")}
          className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50"
          disabled={!books}
        >
          미처리만
        </button>
        <button
          onClick={() => selectByStatus((s) => s === "partial")}
          className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50"
          disabled={!books}
        >
          부분 처리만
        </button>
        <button
          onClick={() => selectByStatus((s) => s === "has_failures")}
          className="rounded border border-rose-300 bg-white px-2 py-1 text-rose-700 hover:bg-rose-50"
          disabled={!books}
        >
          실패 있는 책만
        </button>
        <button
          onClick={() => setSelected(new Set())}
          className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-50"
        >
          선택 해제
        </button>
        <span className="ml-auto text-slate-500">{selectedCount}권 선택됨</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            disabled={isRunning}
          />
          <span>force 재처리 (이미 처리분도 처음부터)</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span>최대 페이지 (테스트)</span>
          <input
            type="number"
            min={0}
            value={maxPages}
            onChange={(e) => setMaxPages(e.target.value)}
            placeholder="0 = 무제한"
            className="w-24 rounded border border-slate-300 px-2 py-1"
            disabled={isRunning}
          />
        </label>
      </div>

      {/* 책 목록 테이블 */}
      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="w-10 px-2 py-2"></th>
              <th className="px-3 py-2 text-left">책 이름</th>
              <th className="px-3 py-2 text-right">크기</th>
              <th className="px-3 py-2 text-center">상태</th>
              <th className="px-3 py-2 text-right">진행도</th>
              <th className="px-3 py-2 text-right">실패</th>
              <th className="px-3 py-2 text-center">최근 빌드</th>
              <th className="px-3 py-2 text-center">동작</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!books && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                  책 목록 불러오는 중...
                </td>
              </tr>
            )}
            {books && loadError && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-rose-700">
                  목록 조회 실패: {loadError}
                </td>
              </tr>
            )}
            {books && !loadError && books.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-slate-500">
                  시중교재 폴더에 PDF 가 없습니다.
                </td>
              </tr>
            )}
            {books?.map((b) => {
              const status = STATUS_LABEL[b.status];
              const expanded = expandedBook === b.id;
              return (
                <>
                  <tr key={b.id} className="hover:bg-slate-50">
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={selected.has(b.id)}
                        onChange={() => toggleBook(b.id)}
                        disabled={isRunning}
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">{b.name}</td>
                    <td className="px-3 py-2 text-right text-slate-600">{formatBytes(b.sizeBytes)}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={`rounded px-2 py-0.5 text-xs font-semibold ${status.color}`}>
                        {status.text}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-slate-600">
                      {b.ocrMdCount}
                      {b.totalPages !== null ? ` / ${b.totalPages}` : ""}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {b.failedPages.length > 0 ? (
                        <button
                          onClick={() => setExpandedBook(expanded ? null : b.id)}
                          className="text-rose-700 underline hover:text-rose-900"
                        >
                          {b.failedPages.length}건 {expanded ? "▲" : "▼"}
                        </button>
                      ) : (
                        <span className="text-slate-400">0</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center text-xs text-slate-500">{formatDate(b.lastBuiltAt)}</td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => void onStart([b.id])}
                        disabled={isRunning || starting}
                        className="rounded border border-indigo-300 bg-white px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
                        title="이 책만 force 재처리"
                      >
                        재처리
                      </button>
                    </td>
                  </tr>
                  {expanded && b.failedPages.length > 0 && (
                    <tr key={`${b.id}-expanded`} className="bg-rose-50">
                      <td colSpan={8} className="px-3 py-2">
                        <div className="text-xs font-semibold text-rose-800">
                          실패한 페이지 ({b.failedPages.length}건):
                        </div>
                        <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-xs text-rose-700">
                          {b.failedPages.map((fp) => (
                            <li key={fp.page}>
                              <span className="font-mono">page {String(fp.page).padStart(3, "0")}</span> ·{" "}
                              <span className="text-rose-600">{fp.error || "(에러 메시지 없음)"}</span>
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 시작 버튼 + 에러 */}
      <div className="mt-6">
        <button
          onClick={() => void onStart()}
          disabled={startDisabled}
          className="w-full rounded-md bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {isRunning ? "처리 중..." : `선택한 ${selectedCount}권 OCR 시작`}
        </button>
        {startError && (
          <div className="mt-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {startError}
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          시작 후 브라우저를 닫거나 PC를 꺼도 Railway 서버에서 작업이 계속 진행됩니다. 다시 이 페이지에 들어오면
          진행률이 자동으로 표시됩니다.
        </p>
      </div>
    </div>
  );
}
