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

/**
 * GET — 설정 상태 + 처리 가능한 unpaired record 수.
 * UI 패널이 「AI 페어 정제」 섹션을 보여주기 전에 호출해 활성화 가능 여부 판단.
 */
export async function GET() {
  const enabled = isAssistedPairingEnabled();
  const killSwitch = /^(1|true|yes|on)$/i.test(process.env.GEMINI_OCR_DISABLED || "");
  const hasGeminiKey = !!(process.env.GEMINI_API_KEY?.trim());

  let unpairedCount = 0;
  let withProblemNoCount = 0;
  let totalRecords = 0;
  try {
    const all = await fetchAllRecords();
    totalRecords = all.length;
    withProblemNoCount = all.filter((r) => typeof r.problem_no === "number").length;
    unpairedCount = all.filter((r) => {
      if (typeof r.problem_no !== "number") return false;
      const hasSolution = !!(r.solution_text && r.solution_text.trim());
      const hasProblem = !!(r.content && r.content.trim());
      return (!hasSolution && hasProblem) || (hasSolution && !hasProblem);
    }).length;
  } catch {
    // best-effort
  }

  // 「unpaired 0건」 메시지의 두 가지 케이스 구분 — 사용자 혼란 방지
  let zeroReason = "";
  if (unpairedCount === 0) {
    if (withProblemNoCount === 0) {
      zeroReason =
        `problem_no 가진 record 자체가 0건 (전체 ${totalRecords} 건). ` +
        `시중교재가 아직 학습 안 됐거나, OCR 결과에서 문항 번호 인식 실패. ` +
        `먼저 「분석자료 새로 학습」 + analysisTextNormalizer 패턴 보강 필요.`;
    } else {
      zeroReason = `problem_no 가진 record ${withProblemNoCount} 건이 모두 페어 완성 — 정제 불필요 (정상).`;
    }
  }

  return NextResponse.json({
    ok: true,
    enabled,
    killSwitch,
    hasGeminiKey,
    unpairedCount,
    withProblemNoCount,
    totalRecords,
    zeroReason,
    model: process.env.ASSISTED_PAIRING_MODEL || "gemini-2.0-flash",
    canRun: enabled && !killSwitch && hasGeminiKey && unpairedCount > 0,
    blockers: [
      ...(enabled ? [] : ["ASSISTED_PAIRING_ENABLED=true 환경변수 필요"]),
      ...(killSwitch ? ["GEMINI_OCR_DISABLED 킬스위치 활성"] : []),
      ...(hasGeminiKey ? [] : ["GEMINI_API_KEY 미설정"]),
      ...(unpairedCount === 0 ? [zeroReason] : []),
    ],
  });
}

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
