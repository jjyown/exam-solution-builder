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
 *  - 「DOCX 단건」    : /api/auto-pipeline/docx 호출 (즉시 다운로드)
 */
import { useEffect, useMemo, useState } from "react";
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

export default function InboxPage() {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [supaStatus, setSupaStatus] = useState<SupabaseStatus | null>(null);
  const [supaError, setSupaError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busyDocxId, setBusyDocxId] = useState<string | null>(null);

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

  async function downloadSingleDocx(row: RunRow) {
    if (!row.parsed) return;
    setBusyDocxId(row.id);
    try {
      const res = await fetch("/api/auto-pipeline/docx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examName: row.exam_name ?? "",
          runs: [
            {
              questionNo: row.question_no ?? "?",
              questionText: row.question_text ?? "",
              parsed: row.parsed,
            },
          ],
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        alert(`DOCX 생성 실패: ${t.slice(0, 200)}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeExam = (row.exam_name ?? "해설").replace(/[\\/:*?"<>|]/g, "_");
      const qn = row.question_no ?? "단건";
      a.download = `${safeExam}_${qn}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`DOCX 다운로드 실패: ${(e as Error).message}`);
    } finally {
      setBusyDocxId(null);
    }
  }

  async function downloadGroupDocx(examName: string, groupRows: RunRow[]) {
    const valid = groupRows.filter((r) => r.parsed);
    if (valid.length === 0) {
      alert("이 시험명에 DOCX 로 만들 결과가 없습니다 (parsed 비어 있음).");
      return;
    }
    setBusyDocxId(`group:${examName}`);
    try {
      const res = await fetch("/api/auto-pipeline/docx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examName,
          runs: valid
            .slice()
            .sort((a, b) => {
              const ai = parseInt(a.question_no || "0", 10) || 0;
              const bi = parseInt(b.question_no || "0", 10) || 0;
              return ai - bi;
            })
            .map((r) => ({
              questionNo: r.question_no ?? "?",
              questionText: r.question_text ?? "",
              parsed: r.parsed,
            })),
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        alert(`DOCX 생성 실패: ${t.slice(0, 200)}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeExam = examName.replace(/[\\/:*?"<>|]/g, "_");
      a.download = `${safeExam}_묶음.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`DOCX 다운로드 실패: ${(e as Error).message}`);
    } finally {
      setBusyDocxId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-800">
            <span>📌</span> 이어서 작업
          </h1>
          <p className="mt-1 text-xs text-slate-600">
            「해설 제작」·「크롭」에서 진행했던 풀이 이력을 시험명별로 묶어 보여줍니다.
            클릭 한 번으로 자동/크롭 화면으로 돌아가거나 DOCX 로 바로 받을 수 있습니다.
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
          return (
            <div
              key={examName}
              className="overflow-hidden rounded-lg border border-slate-200 bg-white"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                <div>
                  <div className="text-sm font-bold text-slate-800">{examName}</div>
                  <div className="text-[11px] text-slate-500">
                    {groupRows.length}건 · 성공 {okCount} / 검수 {reviewedCount}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Link
                    href={cropHref}
                    className="rounded border border-emerald-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-50"
                  >
                    ✂ 크롭에서 이어서
                  </Link>
                  <button
                    onClick={() => downloadGroupDocx(examName, groupRows)}
                    disabled={busyDocxId === `group:${examName}`}
                    className="rounded border border-indigo-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
                  >
                    {busyDocxId === `group:${examName}` ? "묶는 중…" : "📄 묶음 DOCX"}
                  </button>
                </div>
              </div>
              <table className="w-full text-xs">
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
                      return (
                        <tr key={r.id} className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2 font-bold text-slate-800">
                            {r.question_no ?? "-"}
                          </td>
                          <td className="px-3 py-2 text-slate-500">{fmtTime(r.created_at)}</td>
                          <td className="px-3 py-2 text-slate-700">{r.model}</td>
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
                          <td className="px-3 py-2 text-slate-700">
                            {r.user_rating ? `★${r.user_rating}` : r.reviewed_at ? "검수됨" : "—"}
                          </td>
                          <td className="px-3 py-2 text-slate-600">
                            {questionPreview(r.question_text)}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap justify-end gap-1">
                              <Link
                                href={`/auto?restoreRun=${encodeURIComponent(r.id)}`}
                                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                                title="자동 해설 페이지에서 이 결과를 복원"
                              >
                                자동에서 열기
                              </Link>
                              <button
                                onClick={() => downloadSingleDocx(r)}
                                disabled={docxBtnDisabled}
                                className="rounded border border-indigo-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                                title={r.parsed ? "이 풀이로 단건 DOCX 다운로드" : "parsed 결과가 없어 DOCX 생성 불가"}
                              >
                                {busyDocxId === r.id ? "다운로드 중…" : "DOCX 단건"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}
