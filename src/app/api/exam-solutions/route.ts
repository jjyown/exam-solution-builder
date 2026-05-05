import { NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabaseServiceClient";
import { sortExamSolutionItemsByQuestionNo } from "@/lib/sortExamSolutions";

export const runtime = "nodejs";

type Row = {
  id: string;
  exam_name: string;
  question_no: string;
  body: string;
  source_filename: string | null;
  updated_at: string;
  status: string;
};

type ListRow = Omit<Row, "body">;

function normalizeExamNameForMatch(name: string): string {
  return name
    .trim()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[\[\]\(\){}]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * GET ?examName=...  → 목록(본문 제외 가능)
 * GET ?id=<uuid>     → 단건 전체
 */
export async function GET(request: Request) {
  const supabase = getSupabaseServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase 서버 설정이 없습니다.", configured: false },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  const examName = (
    url.searchParams.get("examName") ||
    url.searchParams.get("testName") ||
    ""
  ).trim();
  const listOnly = url.searchParams.get("listOnly") !== "0";

  if (id) {
    const { data, error } = await supabase.from("exam_solutions").select("*").eq("id", id).maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ item: data as Row });
  }

  let q = supabase.from("exam_solutions").select("*");
  if (examName) q = q.eq("exam_name", examName);
  q = q.order("exam_name").order("question_no");

  const { data, error } = await q;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  let raw = (data ?? []) as Record<string, unknown>[];
  // 좌측 시험명에 괄호 표기/확장자(pdf) 차이가 있어도 같은 시험으로 보이게 폴백 매칭
  if (examName && raw.length === 0) {
    const { data: allData, error: allError } = await supabase
      .from("exam_solutions")
      .select("*")
      .order("exam_name")
      .order("question_no");
    if (allError) {
      return NextResponse.json({ error: allError.message }, { status: 500 });
    }
    const target = normalizeExamNameForMatch(examName);
    raw = ((allData ?? []) as Record<string, unknown>[]).filter(
      (r) => normalizeExamNameForMatch(String(r.exam_name ?? "")) === target,
    );
  }

  const items: Row[] | ListRow[] = listOnly
    ? sortExamSolutionItemsByQuestionNo(
        raw.map((r) => ({
          id: String(r.id),
          exam_name: String(r.exam_name),
          question_no: String(r.question_no),
          source_filename: (r.source_filename as string | null) ?? null,
          updated_at: String(r.updated_at),
          status: typeof r.status === "string" ? r.status : "draft",
        })),
      )
    : sortExamSolutionItemsByQuestionNo(
        raw.map((r) => ({
          id: String(r.id),
          exam_name: String(r.exam_name),
          question_no: String(r.question_no),
          body: String(r.body ?? ""),
          source_filename: (r.source_filename as string | null) ?? null,
          updated_at: String(r.updated_at),
          status: typeof r.status === "string" ? r.status : "draft",
        })),
      );
  return NextResponse.json({ items });
}

/**
 * PATCH JSON: { id, body?, status? } — id 필수
 */
export async function PATCH(request: Request) {
  const supabase = getSupabaseServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase 서버 설정이 없습니다.", configured: false },
      { status: 503 },
    );
  }

  let json: { id?: string; body?: string; status?: string };
  try {
    json = (await request.json()) as typeof json;
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 });
  }

  const id = (json.id ?? "").trim();
  if (!id) {
    return NextResponse.json({ error: "id 가 필요합니다." }, { status: 400 });
  }

  const patch: Record<string, string> = { updated_at: new Date().toISOString() };
  if (typeof json.body === "string") {
    patch.body = json.body;
  }
  if (typeof json.status === "string") {
    const s = json.status.trim();
    if (s !== "draft" && s !== "verified") {
      return NextResponse.json({ error: "status 는 draft 또는 verified 만 허용됩니다." }, { status: 400 });
    }
    patch.status = s;
  }

  if (Object.keys(patch).length <= 1) {
    return NextResponse.json({ error: "body 또는 status 중 하나 이상 필요합니다." }, { status: 400 });
  }

  const { data, error } = await supabase.from("exam_solutions").update(patch).eq("id", id).select("*").maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, item: data as Row });
}

/**
 * DELETE ?id=<uuid>          — 해당 행 1건 삭제
 * DELETE ?examName=<string>  — 해당 시험명의 행 전체 삭제(합본 포함)
 */
export async function DELETE(request: Request) {
  const supabase = getSupabaseServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase 서버 설정이 없습니다.", configured: false },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  const examName = (
    url.searchParams.get("examName") ||
    url.searchParams.get("testName") ||
    ""
  ).trim();

  if (!id && !examName) {
    return NextResponse.json({ error: "id 또는 examName 쿼리가 필요합니다." }, { status: 400 });
  }

  if (examName) {
    const { data, error } = await supabase
      .from("exam_solutions")
      .delete()
      .eq("exam_name", examName)
      .select("id");
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const deletedCount = Array.isArray(data) ? data.length : 0;
    return NextResponse.json({ ok: true, deletedCount, examName });
  }

  const { data, error } = await supabase.from("exam_solutions").delete().eq("id", id).select("id").maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, deleted: id });
}
