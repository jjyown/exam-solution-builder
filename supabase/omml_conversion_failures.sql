-- OMML 변환 실패 자동 로그 — PR-1 Commit 3 진입 전 필수 (Minor 7+8 보강).
--
-- 본 plan `polymorphic-zooming-badger.md` 의 명시적 정확도 개선 사이클:
--   1) 의뢰인이 'X문제 수식 깨짐' 보고 (UI 검증 버튼 + 빨간 배너)
--   2) 시스템이 자동으로 어떤 LaTeX 토큰이 실패했는지 본 테이블에 쌓아둠
--   3) 주 1회 또는 5건 누적 시 변환기에 해당 토큰 추가 commit
--   4) 재배포 후 같은 패턴 자동 처리
--   5) 매 commit 마다 unit test 추가 → 회귀 방지
--
-- 적용:
--   Supabase 프로젝트 `gsdhwuoyiboyzvtokrao` SQL Editor 에서 한 번 실행.
--   적용 전 `select current_database(), inet_server_addr()` 로 해설제작지 운영 프로젝트
--   연결 확인 (매니저 `jzcrpdeomjmytfekcgqu` 와 분리).
--
-- INSERT 폭주 가드 (Minor 7) — 로거 모듈(`ommlFailureLogger.ts`) 책임:
--   - owner_id 분당 100건 cap (in-memory rate limit)
--   - 일 1000건 초과 시 cost_counter 또는 별도 alert 트리거
--     (PR-A' cost_counter 연동 — Step 5 SQL 적용 후)
--
-- Rollback: `drop table public.omml_conversion_failures;` (데이터 없으므로 안전).

BEGIN;

create table if not exists public.omml_conversion_failures (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  raw_latex text not null,
  error_type text not null,  -- 'unsupported_token' | 'parse_error' | 'tree_invalid'
  exam_paper_id text,
  created_at timestamptz not null default now()
);

create index if not exists omml_fail_owner_idx
  on public.omml_conversion_failures (owner_id, created_at desc);
create index if not exists omml_fail_type_idx
  on public.omml_conversion_failures (error_type, created_at desc);

alter table public.omml_conversion_failures enable row level security;

-- 다층 방어 (default deny + 명시 REVOKE):
revoke all on public.omml_conversion_failures from public;
revoke all on public.omml_conversion_failures from anon;
revoke all on public.omml_conversion_failures from authenticated;

-- service_role 명시 GRANT (Minor 8 보강) — RLS bypass 권한이라 정책 불필요.
grant select, insert on public.omml_conversion_failures to service_role;

comment on table public.omml_conversion_failures is
  'OMML 변환 실패 자동 로그 — service_role only, RLS default deny. fire-and-forget INSERT (owner_id 분당 100건 cap + 일 1000건 cost-monitor alert).';

COMMIT;

-- ─────────────────────────────────────────────────
-- 검증 SELECT (SQL Editor 결과로 확인)
-- ─────────────────────────────────────────────────
select
  (select count(*) from pg_class where relname = 'omml_conversion_failures' and relnamespace = 'public'::regnamespace) as table_count,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname like 'omml_fail_%') as index_count,
  (select relrowsecurity from pg_class where relname = 'omml_conversion_failures' and relnamespace = 'public'::regnamespace) as rls_enabled,
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'omml_conversion_failures') as policy_count,
  (select has_table_privilege('public', 'public.omml_conversion_failures', 'INSERT')) as public_can_insert,
  (select has_table_privilege('anon', 'public.omml_conversion_failures', 'INSERT')) as anon_can_insert,
  (select has_table_privilege('authenticated', 'public.omml_conversion_failures', 'INSERT')) as authenticated_can_insert,
  (select has_table_privilege('service_role', 'public.omml_conversion_failures', 'SELECT')) as service_role_can_select,
  (select has_table_privilege('service_role', 'public.omml_conversion_failures', 'INSERT')) as service_role_can_insert;
-- 기대: table_count=1, index_count=2, rls_enabled=true, policy_count=0,
--        public_can_insert=false, anon_can_insert=false, authenticated_can_insert=false,
--        service_role_can_select=true, service_role_can_insert=true
