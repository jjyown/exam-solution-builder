"use client";

import { useCallback, useEffect, useState } from "react";

type Item = {
  id: string;
  exam_name: string;
  question_no: string;
  source_filename: string | null;
  updated_at: string;
  status: string;
};

/**
 * 1·2단계(크롭) 우측: Supabase exam_solutions 목록 · 삭제만 (미리보기 없음)
 */
export function ExamSolutionsSupabaseQuickPanel({ examName }: { examName: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const q = examName.trim()
        ? `?examName=${encodeURIComponent(examName.trim())}`
        : "";
      const res = await fetch(`/api/exam-solutions${q}`);
      const data = (await res.json()) as { items?: Item[]; error?: string };
      if (!res.ok) {
        throw new Error(data.error || "목록을 불러오지 못했습니다.");
      }
      setItems(data.items ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [examName]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (row: Item) => {
    const label =
      row.question_no === "합본" ? "합본" : `${row.question_no}번`;
    if (!window.confirm(`Supabase에서 삭제할까요?\n${row.exam_name} · ${label}`)) {
      return;
    }
    setDeletingId(row.id);
    setErr(null);
    try {
      const res = await fetch(`/api/exam-solutions?id=${encodeURIComponent(row.id)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(data.error || "삭제에 실패했습니다.");
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="sticky top-4 space-y-3">
      <div>
        <p className="text-sm font-semibold text-slate-900">Supabase · 업로드된 문항</p>
        <p className="mt-1 text-[11px] leading-snug text-slate-600">
          좌측에서 선택한 시험지 이름(<code className="rounded bg-slate-100 px-0.5">exam_name</code>)과
          일치하는 행만 표시합니다. 삭제 시 DB에서 바로 제거됩니다.
        </p>
      </div>
      {!examName.trim() ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          시험지를 왼쪽에서 먼저 선택하면 해당 시험의 문항 목록이 여기에 나타납니다.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-slate-500">
          필터: <span className="font-medium text-slate-800">{examName.trim() || "(전체)"}</span>
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-slate-400 bg-white px-2 py-1 text-xs font-semibold text-slate-800 hover:bg-slate-50"
        >
          새로고침
        </button>
      </div>
      {err ? (
        <p className="rounded bg-rose-100 px-2 py-1 text-xs text-rose-800">{err}</p>
      ) : null}
      <div className="max-h-[min(70vh,560px)] overflow-y-auto rounded-md border border-slate-200 bg-white">
        {loading ? (
          <p className="p-4 text-xs text-slate-500">불러오는 중…</p>
        ) : items.length === 0 ? (
          <p className="p-4 text-xs text-slate-600">
            {examName.trim()
              ? "이 시험명으로 저장된 행이 없습니다. `npm run db-push` 로 올렸는지 확인하세요."
              : "시험지를 선택하거나 새로고침 하세요."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((row) => {
              const label =
                row.question_no === "합본" ? "합본" : `${row.question_no}번`;
              return (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-slate-50"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold text-slate-900">{label}</span>
                    {row.source_filename ? (
                      <span className="ml-1 text-slate-600">· {row.source_filename}</span>
                    ) : null}
                    <span
                      className={`ml-2 inline-block rounded px-1.5 py-0.5 text-[10px] ${
                        row.status === "verified"
                          ? "bg-emerald-100 text-emerald-900"
                          : "bg-slate-200 text-slate-700"
                      }`}
                    >
                      {row.status === "verified" ? "검증됨" : "초안"}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={deletingId === row.id}
                    onClick={() => void remove(row)}
                    className="shrink-0 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-900 hover:bg-rose-100 disabled:opacity-50"
                  >
                    {deletingId === row.id ? "삭제 중…" : "삭제"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
