-- Supabase SQL Editor 에서 한 번 실행
create table if not exists public.explanation_reviews (
  id uuid primary key default gen_random_uuid(),
  exam_name text not null,
  question_no text not null,
  body text not null,
  quick_answer text not null default '-',
  updated_at timestamptz not null default now()
);

create unique index if not exists explanation_reviews_exam_question
  on public.explanation_reviews (exam_name, question_no);

alter table public.explanation_reviews enable row level security;

-- 서버(API route)는 service role 로만 쓰면 RLS 는 우회됩니다.
-- 클라이언트에서 직접 쓰려면 정책을 추가하세요.
