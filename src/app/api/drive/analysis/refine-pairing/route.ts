/**
 * src/app/api/drive/analysis/refine-pairing/route.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  POST  → Supabase 의 unpaired record 를 골라 gemini-2.0-flash 로 분류·페어링
 *
 *  Body (JSON, 옵션):
 *    { apply: true }   적용까지 (기본 false = dry-run, 모델 호출만)
 *    { batchSize: 30 } 한 호출에 묶을 record 수
 *    { model: "gemini-2.0-flash" }  사용 모델
 *    { maxRecords: 100 } 한 번 트리거에서 처리할 최대 unpaired record 수
 *
 *  응답:
 *    { ok, dryRun, plan: { classifications, stats }, applied?: { updated, skipped, failures } }
 *
 *  보호:
 *    - ASSISTED_PAIRING_ENABLED=true 환경변수 없으면 거부
 *    - GEMINI_OCR_DISABLED=true 도 차단 (비용 보호 킬스위치 공유)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { fetchAllRecords, applyAssistedPairing } from "@/lib/analysisRecordsStore";
import {
  buildAssistedPairingPlan,
  isAssistedPairingEnabled,
} from "@/lib/pairingAssistedRefiner";

export async function POST(req: Request) {
  if (!isAssistedPairingEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "ASSISTED_PAIRING_ENABLED=true 환경변수가 설정되지 않았습니다. " +
          "비용 보호를 위해 명시적으로 켜야 합니다.",
      },
      { status: 403 },
    );
  }
  if (/^(1|true|yes|on)$/i.test(process.env.GEMINI_OCR_DISABLED || "")) {
    return NextResponse.json(
      { ok: false, error: "GEMINI_OCR_DISABLED 킬스위치 활성. 해제 후 재시도." },
      { status: 403 },
    );
  }

  let body: { apply?: boolean; batchSize?: number; model?: string; maxRecords?: number } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const apply = !!body.apply;
  const maxRecords = Math.max(1, Math.min(500, Number(body.maxRecords) || 100));

  // unpaired record 만 추림 — problem_no 있고 solution_text 비었거나, 반대
  const all = await fetchAllRecords();
  const unpaired = all.filter((r) => {
    if (typeof r.problem_no !== "number") return false;
    const hasSolution = !!(r.solution_text && r.solution_text.trim());
    const hasProblem = !!(r.content && r.content.trim());
    return (!hasSolution && hasProblem) || (hasSolution && !hasProblem);
  }).slice(0, maxRecords);

  if (unpaired.length === 0) {
    return NextResponse.json({
      ok: true,
      dryRun: !apply,
      plan: { classifications: [], stats: { callsMade: 0, recordsProcessed: 0, estimatedCostUsd: 0, model: "skipped" } },
      message: "unpaired record 없음 — 페어 매핑이 이미 양호합니다.",
    });
  }

  let plan;
  try {
    plan = await buildAssistedPairingPlan(unpaired, {
      batchSize: body.batchSize,
      model: body.model,
      dryRun: !apply,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }

  if (!apply) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      unpairedCount: unpaired.length,
      plan,
      hint: '실제 적용하려면 body 에 { "apply": true } 를 넣어 다시 POST.',
    });
  }

  const applied = await applyAssistedPairing(plan);
  return NextResponse.json({
    ok: true,
    dryRun: false,
    unpairedCount: unpaired.length,
    plan,
    applied,
  });
}
