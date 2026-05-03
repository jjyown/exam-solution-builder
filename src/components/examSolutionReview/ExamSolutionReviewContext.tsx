"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ExamSolutionListItem = {
  id: string;
  exam_name: string;
  question_no: string;
  source_filename: string | null;
  updated_at: string;
  status: string;
};

export type ExamSolutionDetail = ExamSolutionListItem & { body: string };

type Ctx = {
  active: boolean;
  examNameFilter: string;
  setExamNameFilter: (v: string) => void;
  items: ExamSolutionListItem[];
  loadingList: boolean;
  listError: string | null;
  reloadList: () => Promise<void>;
  selected: ExamSolutionDetail | null;
  selectById: (id: string | null) => Promise<void>;
  bodyDraft: string;
  setBodyDraft: (v: string) => void;
  editOpen: boolean;
  setEditOpen: (v: boolean) => void;
  saving: boolean;
  saveBody: () => Promise<void>;
  markVerified: () => Promise<void>;
  cropImageSrc: string | null;
  detailError: string | null;
  deleteSelectionInEditor: () => void;
};

const ExamSolutionReviewContext = createContext<Ctx | null>(null);

export function useExamSolutionReview() {
  const c = useContext(ExamSolutionReviewContext);
  if (!c) throw new Error("ExamSolutionReviewProvider 가 필요합니다.");
  return c;
}

export function ExamSolutionReviewProvider({
  children,
  active,
  defaultExamName,
}: {
  children: ReactNode;
  active: boolean;
  defaultExamName: string;
}) {
  const [examNameFilter, setExamNameFilter] = useState(defaultExamName);
  const [items, setItems] = useState<ExamSolutionListItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ExamSolutionDetail | null>(null);
  const [bodyDraft, setBodyDraft] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (active && defaultExamName && examNameFilter !== defaultExamName) {
      setExamNameFilter(defaultExamName);
    }
  }, [active, defaultExamName, examNameFilter]);

  const reloadList = useCallback(async () => {
    if (!active) return;
    setLoadingList(true);
    setListError(null);
    try {
      const q = examNameFilter.trim()
        ? `?examName=${encodeURIComponent(examNameFilter.trim())}`
        : "";
      const res = await fetch(`/api/exam-solutions${q}`);
      const data = (await res.json()) as { items?: ExamSolutionListItem[]; error?: string };
      if (!res.ok) {
        throw new Error(data.error || "목록을 불러오지 못했습니다.");
      }
      setItems(data.items ?? []);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoadingList(false);
    }
  }, [active, examNameFilter]);

  useEffect(() => {
    if (!active) {
      setItems([]);
      setSelected(null);
      setBodyDraft("");
      setListError(null);
      return;
    }
    void reloadList();
  }, [active, reloadList]);

  const selectById = useCallback(
    async (id: string | null) => {
      if (!active || !id) {
        setSelected(null);
        setBodyDraft("");
        return;
      }
      setDetailError(null);
      try {
        const res = await fetch(`/api/exam-solutions?id=${encodeURIComponent(id)}`);
        const data = (await res.json()) as { item?: ExamSolutionDetail; error?: string };
        if (!res.ok) {
          throw new Error(data.error || "문항을 불러오지 못했습니다.");
        }
        if (!data.item) throw new Error("데이터 없음");
        setSelected(data.item);
        setBodyDraft(data.item.body ?? "");
        setEditOpen(false);
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : String(e));
        setSelected(null);
        setBodyDraft("");
      }
    },
    [active],
  );

  const cropImageSrc = useMemo(() => {
    if (!active || !selected) return null;
    if (selected.question_no === "합본") return null;
    const en = encodeURIComponent(selected.exam_name);
    const qn = encodeURIComponent(selected.question_no);
    return `/api/exam-solutions/crop-image?examName=${en}&questionNo=${qn}`;
  }, [active, selected]);

  const saveBody = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setDetailError(null);
    try {
      const res = await fetch("/api/exam-solutions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, body: bodyDraft }),
      });
      const data = (await res.json()) as { ok?: boolean; item?: ExamSolutionDetail; error?: string };
      if (!res.ok) {
        throw new Error(data.error || "저장 실패");
      }
      if (data.item) {
        setSelected(data.item);
        setBodyDraft(data.item.body);
      }
      await reloadList();
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, bodyDraft, reloadList]);

  const markVerified = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setDetailError(null);
    try {
      const res = await fetch("/api/exam-solutions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, status: "verified", body: bodyDraft }),
      });
      const data = (await res.json()) as { ok?: boolean; item?: ExamSolutionDetail; error?: string };
      if (!res.ok) {
        throw new Error(data.error || "검증 반영 실패");
      }
      if (data.item) {
        setSelected(data.item);
        setBodyDraft(data.item.body);
      }
      await reloadList();
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, bodyDraft, reloadList]);

  const deleteSelectionInEditor = useCallback(() => {
    const ta = document.querySelector<HTMLTextAreaElement>("[data-exam-solution-body-editor]");
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start === end) return;
    const next = bodyDraft.slice(0, start) + bodyDraft.slice(end);
    setBodyDraft(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start, start);
    });
  }, [bodyDraft]);

  const value = useMemo<Ctx>(
    () => ({
      active,
      examNameFilter,
      setExamNameFilter,
      items,
      loadingList,
      listError,
      reloadList,
      selected,
      selectById,
      bodyDraft,
      setBodyDraft,
      editOpen,
      setEditOpen,
      saving,
      saveBody,
      markVerified,
      cropImageSrc,
      detailError,
      deleteSelectionInEditor,
    }),
    [
      active,
      examNameFilter,
      items,
      loadingList,
      listError,
      reloadList,
      selected,
      selectById,
      bodyDraft,
      editOpen,
      saving,
      saveBody,
      markVerified,
      cropImageSrc,
      detailError,
      deleteSelectionInEditor,
    ],
  );

  return (
    <ExamSolutionReviewContext.Provider value={value}>{children}</ExamSolutionReviewContext.Provider>
  );
}
