-- 외부(과금) API 호출 단건 로그 — 비용 체크 대시보드용.
-- 기존 테이블이 커버 못 하는 「짧고 잦은」 호출(사진편집 박스 감지·시험명 추천,
-- 페어 정제, BBox 폴백 등)을 라우트별로 영속 기록한다.
--
-- 이미 영속화돼 있는 호출은 여기에 또 기록하지 않는다 (이중 계산 방지):
--   - /api/auto-pipeline (메인 풀이): auto_pipeline_runs.*
--   - /api/drive/analysis/sync (학습 OCR): analysis_records.*
--
-- Supabase SQL Editor 에서 한 번 실행. 미적용 시 logApiCall() 은 best-effort 로 조용히 패스.
create table if not exists public.api_call_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- 호출 위치(어디서 호출됐나) — UI에서 그룹 라벨 노출 (예: '/api/photo-edit/detect-box')
  route text not null,
  -- 사람이 읽을 용도 라벨 — 한국어 (예: '사진 편집기 박스 자동감지')
  purpose text not null,
  -- 'gemini' | 'openai' | 'mathpix' | 'other'
  vendor text not null,
  -- 모델 식별자 (없으면 'unknown')
  model text not null default 'unknown',

  -- 호출 단건의 추정 비용(USD). lib 단가 테이블 기반 계산 결과.
  est_cost_usd numeric(10,6) not null default 0,

  -- 1회 호출이 아니라 여러 단위(예: PDF 페이지 N장 OCR)인 경우 보정
  units int not null default 1,

  -- 결과 OK 여부 (false 도 호출 자체는 발생 — 비용은 거의 같음)
  ok boolean not null default true,

  -- 자유 메타 (questionNo, attempts, fileName 등). UI 미표시.
  meta jsonb
);

create index if not exists api_call_logs_created_at
  on public.api_call_logs (created_at desc);

create index if not exists api_call_logs_route_created
  on public.api_call_logs (route, created_at desc);

create index if not exists api_call_logs_vendor_created
  on public.api_call_logs (vendor, created_at desc);

alter table public.api_call_logs enable row level security;
-- 서버(API route)는 service role 로만 INSERT/SELECT. 클라이언트 직접 접근 안 함.
