"use client";

/**
 * /inbox — 「이어서 작업」 탭
 *
 * 자동 해설 제작(/auto)·크롭 해설 제작(/crop) 모두 같은 `auto_pipeline_runs`
 * 테이블에 저장된다. 이 페이지는 그 이력을 시험명별로 묶어 보여주고,
 * 각 항목을 어디서든 이어 작업할 수 있도록 라우팅 버튼을 제공한다.
 *
 *  - 「크롭에서 이어서」: /crop?examName=<name> 으로 이동 (시험명 prefill)
 *  - 「자동에서 열기」 : /auto?restoreRun=<id> 로 이동 (해당 run 결과 복원)
 *  - 「📕 HWP / 묶음 HWP」  : /api/auto-pipeline/hml 호출 — 한컴 한글에서 바로 열림 (메인 포맷)
 *  - 「DOCX / 묶음 DOCX」  : /api/auto-pipeline/docx 호출 — 외부 공유·Drive 미리보기용 (보조)
 *  - 인라인 평점·메모 (★1~5 + 💬) : /api/auto-pipeline/feedback 호출 — /auto 로 옮겨가지 않고
 *    이 페이지에서 바로 평가 저장. 별 클릭은 즉시 POST + 낙관적 UI, 메모는 토글 sub-row 입력.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type RunRow = {
  id: string;
  created_at: string;
  exam_name: string | null;
  question_no: string | null;
  question_text: string;
  model: string;
  ok: boolean;
  attempts: number;
  user_rating: number | null;
  reviewed_at: string | null;
  parsed?: {
    answer?: string;
    explanation_steps?: Array<{ text: string; equation?: string }>;
    summary?: string;
  } | null;
  errors?: string[] | null;
};

type SupabaseStatus = "ok" | "no-env" | "no-table" | "error";

type ApiResponse = {
  ok: boolean;
  supabase: SupabaseStatus;
  error?: string;
  runs: RunRow[];
};

type Filter = "all" | "ok" | "fail" | "unreviewed" | "low-rated";

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleString("ko-KR", { hour12: false });
  } catch {
    return iso;
  }
}

function questionPreview(text: string, max = 80) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * 그룹 자동 접힘 임계값 — 한 시험명에 이만큼 이상 모이면 기본 접힘 상태로.
 * 사용자가 개별 토글한 그룹은 expandedOverrides Map 으로 우선 적용된다.
 */
const AUTO_COLLAPSE_THRESHOLD = 8;
const EXPANDED_STORAGE_KEY = "highroad-inbox:expanded-overrides:v1";

export default function InboxPage() {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [supaStatus, setSupaStatus] = useState<SupabaseStatus | null>(null);
  const [supaError, setSupaError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busyDocxId, setBusyDocxId] = useState<string | null>(null);
  // ── 인라인 평가 상태 ────────────────────────────────────────────────────
  // 「자동에서 열기」로 옮겨 가지 않고 이 페이지에서 바로 별점·메모를 저장.
  // 별 클릭은 즉시 POST → 낙관적 업데이트(rows 의 user_rating·reviewed_at 갱신).
  // 메모는 토글로 펼치는 sub-row 에서 입력 → [저장] 버튼.
  const [openMemoIds, setOpenMemoIds] = useState<Set<string>>(new Set());
  const [memoText, setMemoText] = useState<Record<string, string>>({});
  const [feedbackBusyId, setFeedbackBusyId] = useState<string | null>(null);
  /** 마지막으로 저장된 시각(ms) — UI 「✓ 저장됨」 일시 표시. */
  const [feedbackSavedAt, setFeedbackSavedAt] = useState<Record<string, number>>({});

  function toggleMemo(id: string) {
    setOpenMemoIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 별점만 단독 저장 — 클릭 즉시 POST + 낙관적 UI. 메모는 별도 저장 흐름. */
  async function saveRatingInline(row: RunRow, nextRating: number | null) {
    if (!row.id) return;
    // 낙관적 업데이트 — 실패해도 서버 응답으로 다시 갱신할 일은 거의 없으니 즉시 반영
    setRows((prev) =>
      prev.map((r) =>
        r.id === row.id
          ? { ...r, user_rating: nextRating, reviewed_at: r.reviewed_at ?? new Date().toISOString() }
          : r,
      ),
    );
    setFeedbackBusyId(row.id);
    try {
      const res = await fetch("/api/auto-pipeline/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: row.id,
          userRating: nextRating ?? undefined,
          // 별점만 바꿀 때 메모는 손대지 않음
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) {
        alert(`별점 저장 실패: ${data.error ?? res.statusText}`);
        // 실패 시 원복
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, user_rating: row.user_rating } : r)));
        return;
      }
      setFeedbackSavedAt((prev) => ({ ...prev, [row.id]: Date.now() }));
    } catch (e) {
      alert(`별점 저장 실패: ${(e as Error).message}`);
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, user_rating: row.user_rating } : r)));
    } finally {
      setFeedbackBusyId(null);
    }
  }

  /** 메모(자유 텍스트) 저장 — 현재 별점도 함께 보내(서버 측 reviewed_at 갱신). */
  async function saveMemoInline(row: RunRow) {
    const note = (memoText[row.id] ?? "").trim();
    if (!note) {
      alert("메모를 입력하세요.");
      return;
    }
    setFeedbackBusyId(row.id);
    try {
      const res = await fetch("/api/auto-pipeline/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: row.id,
          userRating: row.user_rating ?? undefined,
          userFeedback: note,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) {
        alert(`메모 저장 실패: ${data.error ?? res.statusText}`);
        return;
      }
      setFeedbackSavedAt((prev) => ({ ...prev, [row.id]: Date.now() }));
      // reviewed_at 도 갱신 — 메모 저장 후 「검수됨」으로 보이도록
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id ? { ...r, reviewed_at: new Date().toISOString() } : r,
        ),
      );
    } catch (e) {
      alert(`메모 저장 실패: ${(e as Error).message}`);
    } finally {
      setFeedbackBusyId(null);
    }
  }
  /**
   * 사용자가 명시적으로 토글한 그룹 — examName → true(펼침) | false(접힘).
   * 명시 안 된 그룹은 AUTO_COLLAPSE_THRESHOLD 규칙으로 결정.
   * localStorage 영속화 — 새로고침 후에도 유지.
   */
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});

  // 마운트 시 localStorage 에서 복원
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
      if (raw) setExpandedOverrides(JSON.parse(raw));
    } catch {
      /* best-effort */
    }
  }, []);

  // overrides 바뀌면 즉시 저장
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(expandedOverrides));
    } catch {
      /* QuotaExceeded 등 — 조용히 무시 */
    }
  }, [expandedOverrides]);

  /**
   * 그룹 확장 여부 판단:
   *  1) override 있으면 그 값 우선
   *  2) 없으면 AUTO_COLLAPSE_THRESHOLD 미만일 때만 기본 펼침
   */
  function isExpanded(examName: string, count: number): boolean {
    if (Object.prototype.hasOwnProperty.call(expandedOverrides, examName)) {
      return expandedOverrides[examName];
    }
    return count < AUTO_COLLAPSE_THRESHOLD;
  }

  function toggleGroup(examName: string, currentCount: number) {
    const wasExpanded = isExpanded(examName, currentCount);
    setExpandedOverrides((prev) => ({ ...prev, [examName]: !wasExpanded }));
  }

  function expandAll(names: string[]) {
    setExpandedOverrides((prev) => {
      const next = { ...prev };
      for (const n of names) next[n] = true;
      return next;
    });
  }

  function collapseAll(names: string[]) {
    setExpandedOverrides((prev) => {
      const next = { ...prev };
      for (const n of names) next[n] = false;
      return next;
    });
  }

  function resetGroupOverrides() {
    setExpandedOverrides({});
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch("/api/auto-pipeline/feedback?limit=200", { cache: "no-store" });
        const data = (await res.json()) as ApiResponse;
        if (cancelled) return;
        setSupaStatus(data.supabase ?? "ok");
        setSupaError(data.error);
        setRows(Array.isArray(data.runs) ? data.runs : []);
      } catch (e) {
        if (cancelled) return;
        setSupaStatus("error");
        setSupaError((e as Error).message);
        setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "ok" && !r.ok) return false;
      if (filter === "fail" && r.ok) return false;
      if (filter === "unreviewed" && r.reviewed_at) return false;
      if (filter === "low-rated" && (r.user_rating == null || r.user_rating > 2)) return false;
      if (!q) return true;
      const hay = `${r.exam_name ?? ""} ${r.question_no ?? ""} ${r.question_text ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search, filter]);

  // 시험명 → row[] 그룹화. 시험명 없는 것은 「(시험명 미지정)」 으로.
  const grouped = useMemo(() => {
    const map = new Map<string, RunRow[]>();
    for (const r of filtered) {
      const key = (r.exam_name ?? "").trim() || "(시험명 미지정)";
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    // 그룹 순서: 그룹 안 가장 최근 created_at 기준 desc
    return Array.from(map.entries()).sort((a, b) => {
      const aTop = a[1][0]?.created_at ?? "";
      const bTop = b[1][0]?.created_at ?? "";
      return bTop.localeCompare(aTop);
    });
  }, [filtered]);

  /**
   * 단건 / 묶음 다운로드의 공통 본체.
   *  format='hml'  → /api/auto-pipeline/hml  (한컴 한글 — 메인 포맷)
   *  format='docx' → /api/auto-pipeline/docx (외부 공유·Drive 미리보기 — 보조)
   *
   *  busyId 는 「어떤 row/group 가 다운로드 중인지」 식별. 단건이면 row.id, 묶음이면 `group:<examName>`.
   *  /auto 와 /crop 의 다운로드 흐름과 정확히 같은 엔드포인트·페이로드를 사용한다.
   */
  async function downloadFile(
    format: "hml" | "docx",
    examName: string,
    runs: Array<{ questionNo: string; questionText: string; parsed: NonNullable<RunRow["parsed"]> }>,
    busyId: string,
    fallbackName: string,
  ) {
    if (runs.length === 0) {
      alert(
        format === "hml"
          ? "HWP 로 만들 결과가 없습니다 (parsed 비어 있음)."
          : "DOCX 로 만들 결과가 없습니다 (parsed 비어 있음).",
      );
      return;
    }
    setBusyDocxId(busyId);
    try {
      const endpoint =
        format === "hml" ? "/api/auto-pipeline/hml" : "/api/auto-pipeline/docx";
      const labelUpper = format === "hml" ? "HWP/HML" : "DOCX";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examName, runs }),
      });
      if (!res.ok) {
        const t = await res.text();
        alert(`${labelUpper} 생성 실패: ${t.slice(0, 200)}`);
        return;
      }
      const blob = await res.blob();
      // /auto 와 동일 — 서버가 content-disposition 으로 파일명 줄 때 그것 우선
      const cd = res.headers.get("content-disposition") ?? "";
      const filenameMatch = cd.match(/filename="?([^";]+)"?/);
      const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : fallbackName;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`${format === "hml" ? "HWP" : "DOCX"} 다운로드 실패: ${(e as Error).message}`);
    } finally {
      setBusyDocxId(null);
    }
  }

  async function downloadSingle(format: "hml" | "docx", row: RunRow) {
    if (!row.parsed) return;
    const safeExam = (row.exam_name ?? "해설").replace(/[\\/:*?"<>|]/g, "_");
    const qn = row.question_no ?? "단건";
    const fallback = `${safeExam}_${qn}.${format}`;
    await downloadFile(
      format,
      row.exam_name ?? "",
      [
        {
          questionNo: row.question_no ?? "?",
          questionText: row.question_text ?? "",
          parsed: row.parsed,
        },
      ],
      row.id,
      fallback,
    );
  }

  async function downloadGroup(format: "hml" | "docx", examName: string, groupRows: RunRow[]) {
    const valid = groupRows.filter((r) => r.parsed);
    const safeExam = examName.replace(/[\\/:*?"<>|]/g, "_");
    const fallback = `${safeExam}_묶음.${format}`;
    const sorted = valid
      .slice()
      .sort((a, b) => {
        const ai = parseInt(a.question_no || "0", 10) || 0;
        const bi = parseInt(b.question_no || "0", 10) || 0;
        return ai - bi;
      })
      .map((r) => ({
        questionNo: r.question_no ?? "?",
        questionText: r.question_text ?? "",
        parsed: r.parsed!,
      }));
    await downloadFile(format, examName, sorted, `group:${examName}`, fallback);
  }

  // 호출 편의 wrapper — 기존 함수명 유지(버튼 핸들러 변경 최소화)
  const downloadSingleHml = (row: RunRow) => downloadSingle("hml", row);
  const downloadSingleDocx = (row: RunRow) => downloadSingle("docx", row);
  const downloadGroupHml = (examName: string, groupRows: RunRow[]) =>
    downloadGroup("hml", examName, groupRows);
  const downloadGroupDocx = (examName: string, groupRows: RunRow[]) =>
    downloadGroup("docx", examName, groupRows);


  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            <span>📌</span> 이어서 작업
          </h1>
          <p className="mt-1 text-xs text-slate-600">
            「해설 제작」·「크롭」에서 진행했던 풀이 이력을 시험명별로 묶어 보여줍니다.
            클릭 한 번으로 자동/크롭 화면으로 돌아가거나 <strong>HWP (메인)</strong> · DOCX (보조) 로 바로 받을 수 있습니다.
          </p>
        </div>
        <button
          onClick={() => setRefreshTick((n) => n + 1)}
          className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          ↻ 새로고침
        </button>
      </div>

      {/* Supabase 상태 배너 */}
      {supaStatus && supaStatus !== "ok" && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          {supaStatus === "no-env" && (
            <>
              Supabase 환경변수가 설정되지 않았습니다 — 이력이 영속화되지 않습니다.{" "}
              <code className="rounded bg-amber-100 px-1">NEXT_PUBLIC_SUPABASE_URL</code>,{" "}
              <code className="rounded bg-amber-100 px-1">SUPABASE_SERVICE_ROLE_KEY</code> 를 Railway 에 추가하세요.
            </>
          )}
          {supaStatus === "no-table" && (
            <>
              <code className="rounded bg-amber-100 px-1">auto_pipeline_runs</code> 테이블이 없습니다 —
              <code className="ml-1 rounded bg-amber-100 px-1">supabase/auto_pipeline_runs.sql</code> 를 실행하세요.
              {supaError && <span className="ml-2 text-amber-700">({supaError})</span>}
            </>
          )}
          {supaStatus === "error" && (
            <>이력 조회 실패: {supaError ?? "알 수 없는 오류"}</>
          )}
        </div>
      )}

      {/* 필터 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="시험명·문항·문제 본문 검색"
          className="w-72 rounded border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none"
        />
        <div className="flex items-center gap-1 rounded border border-slate-200 bg-white p-0.5 text-[11px] font-semibold">
          {(
            [
              ["all", "전체"],
              ["ok", "성공"],
              ["fail", "실패"],
              ["unreviewed", "미검수"],
              ["low-rated", "낮은 평점"],
            ] as Array<[Filter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`rounded px-2.5 py-1 transition-colors ${
                filter === key
                  ? "bg-indigo-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* 그룹 일괄 펼침/접힘 — 그룹이 2개 이상일 때만 의미 있음 */}
        {grouped.length > 1 && (
          <div className="flex items-center gap-1 text-[11px]">
            <button
              onClick={() => expandAll(grouped.map(([n]) => n))}
              className="rounded border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50"
              title="모든 시험명 그룹을 펼칩니다"
            >
              ⤓ 모두 펴기
            </button>
            <button
              onClick={() => collapseAll(grouped.map(([n]) => n))}
              className="rounded border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50"
              title="모든 시험명 그룹을 접습니다"
            >
              ⤒ 모두 접기
            </button>
            {Object.keys(expandedOverrides).length > 0 && (
              <button
                onClick={resetGroupOverrides}
                className="rounded border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-500 hover:bg-slate-50"
                title={`기본 규칙(${AUTO_COLLAPSE_THRESHOLD}건 이상이면 자동 접힘) 으로 되돌립니다`}
              >
                ↺ 기본
              </button>
            )}
          </div>
        )}
        <div className="ml-auto text-xs text-slate-500">
          {loading ? "불러오는 중…" : `${filtered.length}건 / 총 ${rows.length}건`}
        </div>
      </div>

      {/* 빈 상태 */}
      {!loading && grouped.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          {rows.length === 0
            ? "아직 영속화된 이력이 없습니다. 「해설 제작」 또는 「크롭」 에서 풀이를 한 번 실행해보세요."
            : "검색 조건에 맞는 이력이 없습니다."}
        </div>
      )}

      {/* 그룹 카드 */}
      <div className="space-y-4">
        {grouped.map(([examName, groupRows]) => {
          const okCount = groupRows.filter((r) => r.ok).length;
          const reviewedCount = groupRows.filter((r) => r.reviewed_at).length;
          const isUngrouped = examName === "(시험명 미지정)";
          const cropHref = isUngrouped ? "/crop" : `/crop?examName=${encodeURIComponent(examName)}`;
          const expanded = isExpanded(examName, groupRows.length);
          return (
            <div
              key={examName}
              className="overflow-hidden rounded-lg border border-slate-200 bg-white"
            >
              <div
                className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5 hover:bg-slate-100"
                onClick={() => toggleGroup(examName, groupRows.length)}
                role="button"
                tabIndex={0}
                aria-expanded={expanded}
                aria-controls={`inbox-group-body-${encodeURIComponent(examName)}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggleGroup(examName, groupRows.length);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <div className="flex items-center gap-2">
                  {/* 펼침/접힘 화살표 — 클릭은 부모 div 가 받음 */}
                  <span
                    aria-hidden
                    className={`inline-block w-3 text-[11px] text-slate-500 transition-transform ${
                      expanded ? "rotate-90" : ""
                    }`}
                  >
                    ▶
                  </span>
                  <div>
                    <div className="text-sm font-bold text-slate-800">{examName}</div>
                    <div className="text-[11px] text-slate-500">
                      {groupRows.length}건 · 성공 {okCount} / 검수 {reviewedCount}
                      {!expanded && (
                        <span className="ml-2 text-slate-400">— 클릭해 펼치기</span>
                      )}
                    </div>
                  </div>
                </div>
                {/* 액션 버튼들 — 헤더 토글에서 제외 (stopPropagation) */}
                <div
                  className="flex items-center gap-1.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Link
                    href={cropHref}
                    className="rounded border border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50"
                  >
                    ✂ 크롭에서 이어서
                  </Link>
                  {/* HWP — 메인 포맷 (한컴 한글). /auto 와 동일 스타일. */}
                  <button
                    onClick={() => downloadGroupHml(examName, groupRows)}
                    disabled={busyDocxId === `group:${examName}`}
                    className="rounded border border-indigo-700 bg-indigo-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-800 disabled:opacity-60"
                    title="이 시험명 묶음을 HWP/HML 로 다운로드 — 한컴 한글에서 바로 열림 (메인 포맷)"
                  >
                    {busyDocxId === `group:${examName}` ? "묶는 중…" : "📕 묶음 HWP"}
                  </button>
                  {/* DOCX — 보조 포맷. */}
                  <button
                    onClick={() => downloadGroupDocx(examName, groupRows)}
                    disabled={busyDocxId === `group:${examName}`}
                    className="rounded border border-slate-400 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                    title="외부 공유·Drive 미리보기용 (보조 포맷). 학원 내부 작업은 HWP 권장"
                  >
                    묶음 DOCX
                  </button>
                </div>
              </div>
              {expanded && (
              <table
                id={`inbox-group-body-${encodeURIComponent(examName)}`}
                className="w-full text-xs"
              >
                <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-1.5">문항</th>
                    <th className="px-3 py-1.5">시각</th>
                    <th className="px-3 py-1.5">모델</th>
                    <th className="px-3 py-1.5">결과</th>
                    <th className="px-3 py-1.5">평점</th>
                    <th className="px-3 py-1.5">미리보기</th>
                    <th className="px-3 py-1.5 text-right">액션</th>
                  </tr>
                </thead>
                <tbody>
                  {groupRows
                    .slice()
                    .sort((a, b) => {
                      const ai = parseInt(a.question_no || "0", 10) || 0;
                      const bi = parseInt(b.question_no || "0", 10) || 0;
                      if (ai !== bi) return ai - bi;
                      return b.created_at.localeCompare(a.created_at);
                    })
                    .map((r) => {
                      const docxBtnDisabled = !r.parsed || busyDocxId === r.id;
                      const memoOpen = openMemoIds.has(r.id);
                      const ratingBusy = feedbackBusyId === r.id;
                      const savedRecently =
                        feedbackSavedAt[r.id] && Date.now() - feedbackSavedAt[r.id] < 3000;
                      return (
                        <Fragment key={r.id}>
                        <tr className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2 font-bold text-slate-800">
                            {r.question_no ?? "-"}
                          </td>
                          <td className="px-3 py-2 text-slate-500">{fmtTime(r.created_at)}</td>
                          <td className="px-3 py-2 text-slate-700">
                            {r.model?.startsWith("vision:") ? (
                              <span title="비전 모드 — Gemini Vision 직접 풀이 (OCR 단계 생략)">
                                <span className="mr-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">
                                  🔭 비전
                                </span>
                                <span className="text-[11px]">{r.model.slice(7)}</span>
                              </span>
                            ) : (
                              r.model
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={
                                r.ok ? "text-emerald-700" : "text-rose-700"
                              }
                              title={
                                r.errors && r.errors.length
                                  ? r.errors.join(" / ")
                                  : undefined
                              }
                            >
                              {r.ok ? "✓ 성공" : "✗ 실패"} · {r.attempts}회
                            </span>
                          </td>
                          {/* 평점 셀 — 인라인 별점 + 메모 토글. 클릭 즉시 저장. */}
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-0.5">
                              {[1, 2, 3, 4, 5].map((n) => {
                                const filled = (r.user_rating ?? 0) >= n;
                                return (
                                  <button
                                    key={n}
                                    type="button"
                                    onClick={() =>
                                      saveRatingInline(
                                        r,
                                        // 같은 별 다시 누르면 별점 해제(null) — 실수 보정용
                                        r.user_rating === n ? null : n,
                                      )
                                    }
                                    disabled={ratingBusy}
                                    className={`text-base leading-none transition-transform hover:scale-110 disabled:opacity-50 ${
                                      filled ? "text-amber-500" : "text-slate-300 hover:text-amber-300"
                                    }`}
                                    title={`${n}점 — ${n === 1 ? "재생성 필요" : n === 5 ? "그대로 사용" : "보통"}`}
                                  >
                                    ★
                                  </button>
                                );
                              })}
                              <button
                                type="button"
                                onClick={() => toggleMemo(r.id)}
                                className={`ml-1 rounded px-1 py-0.5 text-[10px] font-semibold ${
                                  memoOpen
                                    ? "bg-indigo-600 text-white"
                                    : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                                }`}
                                title="이 결과에 대한 메모(피드백) 입력"
                              >
                                💬
                              </button>
                            </div>
                            <div className="mt-0.5 text-[10px] text-slate-500">
                              {ratingBusy ? "저장 중…" : savedRecently ? "✓ 저장됨" : r.reviewed_at ? "검수됨" : ""}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-slate-600">
                            {questionPreview(r.question_text)}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap justify-end gap-1">
                              <Link
                                href={`/auto?restoreRun=${encodeURIComponent(r.id)}`}
                                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                                title="자동 해설 페이지에서 이 결과를 복원 (풍부한 검수·재시도 패널)"
                              >
                                자동에서 열기
                              </Link>
                              {/* HWP — 메인 포맷 (한컴 한글). */}
                              <button
                                onClick={() => downloadSingleHml(r)}
                                disabled={docxBtnDisabled}
                                className="rounded border border-indigo-700 bg-indigo-700 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
                                title={r.parsed ? "이 풀이를 HWP/HML 단건 다운로드 — 한컴에서 바로 열림 (메인)" : "parsed 결과가 없어 HWP 생성 불가"}
                              >
                                {busyDocxId === r.id ? "받는 중…" : "📕 HWP"}
                              </button>
                              {/* DOCX — 보조 포맷. */}
                              <button
                                onClick={() => downloadSingleDocx(r)}
                                disabled={docxBtnDisabled}
                                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                title={r.parsed ? "이 풀이를 DOCX 단건 다운로드 (외부 공유·Drive 미리보기용 보조)" : "parsed 결과가 없어 DOCX 생성 불가"}
                              >
                                {busyDocxId === r.id ? "받는 중…" : "DOCX"}
                              </button>
                            </div>
                          </td>
                        </tr>
                        {/* 메모 입력 sub-row — 토글 시 colspan 으로 펼침 */}
                        {memoOpen && (
                          <tr className="border-t border-slate-50 bg-indigo-50/40">
                            <td colSpan={7} className="px-3 py-2">
                              <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start">
                                <textarea
                                  value={memoText[r.id] ?? ""}
                                  onChange={(e) =>
                                    setMemoText((prev) => ({ ...prev, [r.id]: e.target.value }))
                                  }
                                  placeholder="이 결과에 대한 메모 — 객관식인데 단답으로 답함, 선지 누락, 풀이 단계 비약 등. 다음 풀이 호출 프롬프트에 같은 문항 피드백으로 반영됩니다."
                                  rows={2}
                                  className="flex-1 rounded border border-indigo-200 bg-white p-1.5 text-[11px] focus:border-indigo-500 focus:outline-none"
                                />
                                <div className="flex items-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => saveMemoInline(r)}
                                    disabled={ratingBusy || !(memoText[r.id] ?? "").trim()}
                                    className="rounded border border-indigo-700 bg-indigo-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
                                  >
                                    {ratingBusy ? "저장 중…" : "메모 저장"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => toggleMemo(r.id)}
                                    className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                                  >
                                    닫기
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                </tbody>
              </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
