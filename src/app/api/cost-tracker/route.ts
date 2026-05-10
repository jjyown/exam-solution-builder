/**
 * GET /api/cost-tracker
 * ────────────────────────────────────────────────────────────────────────────
 *  최근 N일간 Gemini/OpenAI API 호출 트래픽과 추정 비용을 한 곳에서 보여준다.
 *
 *  데이터 소스:
 *   1) auto_pipeline_runs.model — 자동 파이프라인 호출 (사용자가 「풀이 생성」)
 *   2) analysis_records.created_at — Drive 분석자료 학습 OCR 호출 (백그라운드)
 *
 *  추정 단가 (USD, 평균값 기반):
 *   gemini-2.5-pro     : input $1.25/MTok + output $10/MTok → 호출당 ~$0.019
 *   gemini-2.5-flash   : input $0.30/MTok + output $2.50/MTok → 호출당 ~$0.005
 *   gemini-2.0-flash   : input $0.10/MTok + output $0.40/MTok → 호출당 ~$0.001
 *   gemini-2.0-flash-lite: ~$0.0005
 *   OpenAI gpt-4o      : ~$0.030
 *   OpenAI gpt-4o-mini : ~$0.001
 *
 *  ⚠️ 정확한 토큰 측정이 아닌 평균 추정. 단순 비례 계산이라 ±50% 오차 가능.
 *  진짜 정확하려면 Google AI Studio billing dashboard 직접 확인 권장.
 *
 *  Query:
 *    ?days=7   — 분석 기간 (기본 7일, 최대 90)
 *
 *  응답:
 *    {
 *      ok, periodDays, since,
 *      autoPipeline: { byModel, totalCalls, estUsd, estKrw },
 *      driveLearning: { byDay, totalRecords, ocrEstUsd, ocrEstKrw },
 *      total: { estUsd, estKrw },
 *      hint: string,
 *      assistedPairingEnabled: boolean,
 *      diagnoses: Array<{level: 'info'|'warn'|'high', message: string}>
 *    }
 *
 *  Supabase 미설정 시 빈 응답 (ok: true, but empty fields).
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import { getSupabaseServiceClient, getAcademySupabaseClient } from "@/lib/supabaseServiceClient";
import { isAssistedPairingEnabled } from "@/lib/pairingAssistedRefiner";

const KRW_PER_USD = 1330;  // 환율 추정 — 진짜 환율은 변동, ±5% 오차

const COST_PER_CALL_USD: Record<string, number> = {
  // 자동 파이프라인 (장문 입력 + 단계별 풀이 출력)
  "gemini-2.5-pro": 0.019,
  "gemini-2.5-flash": 0.005,
  "gemini-2.0-flash": 0.001,
  "gemini-2.0-flash-lite": 0.0005,
  "gpt-4o": 0.030,
  "gpt-4o-mini": 0.001,
};

// Drive 학습 OCR — Gemini Vision 폴백 호출당 평균 (PDF 페이지·이미지 1장 기준)
const VISION_OCR_COST_USD: Record<string, number> = {
  "gemini-2.0-flash": 0.0001,
  "gemini-2.5-flash": 0.0005,
};

function clampInt(v: string | null, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function inferUnitCost(model: string | null): number {
  if (!model) return 0.005;  // 평균
  const m = model.toLowerCase();
  // 정확 일치 우선
  if (COST_PER_CALL_USD[m] !== undefined) return COST_PER_CALL_USD[m];
  // 부분 일치 (gemini-2.5-pro-001 같은 변형)
  for (const [key, val] of Object.entries(COST_PER_CALL_USD)) {
    if (m.includes(key)) return val;
  }
  return 0.005;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = clampInt(url.searchParams.get("days"), 7, 1, 90);
  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();

  const client = getSupabaseServiceClient();
  if (!client) {
    return NextResponse.json({
      ok: true,
      periodDays: days,
      since: sinceIso,
      configured: false,
      autoPipeline: { byModel: {}, totalCalls: 0, estUsd: 0, estKrw: 0 },
      driveLearning: { byDay: {}, totalRecords: 0, ocrEstUsd: 0, ocrEstKrw: 0 },
      total: { estUsd: 0, estKrw: 0 },
      hint: "Supabase 미설정 — 사용량 추적 불가. SUPABASE_SERVICE_ROLE_KEY 설정 필요.",
      assistedPairingEnabled: isAssistedPairingEnabled(),
      diagnoses: [],
    });
  }

  // 1) auto_pipeline_runs — 자동 파이프라인 호출 (사용자 트리거)
  const { data: runs, error: runsErr } = await client
    .from("auto_pipeline_runs")
    .select("model, attempts, created_at, ok")
    .gte("created_at", sinceIso)
    .limit(5000);

  type Bucket = { calls: number; attempts: number; estUsd: number };
  const byModel: Record<string, Bucket> = {};
  let autoTotalCalls = 0;
  let autoTotalAttempts = 0;
  let autoEstUsd = 0;

  if (!runsErr && Array.isArray(runs)) {
    for (const r of runs) {
      const model = (r.model as string | null) || "(unknown)";
      const attempts = Number(r.attempts) || 1;
      // 한 run = 한 사용자 요청, attempts 만큼 모델 호출 (재시도 포함)
      const unit = inferUnitCost(model);
      const cost = unit * attempts;
      byModel[model] ??= { calls: 0, attempts: 0, estUsd: 0 };
      byModel[model].calls += 1;
      byModel[model].attempts += attempts;
      byModel[model].estUsd += cost;
      autoTotalCalls += 1;
      autoTotalAttempts += attempts;
      autoEstUsd += cost;
    }
  }

  // 2) analysis_records — Drive 학습 OCR (백그라운드 자동 동기화)
  //    Mathpix 가 우선이라 Gemini 폴백 비율을 정확히 모름.
  //    보수적으로 모든 record 가 Gemini OCR 한 것으로 가정 — 상한선 추정.
  //    (실제로는 Mathpix 가 처리한 비율만큼 빠짐)
  const { data: arRows, error: arErr } = await client
    .from("analysis_records")
    .select("created_at, source")
    .gte("created_at", sinceIso)
    .limit(20000);

  const byDay: Record<string, number> = {};
  let drvTotalRecords = 0;
  if (!arErr && Array.isArray(arRows)) {
    for (const row of arRows) {
      const day = (row.created_at as string)?.slice(0, 10);
      if (!day) continue;
      byDay[day] = (byDay[day] ?? 0) + 1;
      drvTotalRecords += 1;
    }
  }
  // 학습 호출 비용 — gemini-2.0-flash 기준 (Mathpix 폴백 가정), record 1개 ≈ 0.5 vision call (chunk 단위)
  const drvVisionCalls = Math.ceil(drvTotalRecords * 0.5);
  const drvOcrEstUsd = drvVisionCalls * (VISION_OCR_COST_USD["gemini-2.0-flash"] ?? 0.0001);

  // ── 학원 관리 (academy_manager) ─────────────────────────────────────────
  // 별도 Supabase 프로젝트. ACADEMY_SUPABASE_URL/KEY env 있을 때만 조회.
  // 호출 로그 테이블이 따로 없어 결과 테이블의 row 수로 추정:
  //   - student_evaluations  : 종합평가 1건 ≈ 입시지식 검색 1회 + 본문 생성 1회 = 2회 호출
  //                            gemini-2.5-flash 기준 호출당 ~$0.005 → 1건당 $0.010
  //   - admissions_knowledge : 입시 지식 수집 1건 ≈ 1회 호출 → $0.005
  //   - grading_results      : AI 채점 1건 ≈ 평균 20문항 × (OCR 2회 + 채점 1회) = 60회 → $0.30
  //                            (Gemini Flash 가성비 기준, 정확도 보수적으로 잡음)
  //
  // env 미설정 또는 조회 실패 시 academyConfigured: false 로 표시.
  const academyClient = getAcademySupabaseClient();
  let academyConfigured = false;
  let academyError: string | null = null;
  let academyEstUsd = 0;
  const academyByCategory: Record<string, { rows: number; estUsd: number; model: string; perRowUsd: number }> = {};
  if (academyClient) {
    academyConfigured = true;
    try {
      const [evalRes, kbRes, gradingRes] = await Promise.all([
        academyClient.from("student_evaluations").select("id", { count: "exact", head: true }).gte("created_at", sinceIso),
        academyClient.from("admissions_knowledge").select("id", { count: "exact", head: true }).gte("created_at", sinceIso),
        academyClient.from("grading_results").select("id", { count: "exact", head: true }).gte("created_at", sinceIso),
      ]);
      const ev = evalRes.count ?? 0;
      const kb = kbRes.count ?? 0;
      const gr = gradingRes.count ?? 0;
      academyByCategory["종합평가 생성"] = {
        rows: ev,
        estUsd: ev * 0.010,
        model: "gemini-2.5-flash",
        perRowUsd: 0.010,
      };
      academyByCategory["입시지식 수집"] = {
        rows: kb,
        estUsd: kb * 0.005,
        model: "gemini-2.5-flash",
        perRowUsd: 0.005,
      };
      academyByCategory["AI 채점"] = {
        rows: gr,
        estUsd: gr * 0.30,
        model: "gemini-2.5-flash + OCR",
        perRowUsd: 0.30,
      };
      academyEstUsd = Object.values(academyByCategory).reduce((s, c) => s + c.estUsd, 0);
    } catch (e) {
      academyError = (e as Error).message;
    }
  }

  const total = autoEstUsd + drvOcrEstUsd + academyEstUsd;
  const totalKrw = total * KRW_PER_USD;

  // 진단 로직 — 사용량 폭증 원인 자동 식별
  const diagnoses: Array<{ level: "info" | "warn" | "high"; message: string }> = [];

  // a. 자동 파이프라인 호출이 평균보다 많음
  const dailyAvg = autoTotalCalls / days;
  if (dailyAvg > 30) {
    diagnoses.push({
      level: "high",
      message: `자동 파이프라인 일평균 ${dailyAvg.toFixed(1)}회 — 사용자 풀이 생성이 활발. 가장 큰 비용 비중.`,
    });
  }
  // b. 재시도가 많아서 호출 증폭
  if (autoTotalCalls > 0 && autoTotalAttempts / autoTotalCalls > 1.5) {
    diagnoses.push({
      level: "warn",
      message: `평균 ${(autoTotalAttempts / autoTotalCalls).toFixed(2)} 회 재시도 — 검증 실패로 모델을 여러 번 호출 중. 페어매핑 적중률·검증기 오류 점검 권장.`,
    });
  }
  // c. 큰 모델(2.5-pro / gpt-4o) 비중
  const heavyModels = Object.entries(byModel).filter(
    ([m]) => /2\.5-pro|gpt-4o(?!-mini)/i.test(m),
  );
  const heavyCost = heavyModels.reduce((s, [, b]) => s + b.estUsd, 0);
  if (heavyCost > total * 0.5 && heavyCost > 0.5) {
    diagnoses.push({
      level: "warn",
      message: `킬러급 모델(${heavyModels.map(([m]) => m).join(", ")}) 가 비용의 ${((heavyCost / total) * 100).toFixed(0)}% 차지. 「balanced」 프로파일 비중 늘리거나 inferDifficulty 임계 조정 검토.`,
    });
  }
  // d. Drive 학습이 갑자기 많음
  const drvAvg = drvTotalRecords / days;
  if (drvAvg > 100) {
    diagnoses.push({
      level: "warn",
      message: `Drive 학습 record 일평균 ${drvAvg.toFixed(0)}건 — 큰 시중교재 PDF 가 처음 학습되거나 modifiedTime 이 바뀐 PDF 다수 재OCR 가능성.`,
    });
  }
  // e. AI 페어 정제 켜진 상태 — 주의 환기
  if (isAssistedPairingEnabled()) {
    diagnoses.push({
      level: "info",
      message: "AI 페어 정제(ASSISTED_PAIRING_ENABLED=true) 활성. 패널의 미리보기·적용 클릭마다 추가 호출 발생.",
    });
  }
  // f. 호출 0건이면 측정 불가 안내
  if (autoTotalCalls === 0 && drvTotalRecords === 0) {
    diagnoses.push({
      level: "info",
      message: "최근 호출 기록 없음 — Supabase 영속화가 막혔거나 진짜로 호출이 0건. auto_pipeline_runs 테이블 확인.",
    });
  }

  return NextResponse.json({
    ok: true,
    periodDays: days,
    since: sinceIso,
    configured: true,
    autoPipeline: {
      byModel,
      totalCalls: autoTotalCalls,
      totalAttempts: autoTotalAttempts,
      estUsd: Number(autoEstUsd.toFixed(4)),
      estKrw: Math.round(autoEstUsd * KRW_PER_USD),
    },
    driveLearning: {
      byDay,
      totalRecords: drvTotalRecords,
      visionCallsEst: drvVisionCalls,
      ocrEstUsd: Number(drvOcrEstUsd.toFixed(4)),
      ocrEstKrw: Math.round(drvOcrEstUsd * KRW_PER_USD),
    },
    academy: {
      configured: academyConfigured,
      error: academyError,
      byCategory: academyByCategory,
      estUsd: Number(academyEstUsd.toFixed(4)),
      estKrw: Math.round(academyEstUsd * KRW_PER_USD),
    },
    total: {
      estUsd: Number(total.toFixed(4)),
      estKrw: Math.round(totalKrw),
      // 합산 분배
      breakdown: {
        해설제작_자동파이프라인: Number(autoEstUsd.toFixed(4)),
        해설제작_Drive학습: Number(drvOcrEstUsd.toFixed(4)),
        학원관리: Number(academyEstUsd.toFixed(4)),
      },
    },
    assistedPairingEnabled: isAssistedPairingEnabled(),
    diagnoses,
    hint:
      "추정 비용은 모델별 평균 단가 기준 ±50% 오차. 정확한 청구액은 Google AI Studio billing 확인.",
  });
}
