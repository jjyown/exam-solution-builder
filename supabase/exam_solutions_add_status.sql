-- 기존 exam_solutions 테이블에 검수 상태 추가 (Supabase SQL Editor 에서 한 번 실행)
alter table public.exam_solutions
  add column if not exists status text not null default 'draft';

comment on column public.exam_solutions.status is 'draft | verified';

-- 기존 행은 draft 유지. verified 는 웹 검수 확정 시 설정.
