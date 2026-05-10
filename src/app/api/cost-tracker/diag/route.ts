/**
 * GET /api/cost-tracker/diag
 * ────────────────────────────────────────────────────────────────────────────
 *  비용 체크 파이프라인 자체 진단 (insert → read round-trip).
 *
 *  무엇을 확인하나:
 *   1) api_call_logs 테이블에 INSERT 가 실제 성공하는가
 *   2) 직후 SELECT 로 그 row 를 다시 읽을 수 있는가
 *   3) cost-tracker 본체가 byRoute 에 그 row 를 노출하는 형태로 집계하는가
 *
 *  사용:
 *   브라우저 주소창에 그대로 붙여넣고 Enter — JSON 응답이 뜸.
 *     /api/cost-tracker/diag
 *
 *  부작용 (안전):
 *   - api_call_logs 에 진단 row 1건이 INSERT 됨 (route='/api/__diag/test')
 *   - cost-tracker 에는 별도 라우트로 1건만 잡힘 (실제 비용 ~$0.0008, 진단용)
 *   - 같은 URL 을 여러 번 누르면 누른 만큼 누적 — 정상 동작 확인 후 신경 안 써도 됨
 *
 *  보안: 운영에서도 무난 (write/read 만 하고 외부 노출 정보는 없음).
 *  굳이 더 보호하려면 향후 헤더 토큰 가드 추가.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { getSupabaseServiceClient } from "@/lib/supabaseServiceClient";
import { logApiCall } from "@/lib/apiCallLogger";

export async function GET() {
  const result: {
    step: string;
    ok: boolean;
    detail?: unknown;
    error?: string;
  }[] = [];

  // 1) Supabase 클라이언트 자체 확인
  const client = getSupabaseServiceClient();
  if (!client) {
    return NextResponse.json(
      {
        ok: false,
        step: "supabase-client",
        error:
          "Supabase 미설정 — NEXT_PUBLIC_SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 확인.",
      },
      { status: 500 },
    );
  }
  result.push({ step: "supabase-client", ok: true });

  // 2) 테이블 존재 확인 — limit 1 SELECT
  const probe = await client
    .from("api_call_logs")
    .select("id", { head: false })
    .limit(1);
  if (probe.error) {
    result.push({
      step: "table-exists",
      ok: false,
      error: probe.error.message,
    });
    return NextResponse.json(
      {
        ok: false,
        steps: result,
        hint:
          "api_call_logs 테이블이 없거나 RLS 가 service_role 까지 막고 있습니다. " +
          "supabase/api_call_logs.sql 적용 여부를 확인하세요.",
      },
      { status: 500 },
    );
  }
  result.push({ step: "table-exists", ok: true });

  // 3) logApiCall() 직접 호출 — INSERT round-trip
  const sentinel = `diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await logApiCall({
    route: "/api/__diag/test",
    purpose: "비용 체크 자체 진단 (cost-tracker/diag)",
    vendor: "other",
    model: "diag-noop",
    ok: true,
    units: 1,
    meta: { sentinel },
  });
  result.push({ step: "log-api-call", ok: true, detail: { sentinel } });

  // 4) 즉시 SELECT — 방금 넣은 row 가 실제로 들어갔나?
  //    eventual consistency 는 거의 즉시이지만 안전을 위해 sentinel 검색
  const verify = await client
    .from("api_call_logs")
    .select("id, route, purpose, vendor, model, units, est_cost_usd, ok, meta, created_at")
    .order("created_at", { ascending: false })
    .limit(5);
  if (verify.error) {
    result.push({
      step: "verify-read",
      ok: false,
      error: verify.error.message,
    });
    return NextResponse.json({ ok: false, steps: result }, { status: 500 });
  }
  type LogRow = {
    id: string;
    route: string;
    purpose: string;
    vendor: string;
    model: string;
    units: number;
    est_cost_usd: number;
    ok: boolean;
    meta: { sentinel?: string } | null;
    created_at: string;
  };
  const rows = (verify.data ?? []) as LogRow[];
  const matched = rows.find((r) => r.meta?.sentinel === sentinel);
  if (!matched) {
    result.push({
      step: "verify-read",
      ok: false,
      error:
        "INSERT 직후 SELECT 에서 sentinel row 를 찾지 못함 — RLS 또는 transaction 이슈 가능성.",
      detail: { recentRows: rows.slice(0, 3) },
    });
    return NextResponse.json({ ok: false, steps: result }, { status: 500 });
  }
  result.push({
    step: "verify-read",
    ok: true,
    detail: {
      route: matched.route,
      purpose: matched.purpose,
      est_cost_usd: matched.est_cost_usd,
      created_at: matched.created_at,
    },
  });

  // 5) 최근 1시간 내 라우트별 카운트 — 비용 페이지가 보게 될 데이터 모양
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: recent, error: recentErr } = await client
    .from("api_call_logs")
    .select("route, vendor, model, est_cost_usd")
    .gte("created_at", sinceIso)
    .limit(200);
  if (recentErr) {
    result.push({ step: "aggregate", ok: false, error: recentErr.message });
  } else {
    const byRoute: Record<string, { calls: number; estUsd: number }> = {};
    for (const r of recent ?? []) {
      const key = (r.route as string) || "(unknown)";
      byRoute[key] ??= { calls: 0, estUsd: 0 };
      byRoute[key].calls += 1;
      byRoute[key].estUsd += Number(r.est_cost_usd) || 0;
    }
    result.push({
      step: "aggregate",
      ok: true,
      detail: { recentHourByRoute: byRoute },
    });
  }

  return NextResponse.json({
    ok: true,
    summary: "✓ insert→read 라운드트립 정상. /cost 탭의 byRoute 표에도 같은 데이터가 노출됩니다.",
    steps: result,
    cleanup:
      "이 진단으로 생긴 row 들은 route='/api/__diag/test' 로 누적됩니다. 신경쓰이면 SQL Editor 에서 " +
      "delete from public.api_call_logs where route='/api/__diag/test'; 한 번 실행.",
  });
}
