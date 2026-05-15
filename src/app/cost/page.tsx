"use client";

/**
 * src/app/cost/page.tsx
 * ────────────────────────────────────────────────────────────────────────────
 *  비용 체크 탭 — 「어느 작업에서 API 를 얼마나 호출했고 비용이 얼마나 나왔나」
 *
 *  데이터 소스 (모두 /api/cost-tracker 가 합산해 반환):
 *   1) auto_pipeline_runs  → /api/auto-pipeline (메인 풀이 LLM)
 *   2) analysis_records    → /api/drive/analysis/sync (학습 OCR)
 *   3) api_call_logs       → 그 외 모든 라우트 (사진편집·페어정제·BBox·OCR 미리보기 등)
 *
 *  핵심 UI:
 *   - 기간 선택 (1d / 7d / 30d / 90d)
 *   - 총 비용 (USD/KRW)
 *   - 라우트별 표 (호출 수·평균 단가·총 비용·트리거 위치)
 *   - 비용 분포 차트 (상위 3개)
 *   - 진단 메시지 (호출 폭증·대형 모델 비중·재시도 과다 등)
 *   - 정적 단가 카드 (모든 라우트 단가 — 데이터 없어도 노출)
 *
 *  ⚠️ 추정 비용은 모델별 평균 단가 기반 ±50% 오차.
 *      실제 청구액은 Google AI Studio / OpenAI / Mathpix billing 에서 확인.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useState } from "react";
import { AnalysisStatusPanel } from "@/components/AnalysisStatusPanel";

type ByRouteRow = {
  route: string;
  purpose: string;
  trigger: string;
  vendor: string;
  models: string[];
  calls: number;
  units: number;
  estUsd: number;
  estKrw: number;
  avgPerCallUsd: number;
  source: "auto_pipeline_runs" | "analysis_records" | "api_call_logs";
};

type ByRouteModelRow = {
  route: string;
  purpose: string;
  model: string;
  vendor: string;
  calls: number;
  units: number;
  estUsd: number;
  estKrw: number;
  avgPerCallUsd: number;
  source: "auto_pipeline_runs" | "analysis_records" | "api_call_logs";
};

type CostResponse = {
  ok: boolean;
  configured?: boolean;
  periodDays: number;
  since: string;
  hint?: string;
  autoPipeline: {
    byModel: Record<string, { calls: number; attempts: number; estUsd: number }>;
    totalCalls: number;
    totalAttempts?: number;
    estUsd: number;
    estKrw: number;
  };
  driveLearning: {
    byDay: Record<string, number>;
    totalRecords: number;
    visionCallsEst?: number;
    ocrEstUsd: number;
    ocrEstKrw: number;
  };
  apiCallLogs?: {
    configured: boolean;
    error: string | null;
    totalCalls: number;
    estUsd: number;
    estKrw: number;
  };
  byRoute: ByRouteRow[];
  byRouteModel?: ByRouteModelRow[];
  total: {
    estUsd: number;
    estKrw: number;
    breakdown: Record<string, number>;
  };
  academy?: {
    configured: boolean;
    error: string | null;
    byCategory: Record<string, { rows: number; estUsd: number; model: string; perRowUsd: number }>;
    estUsd: number;
    estKrw: number;
  };
  assistedPairingEnabled?: boolean;
  last24h?: { runs: number; failed: number; failureRate: number; retryShare: number };
  textbookBuild?: {
    intervalHours: number;
    lastRunAt: number | null;
    lastOk: boolean;
    totalRuns: number;
    processedBooks: number;
    skippedBooks: number;
    byFolder: Array<{ label: string; found: number; processedBooks: number; skippedBooks: number }>;
    errors: string[];
  } | null;
  diagnoses: Array<{ level: "info" | "warn" | "high"; message: string }>;
};

/** 정적 라우트 카탈로그 — 호출 데이터 없어도 「어디서 무슨 용도, 단가 얼마」 항상 노출. */
const ROUTE_CATALOG: Array<{
  route: string;
  purpose: string;
  trigger: string;
  vendor: string;
  perCallUsd: string;
  trackedBy: string;
  notes?: string;
}> = [
  {
    route: "/api/auto-pipeline",
    purpose: "해설 자동 제작 — 풀이 생성 (LLM)",
    trigger: "/auto · /crop UI 「풀이 생성」 버튼",
    vendor: "Gemini → OpenAI 폴백",
    perCallUsd: "$0.001 ~ $0.030",
    trackedBy: "auto_pipeline_runs",
    notes: "profile=easy/balanced/killer 에 따라 모델 자동 선택. 재시도 시 attempts 만큼 누적.",
  },
  {
    route: "/api/auto-pipeline:ocr",
    purpose: "해설 자동 제작 — 업로드 파일 OCR",
    trigger: "/auto 업로드 + 「풀이 생성」 흐름",
    vendor: "Gemini Vision / Mathpix",
    perCallUsd: "$0.0001 ~ $0.005 (page)",
    trackedBy: "api_call_logs",
    notes: "PDF 페이지 수만큼 units 보정. pdfjs 텍스트만 쓰면 무료(로깅 안 됨).",
  },
  {
    route: "/api/auto-pipeline/extract",
    purpose: "해설 자동 제작 — 인식된 문항 미리보기 OCR",
    trigger: "/auto 파일 업로드 직후",
    vendor: "Gemini Vision / Mathpix",
    perCallUsd: "$0.0001 ~ $0.005 (page)",
    trackedBy: "api_call_logs",
  },
  {
    route: "/api/drive/analysis/sync",
    purpose: "분석자료 — Drive 「분석용 자료」 학습 OCR",
    trigger: "백그라운드 자동 동기화 + 「새로 학습」",
    vendor: "Gemini Vision (+ Mathpix 폴백)",
    perCallUsd: "~$0.0001 (page)",
    trackedBy: "analysis_records",
    notes: "DRIVE_ANALYSIS_AUTO_SYNC_MS=0 으로 자동 비활성 가능.",
  },
  {
    route: "/api/drive/analysis/refine-pairing",
    purpose: "분석자료 — AI 페어 정제 (unpaired 분류)",
    trigger: "AI 페어 정제 패널 (ASSISTED_PAIRING_ENABLED=true 필요)",
    vendor: "Gemini",
    perCallUsd: "~$0.001 (batch 30 records)",
    trackedBy: "api_call_logs",
    notes: "기본 비활성. 명시적으로 켜야 호출됨.",
  },
  {
    route: "/api/photo-edit/detect-box",
    purpose: "사진 편집기 — 문제 박스 자동감지",
    trigger: "사진 편집기 「박스 자동감지」",
    vendor: "Gemini Vision",
    perCallUsd: "~$0.0008",
    trackedBy: "api_call_logs",
  },
  {
    route: "/api/photo-edit/mimic-box",
    purpose: "사진 편집기 — 박스 다른 페이지로 복제",
    trigger: "사진 편집기 「박스 복제」",
    vendor: "Gemini Vision",
    perCallUsd: "~$0.0008",
    trackedBy: "api_call_logs",
  },
  {
    route: "/api/photo-edit/suggest-name",
    purpose: "사진 편집기 — 시험지명 자동 추천",
    trigger: "사진 편집기 「시험지명 추천」",
    vendor: "Gemini Vision",
    perCallUsd: "~$0.0008 ~ $0.0016",
    trackedBy: "api_call_logs",
    notes: "focusImage 동시 전송 시 입력 토큰 ≈ 2배.",
  },
];

const PERIOD_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 1, label: "1일" },
  { days: 7, label: "7일" },
  { days: 30, label: "30일" },
  { days: 90, label: "90일" },
];

function fmtUsd(v: number): string {
  if (v >= 10) return `$${v.toFixed(2)}`;
  if (v >= 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(4)}`;
}

function fmtKrw(v: number): string {
  return `₩${v.toLocaleString("ko-KR")}`;
}

function badgeColor(level: "info" | "warn" | "high"): string {
  if (level === "high") return "border-rose-300 bg-rose-50 text-rose-900";
  if (level === "warn") return "border-amber-300 bg-amber-50 text-amber-900";
  return "border-sky-300 bg-sky-50 text-sky-900";
}

function sourceLabel(s: ByRouteRow["source"]): string {
  if (s === "auto_pipeline_runs") return "auto_pipeline_runs";
  if (s === "analysis_records") return "analysis_records";
  return "api_call_logs";
}

export default function CostPage() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<CostResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cost-tracker?days=${d}`);
      // 본문이 비어있는 500(=Unexpected end of JSON input)도 잡기 위해 text 먼저 읽음
      const raw = await res.text();
      // 어떤 모양으로 오든 정적 검사 우회 — 실제 모양은 런타임에 검사.
      let j: Record<string, unknown> | null = null;
      try {
        j = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        // JSON 파싱 실패 — 빈 본문 또는 비-JSON 응답
      }
      if (!res.ok || !j || j.ok !== true) {
        const errMsg =
          (j && typeof j.error === "string" && j.error) ||
          `HTTP ${res.status}${raw ? ` — ${raw.slice(0, 300)}` : ""}`;
        const stack = j && typeof j.stack === "string" ? j.stack : null;
        throw new Error(stack ? `${errMsg}\n\n${stack}` : errMsg);
      }
      setData(j as unknown as CostResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const total = data?.total;
  const totalEstUsd = total?.estUsd ?? 0;
  const byRoute = data?.byRoute ?? [];
  const maxRouteCost = Math.max(0.0001, ...byRoute.map((r) => r.estUsd));

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-4">
        <h1 className="text-xl font-bold text-slate-900">💰 비용 체크</h1>
        <p className="mt-1 text-xs text-slate-600">
          최근 N일간 <strong>각 작업(API 라우트)별 호출 횟수·추정 비용</strong>을 한 곳에서 봅니다.
          데이터 소스는 <code>auto_pipeline_runs</code> · <code>analysis_records</code> ·{" "}
          <code>api_call_logs</code> 3종. 추정 비용은 모델별 평균 단가 기준 <strong>±50% 오차</strong>{" "}
          — 정확한 청구액은 Google AI Studio · OpenAI · Mathpix billing 확인.
        </p>
      </header>

      {/* 기간 선택 */}
      <section className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-700">기간:</span>
        {PERIOD_OPTIONS.map((p) => (
          <button
            key={p.days}
            onClick={() => setDays(p.days)}
            className={`rounded-md border px-3 py-1 text-xs font-semibold transition-colors ${
              days === p.days
                ? "border-indigo-700 bg-indigo-700 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => void load(days)}
          disabled={loading}
          className="ml-auto rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? "불러오는 중…" : "🔄 새로고침"}
        </button>
      </section>

      {error && (
        <div className="mb-3 rounded-md border border-rose-300 bg-rose-50 p-3 text-xs text-rose-900">
          <div className="font-semibold">✗ /api/cost-tracker 응답 실패</div>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-rose-900">
            {error}
          </pre>
        </div>
      )}

      {data && data.configured === false && (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          ⚠️ Supabase 미설정 — 사용량 추적 불가. <code>SUPABASE_SERVICE_ROLE_KEY</code> 등 env 가
          필요합니다. 아래 「라우트 단가 카탈로그」는 정적 참조로 항상 노출됩니다.
        </div>
      )}

      {/* 🚨 24h 알람 — level: 'high' 진단을 prominent 배너로 분리 노출. */}
      {/*    사용자가 선택한 기간(1d/7d/30d/90d) 과 무관하게 항상 last 24h 기준이라 */}
      {/*    30일 보고 있어도 최근 사고를 못 보고 지나치지 않음. */}
      {data && data.diagnoses?.some((d) => d.level === "high") && (
        <section className="mb-4 rounded-lg border-2 border-rose-400 bg-rose-50 p-4 shadow-md">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">
              ALERT
            </span>
            <h2 className="text-sm font-bold text-rose-900">24시간 알람 — 즉시 점검 필요</h2>
            {data.last24h && (
              <span className="ml-auto text-[11px] text-rose-700">
                24h: 실행 {data.last24h.runs}건 · 실패{" "}
                {(data.last24h.failureRate * 100).toFixed(0)}% · 재시도 비중{" "}
                {(data.last24h.retryShare * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <ul className="space-y-1.5">
            {data.diagnoses
              .filter((d) => d.level === "high")
              .map((d, i) => (
                <li key={i} className="text-xs leading-relaxed text-rose-900">
                  {d.message}
                </li>
              ))}
          </ul>
        </section>
      )}

      {/* 총 비용 카드 */}
      {data && (
        <section className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
          <SummaryCard
            label="총 추정 비용"
            valueUsd={totalEstUsd}
            valueKrw={total?.estKrw ?? 0}
            tone="indigo"
          />
          <SummaryCard
            label="해설 풀이 (LLM)"
            valueUsd={data.autoPipeline.estUsd}
            valueKrw={data.autoPipeline.estKrw}
            note={`${data.autoPipeline.totalCalls}건 × 평균 ${
              data.autoPipeline.totalAttempts && data.autoPipeline.totalCalls
                ? (data.autoPipeline.totalAttempts / data.autoPipeline.totalCalls).toFixed(2)
                : "1.00"
            } 시도`}
          />
          <SummaryCard
            label="Drive 학습 OCR"
            valueUsd={data.driveLearning.ocrEstUsd}
            valueKrw={data.driveLearning.ocrEstKrw}
            note={`${data.driveLearning.totalRecords} record · ${
              data.driveLearning.visionCallsEst ?? 0
            } vision call`}
          />
          <SummaryCard
            label="그 외 라우트 (api_call_logs)"
            valueUsd={data.apiCallLogs?.estUsd ?? 0}
            valueKrw={data.apiCallLogs?.estKrw ?? 0}
            note={
              data.apiCallLogs?.configured === false
                ? "테이블 미적용 — 기록 없음"
                : `${data.apiCallLogs?.totalCalls ?? 0}건`
            }
            tone={data.apiCallLogs?.configured === false ? "amber" : undefined}
          />
        </section>
      )}

      {/* 라우트별 표 — 가장 큰 비용 비중 위에서부터 */}
      {data && (
        <section className="mb-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">
            라우트별 호출 / 비용 ({byRoute.length}개)
          </h2>
          {byRoute.length === 0 ? (
            <p className="rounded border border-slate-200 bg-slate-50 px-2 py-2 text-xs text-slate-600">
              최근 {days}일간 호출 기록 없음. 사용 시작 후 데이터가 누적됩니다 — 아래 「라우트 단가
              카탈로그」 참조.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-600">
                    <th className="py-2 pr-2 font-semibold">라우트 / 용도</th>
                    <th className="py-2 pr-2 font-semibold">트리거</th>
                    <th className="py-2 pr-2 font-semibold">벤더 / 모델</th>
                    <th className="py-2 pr-2 text-right font-semibold">호출</th>
                    <th className="py-2 pr-2 text-right font-semibold">평균 단가</th>
                    <th className="py-2 pr-2 text-right font-semibold">추정 비용</th>
                  </tr>
                </thead>
                <tbody>
                  {byRoute.map((r) => {
                    const widthPct = Math.max(2, Math.round((r.estUsd / maxRouteCost) * 100));
                    return (
                      <tr key={r.route + ":" + r.source} className="border-b border-slate-100">
                        <td className="py-2 pr-2 align-top">
                          <div className="font-mono text-[11px] text-slate-800">{r.route}</div>
                          <div className="text-slate-600">{r.purpose}</div>
                          <div className="mt-0.5 text-[10px] text-slate-400">
                            소스: {sourceLabel(r.source)}
                          </div>
                        </td>
                        <td className="py-2 pr-2 align-top text-slate-600">{r.trigger}</td>
                        <td className="py-2 pr-2 align-top">
                          <div className="text-slate-800">{r.vendor}</div>
                          <div className="text-[10px] text-slate-500">
                            {r.models.join(", ") || "—"}
                          </div>
                        </td>
                        <td className="py-2 pr-2 text-right align-top tabular-nums">
                          <div className="text-slate-800">{r.calls.toLocaleString()}</div>
                          {r.units !== r.calls && (
                            <div className="text-[10px] text-slate-500">
                              {r.units.toLocaleString()} units
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-2 text-right align-top tabular-nums text-slate-600">
                          {fmtUsd(r.avgPerCallUsd)}
                        </td>
                        <td className="py-2 pr-2 text-right align-top">
                          <div className="font-semibold tabular-nums text-slate-900">
                            {fmtUsd(r.estUsd)}
                          </div>
                          <div className="text-[10px] tabular-nums text-slate-500">
                            {fmtKrw(r.estKrw)}
                          </div>
                          <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full bg-indigo-500"
                              style={{ width: `${widthPct}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* 라우트 × 모델 세부 — 「어디서 어떤 모델로 얼마」 한 줄씩 */}
      {data && Array.isArray(data.byRouteModel) && data.byRouteModel.length > 0 && (
        <section className="mb-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-1 text-sm font-semibold text-slate-900">
            라우트 × 모델 세부 ({data.byRouteModel.length}행)
          </h2>
          <p className="mb-2 text-[11px] text-slate-600">
            같은 데이터를 「작업 + 사용 모델」 조합으로 더 잘게 자른 표.{" "}
            <strong>비싼 행이 위로</strong> — 줄일 첫 후보가 바로 보입니다.
            전체 합계는 위 라우트별 표와 동일.
          </p>
          <RouteModelTable
            rows={data.byRouteModel}
            totalEstUsd={totalEstUsd}
          />
        </section>
      )}

      {/* 시중교재 자동 빌드 상태 패널 — Railway 가 매일 자동으로 처리한 결과 표시 */}
      {data?.textbookBuild && data.textbookBuild.intervalHours > 0 && (
        <section className="mb-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-900">시중교재·시험지 원안 자동 빌드</h2>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
              {data.textbookBuild.intervalHours.toFixed(0)}h 주기
            </span>
            {data.textbookBuild.lastOk ? (
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
                정상
              </span>
            ) : data.textbookBuild.lastRunAt ? (
              <span className="rounded bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-800">
                실패
              </span>
            ) : (
              <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                대기
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 text-xs text-slate-700 md:grid-cols-3">
            <div>
              <div className="text-slate-500">마지막 실행</div>
              <div className="font-medium">
                {data.textbookBuild.lastRunAt
                  ? new Date(data.textbookBuild.lastRunAt).toLocaleString("ko-KR")
                  : "—"}
              </div>
            </div>
            <div>
              <div className="text-slate-500">새로 처리한 책</div>
              <div className="font-medium">
                {data.textbookBuild.processedBooks}건 (스킵 {data.textbookBuild.skippedBooks}건)
              </div>
            </div>
            <div>
              <div className="text-slate-500">누적 실행</div>
              <div className="font-medium">{data.textbookBuild.totalRuns}회</div>
            </div>
          </div>
          {data.textbookBuild.byFolder.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[11px] text-slate-600">
              {data.textbookBuild.byFolder.map((f) => (
                <li key={f.label}>
                  <span className="font-medium">{f.label}</span> — 발견 {f.found}, 처리 {f.processedBooks}, 스킵 {f.skippedBooks}
                </li>
              ))}
            </ul>
          )}
          {data.textbookBuild.errors.length > 0 && (
            <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-800">
              {data.textbookBuild.errors[0]}
            </div>
          )}
        </section>
      )}

      {/* 진단 메시지 — 'high' 는 위 ALERT 배너에 별도 노출되므로 여기서는 info/warn 만 */}
      {data && data.diagnoses && data.diagnoses.some((d) => d.level !== "high") && (
        <section className="mb-4 space-y-1.5">
          {data.diagnoses
            .filter((d) => d.level !== "high")
            .map((d, i) => (
              <div
                key={i}
                className={`rounded-md border px-3 py-2 text-xs ${badgeColor(d.level)}`}
              >
                <strong className="mr-2 uppercase">[{d.level}]</strong>
                {d.message}
              </div>
            ))}
        </section>
      )}

      {/* 합산 분배 */}
      {data && total && (
        <section className="mb-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">합산 분배</h2>
          <ul className="space-y-1 text-xs text-slate-700">
            {Object.entries(total.breakdown).map(([k, v]) => {
              const pct = totalEstUsd > 0 ? (v / totalEstUsd) * 100 : 0;
              return (
                <li key={k} className="flex items-center gap-3">
                  <span className="w-44 text-slate-600">{k.replace(/_/g, " ")}</span>
                  <div className="flex-1">
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full bg-indigo-400" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                  <span className="w-24 text-right tabular-nums">{fmtUsd(v)}</span>
                  <span className="w-12 text-right text-slate-500 tabular-nums">
                    {pct.toFixed(0)}%
                  </span>
                </li>
              );
            })}
          </ul>
          {data.academy?.configured === false && (
            <p className="mt-2 text-[11px] text-slate-500">
              학원관리(academy_manager)는 별도 Supabase 프로젝트 — <code>ACADEMY_SUPABASE_URL</code>{" "}
              env 추가 시 합산에 포함됩니다.
            </p>
          )}
        </section>
      )}

      {/* 정적 단가 카탈로그 — 데이터 없어도 항상 노출 */}
      <section className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
        <h2 className="mb-1 text-sm font-semibold text-slate-900">
          라우트 단가 카탈로그 (참조)
        </h2>
        <p className="mb-2 text-[11px] text-slate-600">
          모든 외부 과금 API 호출 라우트와 「어디서 무슨 용도, 호출당 얼마」 정적 표.
          호출 데이터가 없어도 보입니다.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-slate-300 text-left text-slate-700">
                <th className="py-1.5 pr-2 font-semibold">라우트</th>
                <th className="py-1.5 pr-2 font-semibold">용도</th>
                <th className="py-1.5 pr-2 font-semibold">트리거</th>
                <th className="py-1.5 pr-2 font-semibold">벤더</th>
                <th className="py-1.5 pr-2 font-semibold">호출당 비용</th>
                <th className="py-1.5 pr-2 font-semibold">기록 위치</th>
              </tr>
            </thead>
            <tbody>
              {ROUTE_CATALOG.map((c) => (
                <tr key={c.route} className="border-b border-slate-200">
                  <td className="py-1.5 pr-2 align-top font-mono text-slate-800">{c.route}</td>
                  <td className="py-1.5 pr-2 align-top text-slate-700">
                    {c.purpose}
                    {c.notes && (
                      <div className="text-[10px] text-slate-500">↳ {c.notes}</div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 align-top text-slate-600">{c.trigger}</td>
                  <td className="py-1.5 pr-2 align-top text-slate-700">{c.vendor}</td>
                  <td className="py-1.5 pr-2 align-top tabular-nums text-slate-700">
                    {c.perCallUsd}
                  </td>
                  <td className="py-1.5 pr-2 align-top">
                    <code className="rounded bg-white px-1 py-0.5 text-[10px] text-slate-700">
                      {c.trackedBy}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 기록 누락 안내 */}
      {data?.apiCallLogs?.configured === false && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <strong>api_call_logs 테이블 미적용.</strong> 사진 편집기·AI 페어 정제·BBox 폴백 등 짧은
          호출이 비용 통계에 잡히지 않습니다. Supabase SQL Editor 에서{" "}
          <code>supabase/api_call_logs.sql</code> 을 한 번 실행하면 그 이후 호출부터 누적됩니다.
          {data.apiCallLogs.error && (
            <div className="mt-1 text-[10px] opacity-70">↳ {data.apiCallLogs.error}</div>
          )}
        </div>
      )}

      {data?.hint && (
        <p className="mt-3 text-[11px] text-slate-500">💡 {data.hint}</p>
      )}

      {/* 분석 현황 — /auto 에서 이동. 시중교재/시험지 원안 진행상태·DB 통계·무결성 이슈를 비용 옆에서 함께 보게. */}
      <AnalysisStatusSection />
    </div>
  );
}

/**
 * 분석 현황 섹션 — 토글 접힘. AnalysisStatusPanel 자체가 fetch 비용이 있어
 * 사용자가 열 때만 마운트(=fetch). 기본 닫힘 상태로 페이지 로딩 가볍게.
 */
function AnalysisStatusSection() {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={open}
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            📚 분석 현황 (시중교재 · 시험지 원안 학습 진행)
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-600">
            폴더별 OCR 처리율, DB record 통계, 무결성 이슈, 자동 추천 액션을 한눈에.
            비용 폭증 원인 추적할 때 같이 보면 유용합니다.
          </p>
        </div>
        <span
          aria-hidden
          className={`inline-block w-3 text-[11px] text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▶
        </span>
      </button>
      {open && (
        <div className="mt-3">
          <AnalysisStatusPanel />
        </div>
      )}
    </section>
  );
}

function SummaryCard({
  label,
  valueUsd,
  valueKrw,
  note,
  tone,
}: {
  label: string;
  valueUsd: number;
  valueKrw: number;
  note?: string;
  tone?: "indigo" | "amber";
}) {
  const toneClass =
    tone === "indigo"
      ? "border-indigo-300 bg-indigo-50"
      : tone === "amber"
        ? "border-amber-300 bg-amber-50"
        : "border-slate-200 bg-white";
  return (
    <div className={`rounded-lg border p-3 shadow-sm ${toneClass}`}>
      <div className="text-[10px] font-semibold uppercase text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">
        {fmtUsd(valueUsd)}
      </div>
      <div className="text-[11px] tabular-nums text-slate-600">{fmtKrw(valueKrw)}</div>
      {note && <div className="mt-1 text-[10px] text-slate-500">{note}</div>}
    </div>
  );
}

/**
 * 「라우트 × 모델」 표 — 같은 데이터를 더 잘게 자른 view.
 *  비싼 행이 위로. 비중 % 막대로 시각화 — 한눈에 어디가 큰 비용인지 식별.
 */
function RouteModelTable({
  rows,
  totalEstUsd,
}: {
  rows: ByRouteModelRow[];
  totalEstUsd: number;
}) {
  const maxCost = Math.max(0.0001, ...rows.map((r) => r.estUsd));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-600">
            <th className="py-2 pr-2 font-semibold">작업 (라우트)</th>
            <th className="py-2 pr-2 font-semibold">모델</th>
            <th className="py-2 pr-2 font-semibold">벤더</th>
            <th className="py-2 pr-2 text-right font-semibold">호출</th>
            <th className="py-2 pr-2 text-right font-semibold">평균 단가</th>
            <th className="py-2 pr-2 text-right font-semibold">추정 비용</th>
            <th className="py-2 pr-2 text-right font-semibold">비중</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const pct = totalEstUsd > 0 ? (r.estUsd / totalEstUsd) * 100 : 0;
            const widthPct = Math.max(2, Math.round((r.estUsd / maxCost) * 100));
            return (
              <tr
                key={`${r.route}::${r.model}::${i}`}
                className="border-b border-slate-100"
              >
                <td className="py-2 pr-2 align-top">
                  <div className="font-mono text-[11px] text-slate-800">{r.route}</div>
                  <div className="text-[10px] text-slate-500">{r.purpose}</div>
                </td>
                <td className="py-2 pr-2 align-top">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-700">
                    {r.model}
                  </span>
                </td>
                <td className="py-2 pr-2 align-top">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      r.vendor === "openai"
                        ? "bg-emerald-100 text-emerald-800"
                        : r.vendor === "mathpix"
                          ? "bg-amber-100 text-amber-800"
                          : r.vendor === "gemini"
                            ? "bg-indigo-100 text-indigo-800"
                            : "bg-slate-100 text-slate-700"
                    }`}
                  >
                    {r.vendor}
                  </span>
                </td>
                <td className="py-2 pr-2 text-right align-top tabular-nums text-slate-800">
                  {r.calls.toLocaleString()}
                  {r.units !== r.calls && (
                    <div className="text-[10px] text-slate-500">
                      {r.units.toLocaleString()} units
                    </div>
                  )}
                </td>
                <td className="py-2 pr-2 text-right align-top tabular-nums text-slate-600">
                  {fmtUsd(r.avgPerCallUsd)}
                </td>
                <td className="py-2 pr-2 text-right align-top">
                  <div className="font-semibold tabular-nums text-slate-900">
                    {fmtUsd(r.estUsd)}
                  </div>
                  <div className="text-[10px] tabular-nums text-slate-500">
                    {fmtKrw(r.estKrw)}
                  </div>
                </td>
                <td className="py-2 pr-2 text-right align-top">
                  <div className="flex items-center justify-end gap-1.5">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full bg-indigo-500"
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                    <span className="w-8 text-right text-[10px] tabular-nums text-slate-500">
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
