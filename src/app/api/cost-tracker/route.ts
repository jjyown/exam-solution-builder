/**
 * GET /api/cost-tracker
 * ────────────────────────────────────────────────────────────────────────────
 *  최근 N일간 Gemini/OpenAI/Mathpix API 호출 트래픽과 추정 비용을 한 곳에서 보여준다.
 *
 *  데이터 소스 (3종):
 *   1) auto_pipeline_runs       — /api/auto-pipeline 메인 풀이 (LLM)
 *   2) analysis_records         — /api/drive/analysis/sync 학습 OCR (Gemini)
 *   3) api_call_logs            — 그 외 모든 라우트(사진편집·추출·페어정제·BBox 폴백 등)
 *
 *  추정 단가 (USD, 평균값 기반):
 *   gemini-2.5-pro       : 호출당 ~$0.019
 *   gemini-2.5-flash     : ~$0.005
 *   gemini-2.5-flash-lite: ~$0.0008
 *   gemini-2.0-flash     : ~$0.001
 *   gemini-2.0-flash-lite: ~$0.0005
 *   gpt-4o               : ~$0.030
 *   gpt-4o-mini          : ~$0.001
 *   mathpix-v3-text      : 페이지/이미지당 ~$0.004
 *   mathpix-v3-pdf       : 페이지당 ~$0.005
 *
 *  ⚠️ 정확한 토큰 측정이 아닌 평균 추정. ±50% 오차 가능.
 *  실제 청구액은 Google AI Studio / OpenAI / Mathpix billing dashboard 확인.
 *
 *  Query:
 *    ?days=7   — 분석 기간 (기본 7일, 최대 90)
 *
 *  응답:
 *    {
 *      ok, periodDays, since,
 *      autoPipeline: { byModel, totalCalls, estUsd, estKrw },
 *      driveLearning: { byDay, totalRecords, ocrEstUsd, ocrEstKrw },
 *      byRoute: Array<{
 *        route, purpose, vendor, models, calls, units, estUsd, estKrw,
 *        avgPerCallUsd, source: 'auto_pipeline_runs'|'analysis_records'|'api_call_logs'
 *      }>,
 *      total: { estUsd, estKrw, breakdown },
 *      hint: string,
 *      diagnoses: Array<{level, message}>
 *    }
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
  "gemini-2.5-flash-lite": 0.0008,
  "gemini-2.0-flash": 0.001,
  "gemini-2.0-flash-lite": 0.0005,
  "gpt-4o": 0.030,
  "gpt-4o-mini": 0.001,
  "gpt-4.1": 0.020,
  "gpt-4.1-mini": 0.002,
  // Mathpix — 페이지/이미지당
  "mathpix-v3-text": 0.004,
  "mathpix-v3-pdf": 0.005,
};

// Drive 학습 OCR — Gemini Vision 폴백 호출당 평균 (PDF 페이지·이미지 1장 기준)
const VISION_OCR_COST_USD: Record<string, number> = {
  "gemini-2.0-flash": 0.0001,
  "gemini-2.5-flash": 0.0005,
};

// 라우트 라벨 — UI 에서 「작업 이름」으로 표시. 미등록 라우트는 라우트 경로 그대로.
const ROUTE_LABELS: Record<string, { purpose: string; trigger: string }> = {
  "/api/auto-pipeline": {
    purpose: "해설 자동 제작 — 풀이 생성 (LLM)",
    trigger: "/auto · /crop UI 「풀이 생성」 버튼",
  },
  "/api/auto-pipeline:ocr": {
    purpose: "해설 자동 제작 — 업로드 파일 OCR (사전단계)",
    trigger: "/auto 업로드 + 「풀이 생성」 흐름",
  },
  "/api/auto-pipeline/vision": {
    purpose: "크롭 비전 직접 풀이 — Gemini Vision (OCR 단계 생략)",
    trigger: "/crop UI 「비전 모드」 토글 ON + 「이 크롭 풀이」",
  },
  "/api/auto-pipeline/extract": {
    purpose: "해설 자동 제작 — 문항 미리보기 OCR",
    trigger: "/auto 파일 업로드 직후 (인식된 문항 표시)",
  },
  "/api/drive/analysis/sync": {
    purpose: "분석자료 — Drive 「분석용 자료」 학습 OCR",
    trigger: "백그라운드 자동 동기화 + 수동 「새로 학습」",
  },
  "/api/drive/analysis/refine-pairing": {
    purpose: "분석자료 — AI 페어 정제 (unpaired 분류)",
    trigger: "AI 페어 정제 패널 (ASSISTED_PAIRING_ENABLED=true 필요)",
  },
  "/api/drive/analysis/bbox-fallback": {
    purpose: "분석자료 — BBox 기반 PDF 재처리 (페어링률 보강)",
    trigger: "BBox 패널 (BBOX_FALLBACK_ENABLED=true 필요) + 자동 트리거",
  },
  "/api/photo-edit/detect-box": {
    purpose: "사진 편집기 — 문제 박스 자동감지",
    trigger: "사진 편집기 「박스 자동감지」 버튼",
  },
  "/api/photo-edit/mimic-box": {
    purpose: "사진 편집기 — 박스 다른 페이지로 복제",
    trigger: "사진 편집기 「박스 복제」 버튼",
  },
  "/api/photo-edit/suggest-name": {
    purpose: "사진 편집기 — 시험지명 자동 추천",
    trigger: "사진 편집기 「시험지명 추천」 버튼",
  },
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
  try {
    return await handleCostTracker(req);
  } catch (e) {
    // 어떤 단계에서든 throw 가 발생하면 JSON 500 으로 본문에 메시지를 담아 반환.
    // (빈 본문 500 → 클라이언트가 「Unexpected end of JSON input」 으로 보임)
    const err = e as Error;
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "cost-tracker internal error",
        stack: process.env.NODE_ENV !== "production" ? err?.stack : undefined,
      },
      { status: 500 },
    );
  }
}

async function handleCostTracker(req: Request) {
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
      byRoute: [],
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

  // ── 3) api_call_logs — 그 외 모든 라우트(짧고 잦은 호출) ─────────────────
  // 사진편집(detect/mimic/suggest), 추출 미리보기, 페어 정제, BBox 폴백, 자동파이프라인 OCR
  // 등은 이 테이블에 단건 기록됨.
  type RouteAggRow = {
    route: string;
    purpose: string;
    trigger: string;
    vendor: string;
    models: string[];
    calls: number;
    units: number;
    estUsd: number;
    avgPerCallUsd: number;
    source: "auto_pipeline_runs" | "analysis_records" | "api_call_logs";
  };
  const byRoute: RouteAggRow[] = [];

  // (a) auto_pipeline_runs → /api/auto-pipeline
  if (autoTotalCalls > 0) {
    const vendors = new Set<string>();
    const models = new Set<string>();
    for (const m of Object.keys(byModel)) {
      models.add(m);
      vendors.add(/^gpt|openai/i.test(m) ? "openai" : "gemini");
    }
    byRoute.push({
      route: "/api/auto-pipeline",
      purpose: ROUTE_LABELS["/api/auto-pipeline"].purpose,
      trigger: ROUTE_LABELS["/api/auto-pipeline"].trigger,
      vendor: Array.from(vendors).sort().join("+") || "gemini",
      models: Array.from(models).sort(),
      calls: autoTotalCalls,
      units: autoTotalAttempts,
      estUsd: Number(autoEstUsd.toFixed(4)),
      avgPerCallUsd: autoTotalCalls > 0 ? Number((autoEstUsd / autoTotalCalls).toFixed(4)) : 0,
      source: "auto_pipeline_runs",
    });
  }

  // (b) analysis_records → /api/drive/analysis/sync
  if (drvTotalRecords > 0) {
    byRoute.push({
      route: "/api/drive/analysis/sync",
      purpose: ROUTE_LABELS["/api/drive/analysis/sync"].purpose,
      trigger: ROUTE_LABELS["/api/drive/analysis/sync"].trigger,
      vendor: "gemini+mathpix",
      models: ["gemini-2.0-flash", "mathpix-v3-pdf"],
      calls: drvVisionCalls,
      units: drvTotalRecords,
      estUsd: Number(drvOcrEstUsd.toFixed(4)),
      avgPerCallUsd: drvVisionCalls > 0 ? Number((drvOcrEstUsd / drvVisionCalls).toFixed(4)) : 0,
      source: "analysis_records",
    });
  }

  // (c) api_call_logs → 라우트별 GROUP BY
  let apiLogTotalUsd = 0;
  let apiLogTotalCalls = 0;
  let apiLogConfigured = true;
  let apiLogError: string | null = null;
  try {
    const { data: logRows, error: logErr } = await client
      .from("api_call_logs")
      .select("route, purpose, vendor, model, units, est_cost_usd, ok")
      .gte("created_at", sinceIso)
      .limit(20000);
    if (logErr) {
      // 테이블 미적용 시: code === '42P01' (undefined_table). UI 에는 안내만.
      apiLogConfigured = false;
      apiLogError = logErr.message;
    } else if (Array.isArray(logRows)) {
      type Bucket2 = {
        purpose: string;
        vendor: Set<string>;
        models: Set<string>;
        calls: number;
        units: number;
        estUsd: number;
      };
      const buckets: Record<string, Bucket2> = {};
      for (const r of logRows) {
        const route = (r.route as string) || "(unknown)";
        const b =
          buckets[route] ??
          (buckets[route] = {
            purpose: (r.purpose as string) || ROUTE_LABELS[route]?.purpose || route,
            vendor: new Set<string>(),
            models: new Set<string>(),
            calls: 0,
            units: 0,
            estUsd: 0,
          });
        if (r.vendor) b.vendor.add(r.vendor as string);
        if (r.model) b.models.add(r.model as string);
        b.calls += 1;
        b.units += Number(r.units) || 1;
        b.estUsd += Number(r.est_cost_usd) || 0;
      }
      for (const [route, b] of Object.entries(buckets)) {
        byRoute.push({
          route,
          purpose: b.purpose,
          trigger: ROUTE_LABELS[route]?.trigger || "—",
          vendor: Array.from(b.vendor).sort().join("+") || "unknown",
          models: Array.from(b.models).sort(),
          calls: b.calls,
          units: b.units,
          estUsd: Number(b.estUsd.toFixed(4)),
          avgPerCallUsd: b.calls > 0 ? Number((b.estUsd / b.calls).toFixed(4)) : 0,
          source: "api_call_logs",
        });
        apiLogTotalUsd += b.estUsd;
        apiLogTotalCalls += b.calls;
      }
    }
  } catch (e) {
    apiLogConfigured = false;
    apiLogError = (e as Error).message;
  }

  // 비싼 라우트가 위로 오게 정렬
  byRoute.sort((a, b) => b.estUsd - a.estUsd);

  // ── 4) byRouteModel — (라우트 × 모델) 교차 세부 ───────────────────────────
  // "어디서 어떤 모델로 얼마"를 한 줄씩 보여주기 위한 더 fine-grained 집계.
  // 같은 데이터를 다른 차원으로 자르는 view 라 byRoute 와 totalUsd 가 일치.
  type RouteModelRow = {
    route: string;
    purpose: string;
    model: string;
    vendor: string;
    calls: number;
    units: number;
    estUsd: number;
    avgPerCallUsd: number;
    source: "auto_pipeline_runs" | "analysis_records" | "api_call_logs";
  };
  const byRouteModel: RouteModelRow[] = [];

  // (a) auto_pipeline_runs — model 별로 row 생성, 모두 /api/auto-pipeline 라우트
  for (const [model, b] of Object.entries(byModel)) {
    const vendor = /^gpt|openai/i.test(model) ? "openai" : "gemini";
    byRouteModel.push({
      route: "/api/auto-pipeline",
      purpose: ROUTE_LABELS["/api/auto-pipeline"].purpose,
      model,
      vendor,
      calls: b.calls,
      units: b.attempts,
      estUsd: Number(b.estUsd.toFixed(4)),
      avgPerCallUsd: b.calls > 0 ? Number((b.estUsd / b.calls).toFixed(4)) : 0,
      source: "auto_pipeline_runs",
    });
  }

  // (b) analysis_records — model 정보가 row 에 없으므로 평균 단가 가정 1줄로 표현.
  //    실제로는 mathpix 폴백 비율 모름 → gemini-2.0-flash 단일 추정.
  if (drvTotalRecords > 0) {
    byRouteModel.push({
      route: "/api/drive/analysis/sync",
      purpose: ROUTE_LABELS["/api/drive/analysis/sync"].purpose,
      model: "gemini-2.0-flash (추정)",
      vendor: "gemini",
      calls: drvVisionCalls,
      units: drvTotalRecords,
      estUsd: Number(drvOcrEstUsd.toFixed(4)),
      avgPerCallUsd: drvVisionCalls > 0 ? Number((drvOcrEstUsd / drvVisionCalls).toFixed(4)) : 0,
      source: "analysis_records",
    });
  }

  // (c) api_call_logs — (route, model) 튜플별 GROUP BY 다시 한 번
  if (apiLogConfigured) {
    try {
      const { data: rmRows, error: rmErr } = await client
        .from("api_call_logs")
        .select("route, purpose, vendor, model, est_cost_usd, units")
        .gte("created_at", sinceIso)
        .limit(20000);
      if (!rmErr && Array.isArray(rmRows)) {
        type Key = string; // `${route}::${model}`
        const m: Record<
          Key,
          { route: string; purpose: string; model: string; vendor: string; calls: number; units: number; estUsd: number }
        > = {};
        for (const r of rmRows) {
          const route = (r.route as string) || "(unknown)";
          const model = (r.model as string) || "unknown";
          const key = `${route}::${model}`;
          const purpose =
            (r.purpose as string) || ROUTE_LABELS[route]?.purpose || route;
          m[key] ??= {
            route,
            purpose,
            model,
            vendor: (r.vendor as string) || "other",
            calls: 0,
            units: 0,
            estUsd: 0,
          };
          m[key].calls += 1;
          m[key].units += Number(r.units) || 1;
          m[key].estUsd += Number(r.est_cost_usd) || 0;
        }
        for (const v of Object.values(m)) {
          byRouteModel.push({
            route: v.route,
            purpose: v.purpose,
            model: v.model,
            vendor: v.vendor,
            calls: v.calls,
            units: v.units,
            estUsd: Number(v.estUsd.toFixed(4)),
            avgPerCallUsd: v.calls > 0 ? Number((v.estUsd / v.calls).toFixed(4)) : 0,
            source: "api_call_logs",
          });
        }
      }
    } catch {
      /* swallow — 이미 byRoute 단계에서 동일 케이스 처리됨 */
    }
  }

  // 비싼 행이 위로 — 사용자가 「줄일 첫 후보」를 즉시 보게.
  byRouteModel.sort((a, b) => b.estUsd - a.estUsd);

  const total = autoEstUsd + drvOcrEstUsd + apiLogTotalUsd + academyEstUsd;
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
  if (autoTotalCalls === 0 && drvTotalRecords === 0 && apiLogTotalCalls === 0) {
    diagnoses.push({
      level: "info",
      message: "최근 호출 기록 없음 — Supabase 영속화가 막혔거나 진짜로 호출이 0건. auto_pipeline_runs / api_call_logs 테이블 확인.",
    });
  }
  // g. api_call_logs 미적용 안내 — 사진편집·페어정제 등이 비용에 안 잡힘
  if (!apiLogConfigured) {
    diagnoses.push({
      level: "info",
      message:
        "api_call_logs 테이블 미적용 — 사진편집·AI 페어정제·BBox 폴백 등 짧은 호출이 비용 통계에 안 잡힙니다. " +
        "supabase/api_call_logs.sql 을 한 번 실행해 주세요." +
        (apiLogError ? ` (${apiLogError.slice(0, 80)})` : ""),
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
    apiCallLogs: {
      configured: apiLogConfigured,
      error: apiLogError,
      totalCalls: apiLogTotalCalls,
      estUsd: Number(apiLogTotalUsd.toFixed(4)),
      estKrw: Math.round(apiLogTotalUsd * KRW_PER_USD),
    },
    byRoute: byRoute.map((r) => ({
      ...r,
      estKrw: Math.round(r.estUsd * KRW_PER_USD),
    })),
    byRouteModel: byRouteModel.map((r) => ({
      ...r,
      estKrw: Math.round(r.estUsd * KRW_PER_USD),
    })),
    total: {
      estUsd: Number(total.toFixed(4)),
      estKrw: Math.round(totalKrw),
      // 합산 분배
      breakdown: {
        해설제작_자동파이프라인: Number(autoEstUsd.toFixed(4)),
        해설제작_Drive학습: Number(drvOcrEstUsd.toFixed(4)),
        해설제작_그외라우트: Number(apiLogTotalUsd.toFixed(4)),
        학원관리: Number(academyEstUsd.toFixed(4)),
      },
    },
    assistedPairingEnabled: isAssistedPairingEnabled(),
    diagnoses,
    hint:
      "추정 비용은 모델별 평균 단가 기준 ±50% 오차. 정확한 청구액은 Google AI Studio / OpenAI / Mathpix billing 확인.",
  });
}
