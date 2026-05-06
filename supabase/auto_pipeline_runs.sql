-- 자동 파이프라인 실행 이력 (Cursor 채팅 대체용 영속 로그)
-- Supabase SQL Editor 에서 한 번 실행

create table if not exists public.auto_pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- 입력
  exam_name text,
  question_no text,
  question_text text not null,
  model text not null default 'gemini',
  top_k int not null default 3,
  max_retries int not null default 2,

  -- 결과
  ok boolean not null,
  attempts int not null default 0,
  parsed jsonb,
  trace jsonb,
  errors jsonb,
  manual_review_checklist jsonb,

  -- 사람이 검수 후 남기는 피드백
  user_rating smallint,
  user_feedback text,
  reviewed_at timestamptz,
  final_body text
);

create index if not exists auto_pipeline_runs_created_at
  on public.auto_pipeline_runs (created_at desc);

create index if not exists auto_pipeline_runs_exam_question
  on public.auto_pipeline_runs (exam_name, question_no);

alter table public.auto_pipeline_runs enable row level security;

-- 서버(API route)는 service role 로만 접근. 클라이언트 직접 쓰기는 정책 추가 후 사용.
