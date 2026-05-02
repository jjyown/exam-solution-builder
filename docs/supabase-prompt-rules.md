# Supabase Prompt Rules

앱에서 제한 규칙을 동적으로 반영하려면 Supabase `prompt_rules` 테이블을 사용합니다.

## 1) 테이블 생성 SQL

```sql
create table if not exists public.prompt_rules (
  id bigserial primary key,
  is_active boolean not null default true,
  extra_constraints text,
  examples_easy text,
  examples_balanced text,
  examples_killer text,
  updated_at timestamptz not null default now()
);

create index if not exists idx_prompt_rules_active_updated
  on public.prompt_rules (is_active, updated_at desc);
```

## 2) 초기 데이터 예시

앱 코드(`prompts.ts`)에 **`FIXED_RUNTIME_SYMBOL_CONSTRAINT`** 가 있어, Supabase를 쓰지 않아도 해설에 수학 기호·`$...$` 사용이 시스템 프롬프트에 항상 붙습니다. DB의 `extra_constraints`에는 **학원별 추가 금지/톤**만 넣어도 됩니다. 아래는 DB에도 동일 정책을 남기고 싶을 때 복붙하는 예시입니다.

```sql
insert into public.prompt_rules (
  is_active,
  extra_constraints,
  examples_balanced
) values (
  true,
  E'- 근사/추정/어림/약/≈ 표현을 절대 사용하지 마.\n- [정답], [해설] 형식을 유지해.\n- [해설]은 한글 장문만으로 끝내지 말고, 조건·전개·결론을 $...$ 안의 수학 기호·등식으로 써.',
  E'[예시]\n[정답] 2\n[해설]\n$(x-1)(x-3)=0$이므로 $x=1$ 또는 $x=3$. 조건상 $x=3$만 성립 → 보기 ②.'
);
```

## 3) 환경변수

아래 환경변수가 설정되면 `generate-explanation` API가 활성 규칙 1건을 읽어 시스템 프롬프트에 주입합니다.

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `PROMPT_RULES_ADMIN_TOKEN` (선택: 규칙 자동 업데이트 API 보호용)
- `PROMPT_RULES_RUNTIME_ENABLED` (선택: `false`면 Supabase 런타임 규칙 주입 비활성화)
- `PROMPT_RULES_MAX_CONSTRAINT_CHARS` (선택: 생성 시 `extraConstraints` 주입 길이 상한, 기본 1200)
- `PROMPT_RULES_MAX_EXAMPLES_CHARS` (선택: 생성 시 난이도별 examples 주입 길이 상한, 기본 900)
- `PROMPT_RULES_ANALYZE_INCLUDE_EXAMPLES` (선택: 기본값 미설정=`false` 동작 — `/api/prompt-rules/analyze-and-apply` 적용 시 **`examples_*` 컬럼은 병합하지 않고** 기존 값 유지. 대량 파일 분석 결과가 스타일 예시로 들어가 출력이 섞이는 것을 방지. `true`로 두면 분석 결과의 예시도 기존처럼 병합)

값이 없거나 조회 실패하면 기존 내장 프롬프트로 자동 폴백합니다.

## 4) 반영 방식

- `buildSystemInstruction`은 **내장 `SYSTEM_PROMPT_BASE` → `FIXED_RUNTIME_SYMBOL_CONSTRAINT`(항상) →** (선택) `[운영자 추가 제한 규칙]`(`extra_constraints`) → `[스타일 기준 예시]` 순으로 이어 붙입니다.
- 요청 시마다 `prompt_rules`에서 `is_active = true`인 최신 1건 조회
- `extra_constraints`는 `[운영자 추가 제한 규칙]` 섹션으로 주입
- 난이도별 예시(`examples_easy/balanced/killer`)는 해당 프로필 예시를 덮어씀

## 5) 자동 규칙 업데이트 API

- 엔드포인트: `POST /api/prompt-rules/analyze-and-apply`
- 입력 상한:
  - `weakExplanation`: 최대 4000자
  - `targetStyleHint`: 최대 1000자
- 내부 저장 상한(코드 가드):
  - `extraConstraints`: 최대 1200자 / 최대 40줄
  - `examples_easy|balanced|killer`: 각각 최대 900자 / 최대 40줄
- 보안:
  - `PROMPT_RULES_ADMIN_TOKEN`이 설정된 경우 요청 헤더 `x-admin-token`이 필요합니다.

## 5-1) 과누적 방지/안전장치

- Supabase에 규칙을 적용할 때 기존 active 규칙과 병합되며, 라인 단위 중복 제거를 수행합니다.
- 병합 결과는 길이/줄 수 하드캡을 적용해 과도 누적을 제한합니다.
- 생성 시점에도 프롬프트 예산 가드를 적용해, 런타임 예시가 길면 내장 예시로 자동 폴백합니다.
- 운영 중 품질 이상 시 `PROMPT_RULES_RUNTIME_ENABLED=false`로 즉시 런타임 규칙 주입을 끌 수 있습니다.

## 6) 규칙 이력/롤백 API

- 이력 조회: `GET /api/prompt-rules/history?limit=10`
- 롤백: `POST /api/prompt-rules/rollback` (body: `{ "ruleId": number }`)
- 롤백도 운영자 토큰(`x-admin-token`) 검증을 동일하게 사용합니다.

## 7) 이벤트 로그 테이블(선택)

아래 테이블을 만들면 규칙 적용/롤백 이력이 저장됩니다.

```sql
create table if not exists public.prompt_rule_events (
  id bigserial primary key,
  event_type text not null,
  rule_id bigint,
  actor text,
  reason text,
  weak_explanation_hash text,
  model text,
  failure_details text,
  created_at timestamptz not null default now()
);

create index if not exists idx_prompt_rule_events_created_at
  on public.prompt_rule_events (created_at desc);
```

## 8) 원자적 적용 RPC(권장)

아래 함수를 만들면 `analyze-and-apply`가 우선 RPC를 사용해 원자적으로 규칙을 교체합니다.
(함수가 없으면 코드가 자동으로 일반 insert/update 방식으로 폴백합니다.)

```sql
create or replace function public.apply_prompt_rules(
  p_extra_constraints text,
  p_examples_easy text,
  p_examples_balanced text,
  p_examples_killer text
)
returns table (id bigint, updated_at timestamptz)
language plpgsql
as $$
declare
  v_id bigint;
  v_updated timestamptz := now();
begin
  insert into public.prompt_rules (
    is_active,
    extra_constraints,
    examples_easy,
    examples_balanced,
    examples_killer,
    updated_at
  ) values (
    true,
    p_extra_constraints,
    p_examples_easy,
    p_examples_balanced,
    p_examples_killer,
    v_updated
  ) returning prompt_rules.id into v_id;

  update public.prompt_rules
  set is_active = false
  where is_active = true and prompt_rules.id <> v_id;

  return query select v_id, v_updated;
end;
$$;
```
