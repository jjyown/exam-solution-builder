"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { MethodBlocksMarkdown } from "@/components/ExplanationMarkdownMath";

type Item = {
  id: string;
  exam_name: string;
  question_no: string;
  body: string;
  source_filename: string | null;
  updated_at: string;
  status: string;
};

function labelForQuestion(row: Pick<Item, "question_no">) {
  return row.question_no === "합본" ? "합본" : `${row.question_no}번`;
}

/**
 * 크롭 전용 UI 우측: Supabase `exam_solutions` 본문을 Markdown+KaTeX로 미리보기 (md 파일 열람 대체)
 */
export function CropExamSolutionsPreviewPanel({ examName }: { examName: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!examName.trim()) {
      setItems([]);
      setErr(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const q = `?examName=${encodeURIComponent(examName.trim())}&listOnly=0`;
      const res = await fetch(`/api/exam-solutions${q}`);
      const data = (await res.json()) as { items?: Item[]; error?: string; configured?: boolean };
      if (!res.ok) {
        const base = data.error || "목록을 불러오지 못했습니다.";
        if (res.status === 503 && data.configured === false) {
          throw new Error(
            `${base} — 서버에 NEXT_PUBLIC_SUPABASE_URL(또는 SUPABASE_URL)과 SUPABASE_SERVICE_ROLE_KEY가 없습니다.`,
          );
        }
        throw new Error(base);
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
    const label = labelForQuestion(row);
    if (
      !window.confirm(
        `Supabase에서 이 해설 행을 삭제할까요?\n${row.exam_name} · ${label}\n삭제 후 복구할 수 없습니다.`,
      )
    ) {
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

  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((prev) => (prev && items.some((i) => i.id === prev) ? prev : items[0]!.id));
  }, [items]);

  const selected = useMemo(
    () => (selectedId ? items.find((i) => i.id === selectedId) : undefined),
    [items, selectedId],
  );

  return (
    <div className="sticky top-4 flex max-h-[min(92vh,960px)] flex-col gap-3">
      <div>
        <p className="text-sm font-semibold text-slate-900">Supabase · 해설 미리보기</p>
        <p className="mt-1 text-[11px] leading-snug text-slate-600">
          좌측에서 고른 시험지 이름과 DB의 <code className="rounded bg-slate-100 px-0.5">exam_name</code>이 같으면,
          여기서 본문을 수식까지 렌더링해 확인합니다. 완료한 문항은 칩 오른쪽{" "}
          <strong className="font-semibold">삭제</strong>로 Supabase에서 제거해 목록을 정리할 수 있습니다.
        </p>
      </div>

      {!examName.trim() ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          왼쪽에서 시험지를 먼저 선택하면 해당 시험의 Supabase 해설이 아래에 로드됩니다.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-slate-500">
          필터: <span className="font-medium text-slate-800">{examName.trim() || "(전체)"}</span>
          {loading ? <span className="ml-2 text-slate-400">불러오는 중…</span> : null}
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
        <div className="rounded bg-rose-100 px-2 py-2 text-xs text-rose-900">
          <p className="font-medium">{err}</p>
          {err.includes("설정") || err.includes("SERVICE_ROLE") ? (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-snug text-rose-950">
              <li>
                <strong>로컬</strong>: `highroad-math-solution/.env.local`에 두 변수 저장 후{" "}
                <code className="rounded bg-white/80 px-0.5">npm run dev</code> 재시작.
              </li>
              <li>
                <strong>Railway·배포</strong>: Variables에 동일 이름 추가 → <strong>Redeploy</strong>.
              </li>
            </ul>
          ) : null}
        </div>
      ) : null}

      {examName.trim() && !loading && !err && items.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-600">
          이 시험 이름으로 저장된 행이 없습니다. 업로드 스크립트나 3단계 저장으로 먼저 넣어 주세요.
        </p>
      ) : null}

      {items.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {items.map((row) => (
              <div
                key={row.id}
                role="group"
                aria-label={`${labelForQuestion(row)} 미리보기 및 삭제`}
                className={`inline-flex overflow-hidden rounded-md border text-[11px] font-semibold shadow-sm ${
                  row.id === selectedId
                    ? "border-indigo-500 bg-indigo-50 text-indigo-950"
                    : "border-slate-200 bg-white text-slate-800"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  className={`px-2 py-1 hover:opacity-90 ${
                    row.id === selectedId ? "bg-indigo-50" : "bg-white hover:bg-slate-50"
                  }`}
                >
                  {labelForQuestion(row)}
                </button>
                <button
                  type="button"
                  disabled={deletingId !== null}
                  title="Supabase exam_solutions에서 이 행 삭제"
                  onClick={() => void remove(row)}
                  className="border-l border-slate-200/80 bg-white px-1.5 py-1 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {deletingId === row.id ? "…" : "삭제"}
                </button>
              </div>
            ))}
          </div>
          <div className="min-h-[200px] flex-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-3 shadow-sm">
            {selected ? (
              <>
                <p className="mb-2 border-b border-slate-100 pb-2 text-[11px] text-slate-500">
                  {selected.exam_name} · {labelForQuestion(selected)}
                  {selected.status ? ` · ${selected.status}` : ""}
                </p>
                <MethodBlocksMarkdown
                  source={selected.body}
                  className="text-[13px] leading-6 [&_.katex]:text-[0.95em]"
                />
              </>
            ) : (
              <p className="text-xs text-slate-500">문항을 선택하세요.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
