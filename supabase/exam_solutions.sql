-- 웹앱(Railway)·로컬 db-push 공용: 검수 완료 .md 동기화
-- Supabase SQL Editor 에서 한 번 실행

create table if not exists public.exam_solutions (
  id uuid primary key default gen_random_uuid(),
  exam_name text not null,
  question_no text not null,
  body text not null,
  source_filename text,
  updated_at timestamptz not null default now()
);

create unique index if not exists exam_solutions_exam_question
  on public.exam_solutions (exam_name, question_no);

alter table public.exam_solutions enable row level security;

-- 서버·스크립트는 service role 로 접근. 클라이언트 직접 조회 시 정책 추가.
