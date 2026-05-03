"use client";

import { useCallback, useState } from "react";
import { ExplanationMarkdownMath } from "@/components/ExplanationMarkdownMath";
import { useExamSolutionReview } from "./ExamSolutionReviewContext";

/** 좌측: DB 문항 목록 (3단계 검토 전용) */
export function ExamSolutionReviewListBlock() {
  const {
    active,
    examNameFilter,
    setExamNameFilter,
    items,
    loadingList,
    listError,
    reloadList,
    selected,
    selectById,
  } = useExamSolutionReview();

  if (!active) return null;

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-indigo-950">Supabase · exam_solutions</p>
          <p className="mt-0.5 text-[11px] text-indigo-900">
            시험명은 DB의 `exam_name`(보통 `해설 작업중` 하위 폴더명)과 같아야 합니다. `npm run db-push` 로
            올린 뒤, `.env.local` 을 수정했으면 `next dev` 를 한 번 재시작하세요.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reloadList()}
          className="shrink-0 rounded border border-indigo-400 bg-white px-2 py-1 text-xs font-semibold text-indigo-900 hover:bg-indigo-100"
        >
          새로고침
        </button>
      </div>
      <label className="mt-2 block text-[11px] font-semibold text-indigo-900">
        시험명 필터
        <input
          value={examNameFilter}
          onChange={(e) => setExamNameFilter(e.target.value)}
          placeholder="예: [TEST] TEST1.pdf"
          className="mt-1 w-full rounded border border-indigo-300 bg-white px-2 py-1.5 text-sm"
        />
      </label>
      {listError && (
        <p className="mt-2 rounded bg-rose-100 px-2 py-1 text-xs text-rose-800">{listError}</p>
      )}
      <div className="mt-2 max-h-64 overflow-y-auto rounded border border-indigo-200 bg-white">
        {loadingList ? (
          <p className="p-3 text-xs text-slate-500">불러오는 중…</p>
        ) : items.length === 0 ? (
          <p className="p-3 text-xs text-slate-600">행이 없습니다. DB 업로드 또는 시험명을 확인하세요.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((row) => {
              const on = selected?.id === row.id;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => void selectById(row.id)}
                    className={`w-full px-3 py-2 text-left text-xs ${
                      on ? "bg-indigo-100 font-semibold text-indigo-950" : "hover:bg-slate-50"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span>
                        {row.question_no === "합본" ? "합본" : `${row.question_no}번`}{" "}
                        <span className="font-normal text-slate-600">
                          {row.source_filename ? `· ${row.source_filename}` : ""}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                          row.status === "verified"
                            ? "bg-emerald-200 text-emerald-900"
                            : "bg-slate-200 text-slate-700"
                        }`}
                      >
                        {row.status === "verified" ? "검증됨" : "초안"}
                      </span>
                    </span>
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

/** 우측: 이미지 + 미리보기 + 편집/저장/검증 */
export function ExamSolutionReviewDetailBlock() {
  const {
    active,
    selected,
    bodyDraft,
    setBodyDraft,
    editOpen,
    setEditOpen,
    saving,
    saveBody,
    markVerified,
    detailError,
    deleteSelectionInEditor,
  } = useExamSolutionReview();
  const [previewActionHint, setPreviewActionHint] = useState<string | null>(null);

  const deletePreviewSelectionFromBody = useCallback(() => {
    setPreviewActionHint(null);
    const sel = typeof window !== "undefined" ? window.getSelection() : null;
    if (!sel || sel.isCollapsed) {
      setPreviewActionHint("미리보기에서 삭제할 텍스트를 드래그로 선택한 뒤 다시 누르세요.");
      return;
    }
    const slice = sel.toString();
    if (!slice) return;
    const idx = bodyDraft.indexOf(slice);
    if (idx < 0) {
      setPreviewActionHint(
        "원문 Markdown과 화면에 보이는 글자가 다를 수 있습니다. 「수정」을 열고 편집기에서 삭제하거나, 편집기에서 같은 문구를 드래그한 뒤 「선택 영역 삭제」를 쓰세요.",
      );
      return;
    }
    setBodyDraft(bodyDraft.slice(0, idx) + bodyDraft.slice(idx + slice.length));
    sel.removeAllRanges();
    setPreviewActionHint("선택한 구간을 본문에서 삭제했습니다. 필요하면 「DB에 저장」을 누르세요.");
  }, [bodyDraft, setBodyDraft]);

  if (!active) return null;

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-[#fdfcf8] p-3">
      {!selected ? (
        <p className="text-sm text-slate-500">왼쪽에서 문항을 선택하면 미리보기가 표시됩니다.</p>
      ) : (
        <>
          <header className="border-b border-slate-200 pb-2">
            <p className="text-sm font-semibold text-slate-900">
              {selected.exam_name} · {selected.question_no === "합본" ? "합본" : `${selected.question_no}번`}
            </p>
            <p className="text-[11px] text-slate-500">
              {selected.status === "verified" ? "상태: 검증 완료" : "상태: 초안(draft)"} · 갱신:{" "}
              {new Date(selected.updated_at).toLocaleString("ko-KR")}
            </p>
          </header>

          <p className="rounded bg-slate-100 px-2 py-1.5 text-[11px] text-slate-700">
            이 단계는 <strong>Supabase에 저장된 해설 본문</strong>만 골라 미리봅니다. 시험지 이미지·크롭은{" "}
            <strong>1·2단계</strong>에서만 다룹니다.
          </p>

          <div>
            <p className="mb-1 text-[11px] font-semibold text-slate-600">
              미리보기 — DB 본문 (Markdown · LaTeX)
            </p>
            <div className="max-h-[min(50vh,480px)] overflow-y-auto rounded border border-slate-200 bg-white p-3">
              <ExplanationMarkdownMath source={bodyDraft} />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setEditOpen(!editOpen)}
              className="rounded-md border border-slate-400 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
            >
              {editOpen ? "미리보기만" : "수정"}
            </button>
            <button
              type="button"
              onClick={deletePreviewSelectionFromBody}
              className="rounded-md border border-amber-600/40 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-100"
            >
              미리보기 선택 삭제
            </button>
            {editOpen && (
              <>
                <button
                  type="button"
                  onClick={deleteSelectionInEditor}
                  className="rounded-md border border-rose-400 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-900 hover:bg-rose-100"
                >
                  편집기 선택 삭제
                </button>
                <span className="self-center text-[10px] text-slate-500">
                  아래 칸에서 텍스트를 드래그한 뒤 누르세요.
                </span>
              </>
            )}
          </div>
          {previewActionHint ? (
            <p className="text-[11px] text-slate-600">{previewActionHint}</p>
          ) : null}

          {editOpen && (
            <textarea
              data-exam-solution-body-editor
              value={bodyDraft}
              onChange={(e) => setBodyDraft(e.target.value)}
              className="min-h-[200px] w-full rounded border border-slate-300 p-2 font-mono text-sm leading-relaxed"
              spellCheck={false}
            />
          )}

          {detailError && (
            <p className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-800">{detailError}</p>
          )}

          <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
            <button
              type="button"
              disabled={saving || !selected}
              onClick={() => void saveBody()}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {saving ? "저장 중…" : "DB에 저장"}
            </button>
            <button
              type="button"
              disabled={saving || !selected}
              onClick={() => void markVerified()}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              검증 완료 (verified)
            </button>
          </div>
        </>
      )}
    </div>
  );
}
