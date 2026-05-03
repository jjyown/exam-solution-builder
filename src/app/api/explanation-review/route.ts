import { NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabaseServiceClient";

export const runtime = "nodejs";

type Body = {
  examName?: string;
  questionNo?: string;
  explanationBody?: string;
  quickAnswer?: string;
};

/**
 * 검수 완료 해설을 Supabase에 저장한다.
 * 테이블: explanation_reviews (아래 SQL 참고)
 */
export async function POST(request: Request) {
  let json: Body;
  try {
    json = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다." }, { status: 400 });
  }

  const examName = (json.examName ?? "").trim() || "미지정";
  const questionNo = (json.questionNo ?? "").trim();
  const body = (json.explanationBody ?? "").trim();
  const quickAnswer = (json.quickAnswer ?? "").trim() || "-";

  if (!questionNo) {
    return NextResponse.json({ error: "questionNo 가 필요합니다." }, { status: 400 });
  }
  if (!body) {
    return NextResponse.json({ error: "explanationBody 가 비었습니다." }, { status: 400 });
  }

  const supabase = getSupabaseServiceClient();
  if (!supabase) {
    return NextResponse.json(
      {
        error:
          "Supabase 환경변수가 설정되지 않았습니다. 프로젝트 루트 `.env.local` 에 NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 를 넣고 개발 서버를 재시작하세요.",
        configured: false,
      },
      { status: 503 },
    );
  }

  const row = {
    exam_name: examName,
    question_no: questionNo,
    body,
    quick_answer: quickAnswer,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("explanation_reviews").upsert(row, {
    onConflict: "exam_name,question_no",
  });

  if (error) {
    return NextResponse.json(
      {
        error: error.message,
        hint:
          "테이블·unique 인덱스가 없을 수 있습니다. 프로젝트 루트 supabase/explanation_reviews.sql 을 Supabase SQL 에서 실행하세요.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, examName, questionNo });
}
