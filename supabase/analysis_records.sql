-- 분석용 자료 (시중교재/개인자료) Gemini OCR 결과 영구 저장
-- Supabase SQL Editor 에서 한 번 실행.
-- 같은 Drive 파일이라도 modifiedTime 이 바뀌면 재 OCR 후 새 row 들로 교체.

create table if not exists public.analysis_records (
  -- "drive:<fileId>#<chunkIdx>" 형식. 같은 파일이 수정되면 modifiedTime 바뀌므로
  -- 기존 row 들을 한 번 지우고 새 chunk 들을 다시 넣는 방식.
  id text primary key,

  -- Drive 파일 식별
  drive_file_id text not null,
  drive_modified_time timestamptz,
  source text not null,                 -- 예: drive/분석용자료/시중교재/EBS_2024.pdf

  -- chunk 본문
  problem_hint text,                    -- 짧은 머리말 (검색 결과 미리보기용)
  content text not null,                -- Gemini 가 추출한 마크다운형 텍스트
  equations text[] default '{}'::text[],
  answer text default '',

  -- 메타
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 캐시 적중 (drive_file_id + modifiedTime) 매번 조회되므로 인덱스 필수
create index if not exists idx_analysis_records_file_mtime
  on public.analysis_records (drive_file_id, drive_modified_time);

-- 사용자 검색 (한국어/영문 부분 일치) 용 trigram 인덱스
-- pg_trgm 은 Supabase 에 기본 설치되어 있음
create extension if not exists pg_trgm;
create index if not exists idx_analysis_records_content_trgm
  on public.analysis_records using gin (content gin_trgm_ops);
create index if not exists idx_analysis_records_hint_trgm
  on public.analysis_records using gin (problem_hint gin_trgm_ops);

comment on table public.analysis_records is
  '분석용 자료 폴더의 PDF/이미지를 Gemini OCR 한 chunk 단위 텍스트. RAG 검색 인덱스 + 사용자 검색에 사용.';
