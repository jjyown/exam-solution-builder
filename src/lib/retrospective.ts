/**
 * retrospective.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  누적된 실행 데이터(`auto_pipeline_runs`, `analysis_records`, 사용자 피드백)
 *  를 주기적으로 검토하여 **코드·프롬프트 개선 제안** 을 자동 생성한다.
 *
 *  사용처:
 *   - GET /api/retrospective         — 브라우저에서 즉시 조회 (JSON)
 *   - npm run retrospective          — CLI 로 markdown 리포트를 docs/ 에 저장
 *   - GitHub Actions 주 1회 cron     — (옵션) 자동 PR 로 리포트 누적
 *
 *  핵심 가치: 단순 통계가 아닌 **구체적 개선 행동** 까지 제시:
 *    - 자주 실패하는 패턴에 대한 프롬프트 보강 후보
 *    - 형식 검증 정규식 강화 후보
 *    - 모델 우선순위 재조정 후보
 *    - 사용자 평점 낮은 케이스의 공통 특징
 * ────────────────────────────────────────────────────────────────────────────
 */
import { getSupabaseServiceClient } from "./supabaseServiceClient";

export type Priority = "high" | "medium" | "low";

export type ImprovementSuggestion = {
  priority: Priority;
  area: string;
  finding: string;
  suggestion: string;
  /** 영향 파일 — 사용자가 직접 열어볼 수 있게 경로 표기 */
  affectedFiles?: string[];
};

export type RetrospectiveReport = {
  generatedAt: string;
  period: { start: string; end: string; days: number };
  setup: {
    supabaseConfigured: boolean;
    tablesAvailable: { auto_pipeline_runs: boolean; analysis_records: boolean };
  };
  summary: {
    totalRuns: number;
    successCount: number;
    failureCount: number;
    successRate: number; // 0-1
    avgAttempts: number;
    reviewedCount: number;
    avgUserRating: number | null;
    lowRatedCount: number;
  };
  failureCategories: Record<string, { count: number; examples: string[] }>;
  modelPerformance: Record<
    string,
    { runs: number; successRate: number; avgAttempts: number }
  >;
  promptFormatIssues: Record<string, { count: number; examples: string[] }>;
  lowRatedRuns: Array<{
    id: string;
    rating: number;
    questionNo: string | null;
    questionTextSnippet: string;
    feedback: string | null;
  }>;
  /** 실제 개선 액션 — 우선순위 순 */
  improvementSuggestions: ImprovementSuggestion[];
};

type RawRun = {
  id: string;
  created_at: string;
  exam_name: string | null;
  question_no: string | null;
  question_text: string | null;
  model: string | null;
  attempts: number | null;
  ok: boolean | null;
  errors: unknown;
  trace: unknown;
  user_rating: number | null;
  user_feedback: string | null;
  reviewed_at: string | null;
};

type GenerateOptions = {
  /** 며칠치 데이터를 분석할지. 기본 30 */
  days?: number;
  /** 가져올 최대 row 수. 기본 1000 */
  maxRows?: number;
};

export async function generateRetrospective(
  opts: GenerateOptions = {},
): Promise<RetrospectiveReport> {
  const days = opts.days ?? 30;
  const maxRows = opts.maxRows ?? 1000;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  const nowIso = new Date().toISOString();

  const empty: RetrospectiveReport = {
    generatedAt: nowIso,
    period: { start: sinceIso, end: nowIso, days },
    setup: {
      supabaseConfigured: false,
      tablesAvailable: { auto_pipeline_runs: false, analysis_records: false },
    },
    summary: emptySummary(),
    failureCategories: {},
    modelPerformance: {},
    promptFormatIssues: {},
    lowRatedRuns: [],
    improvementSuggestions: [],
  };

  const client = getSupabaseServiceClient();
  if (!client) {
    empty.improvementSuggestions.push({
      priority: "high",
      area: "infra",
      finding: "Supabase 미설정 — 누적 데이터를 분석할 수 없음",
      suggestion: "SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 환경변수를 설정.",
    });
    return empty;
  }
  empty.setup.supabaseConfigured = true;

  // 1) auto_pipeline_runs 조회
  const { data: runsData, error: runsErr } = await client
    .from("auto_pipeline_runs")
    .select(
      "id, created_at, exam_name, question_no, question_text, model, attempts, ok, errors, trace, user_rating, user_feedback, reviewed_at",
    )
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(maxRows);

  if (runsErr) {
    empty.setup.tablesAvailable.auto_pipeline_runs = false;
    empty.improvementSuggestions.push({
      priority: "medium",
      area: "infra",
      finding: `auto_pipeline_runs 조회 실패: ${runsErr.message}`,
      suggestion:
        "supabase/auto_pipeline_runs.sql 마이그레이션 적용 또는 권한 점검.",
    });
    return empty;
  }
  empty.setup.tablesAvailable.auto_pipeline_runs = true;
  const runs = (runsData ?? []) as RawRun[];

  // 2) analysis_records 카운트 — 시중교재 수집 진행도 확인
  const { count: analysisCount, error: analysisErr } = await client
    .from("analysis_records")
    .select("id", { count: "exact", head: true });
  if (!analysisErr) {
    empty.setup.tablesAvailable.analysis_records = true;
  }

  // 3) 분석
  const summary = computeSummary(runs);
  const failureCategories = categorizeFailures(runs);
  const modelPerformance = computeModelPerformance(runs);
  const promptFormatIssues = detectPromptFormatIssues(runs);
  const lowRatedRuns = findLowRated(runs);
  const improvementSuggestions = deriveSuggestions({
    runs,
    summary,
    failureCategories,
    modelPerformance,
    promptFormatIssues,
    lowRatedRuns,
    analysisCount: analysisCount ?? 0,
  });

  return {
    ...empty,
    summary,
    failureCategories,
    modelPerformance,
    promptFormatIssues,
    lowRatedRuns,
    improvementSuggestions,
  };
}

// ─── 분석 헬퍼 ────────────────────────────────────────────────────────────

function emptySummary(): RetrospectiveReport["summary"] {
  return {
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    successRate: 0,
    avgAttempts: 0,
    reviewedCount: 0,
    avgUserRating: null,
    lowRatedCount: 0,
  };
}

function computeSummary(runs: RawRun[]): RetrospectiveReport["summary"] {
  if (runs.length === 0) return emptySummary();
  const ok = runs.filter((r) => r.ok === true).length;
  const fail = runs.filter((r) => r.ok === false).length;
  const reviewed = runs.filter((r) => r.reviewed_at).length;
  const ratings = runs
    .map((r) => r.user_rating)
    .filter((x): x is number => typeof x === "number");
  const lowRated = ratings.filter((r) => r <= 2).length;
  const totalAttempts = runs.reduce((s, r) => s + (r.attempts ?? 0), 0);
  return {
    totalRuns: runs.length,
    successCount: ok,
    failureCount: fail,
    successRate: ok / runs.length,
    avgAttempts: totalAttempts / runs.length,
    reviewedCount: reviewed,
    avgUserRating:
      ratings.length > 0 ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
    lowRatedCount: lowRated,
  };
}

function categorizeFailures(
  runs: RawRun[],
): RetrospectiveReport["failureCategories"] {
  const categories: RetrospectiveReport["failureCategories"] = {};
  for (const r of runs) {
    if (r.ok !== false) continue;
    const errorList = Array.isArray(r.errors) ? (r.errors as unknown[]) : [];
    for (const errRaw of errorList) {
      const err = String(errRaw ?? "").trim();
      if (!err) continue;
      const cat = classifyError(err);
      categories[cat] ??= { count: 0, examples: [] };
      categories[cat].count += 1;
      if (categories[cat].examples.length < 3) {
        categories[cat].examples.push(`${r.id.slice(0, 8)}: ${err.slice(0, 140)}`);
      }
    }
    // errors 비어 있으면 "no-detail"
    if (errorList.length === 0) {
      categories["no-detail"] ??= { count: 0, examples: [] };
      categories["no-detail"].count += 1;
      if (categories["no-detail"].examples.length < 3) {
        categories["no-detail"].examples.push(
          `${r.id.slice(0, 8)}: 실패했으나 errors 컬럼 비어 있음`,
        );
      }
    }
  }
  return categories;
}

function classifyError(err: string): string {
  const e = err.toLowerCase();
  if (/quota|rate.?limit|429|resource_exhausted/.test(e)) return "quota-exhausted";
  if (/timeout|aborted|408|deadline/.test(e)) return "timeout";
  if (/json|parse|format\s*미달|invalid.*format/.test(e)) return "format-mismatch";
  if (/network|fetch|enotfound|econnrefused|502|503/.test(e)) return "network";
  if (/mathpix/.test(e)) return "mathpix-error";
  if (/gemini/.test(e)) return "gemini-error";
  if (/auth|invalid_grant|401|403/.test(e)) return "auth-error";
  if (/empty|빈\s*텍스트|no\s*content/.test(e)) return "empty-output";
  return "other";
}

function computeModelPerformance(
  runs: RawRun[],
): RetrospectiveReport["modelPerformance"] {
  const byModel: Record<string, RawRun[]> = {};
  for (const r of runs) {
    const key = r.model || "unknown";
    byModel[key] ??= [];
    byModel[key].push(r);
  }
  const out: RetrospectiveReport["modelPerformance"] = {};
  for (const [model, list] of Object.entries(byModel)) {
    const ok = list.filter((r) => r.ok === true).length;
    const totalAttempts = list.reduce((s, r) => s + (r.attempts ?? 0), 0);
    out[model] = {
      runs: list.length,
      successRate: list.length > 0 ? ok / list.length : 0,
      avgAttempts: list.length > 0 ? totalAttempts / list.length : 0,
    };
  }
  return out;
}

function detectPromptFormatIssues(
  runs: RawRun[],
): RetrospectiveReport["promptFormatIssues"] {
  const issues: RetrospectiveReport["promptFormatIssues"] = {};
  for (const r of runs) {
    const trace = Array.isArray(r.trace) ? (r.trace as unknown[]) : [];
    for (const stepRaw of trace) {
      const step = JSON.stringify(stepRaw ?? {}).toLowerCase();
      // 형식 미달 폴백 패턴
      if (/형식\s*미달|format\s*mismatch|invalid\s*format/.test(step)) {
        const key = "exam-name-or-output-format";
        issues[key] ??= { count: 0, examples: [] };
        issues[key].count += 1;
        if (issues[key].examples.length < 3) {
          issues[key].examples.push(`${r.id.slice(0, 8)}: ${step.slice(0, 160)}`);
        }
      }
      // JSON 파싱 실패
      if (/json\s*파싱\s*실패|parse\s*failed/.test(step)) {
        const key = "json-parse-failed";
        issues[key] ??= { count: 0, examples: [] };
        issues[key].count += 1;
        if (issues[key].examples.length < 3) {
          issues[key].examples.push(`${r.id.slice(0, 8)}: ${step.slice(0, 160)}`);
        }
      }
      // 헤더 못 읽음 (학교명 추출 grounding 실패)
      if (/헤더\s*텍스트\s*못\s*읽음|cannot\s*read\s*header/.test(step)) {
        const key = "header-unreadable";
        issues[key] ??= { count: 0, examples: [] };
        issues[key].count += 1;
        if (issues[key].examples.length < 3) {
          issues[key].examples.push(`${r.id.slice(0, 8)}: ${step.slice(0, 160)}`);
        }
      }
    }
  }
  return issues;
}

function findLowRated(runs: RawRun[]): RetrospectiveReport["lowRatedRuns"] {
  return runs
    .filter((r) => typeof r.user_rating === "number" && r.user_rating! <= 2)
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      rating: r.user_rating!,
      questionNo: r.question_no,
      questionTextSnippet: (r.question_text ?? "").slice(0, 120),
      feedback: r.user_feedback,
    }));
}

// ─── 개선 제안 도출 ───────────────────────────────────────────────────────

function deriveSuggestions(input: {
  runs: RawRun[];
  summary: RetrospectiveReport["summary"];
  failureCategories: RetrospectiveReport["failureCategories"];
  modelPerformance: RetrospectiveReport["modelPerformance"];
  promptFormatIssues: RetrospectiveReport["promptFormatIssues"];
  lowRatedRuns: RetrospectiveReport["lowRatedRuns"];
  analysisCount: number;
}): ImprovementSuggestion[] {
  const out: ImprovementSuggestion[] = [];
  const { summary, failureCategories, modelPerformance, promptFormatIssues, lowRatedRuns, analysisCount } = input;

  // 1) 전체 성공률
  if (summary.totalRuns >= 10) {
    if (summary.successRate < 0.7) {
      out.push({
        priority: "high",
        area: "전체 성공률",
        finding: `최근 ${summary.totalRuns} 건 성공률 ${pct(summary.successRate)} (실패 ${summary.failureCount}건)`,
        suggestion:
          "가장 큰 실패 카테고리(아래 failureCategories 1순위) 우선 대응. 모델 폴백 순서 조정 또는 프롬프트 보강 필요.",
        affectedFiles: ["src/lib/autoPipeline.ts", "src/lib/promptBuilder.ts"],
      });
    } else if (summary.successRate < 0.9) {
      out.push({
        priority: "medium",
        area: "전체 성공률",
        finding: `성공률 ${pct(summary.successRate)} — 개선 여지 있음`,
        suggestion:
          "실패 카테고리 분포 확인 후 가장 빈도 높은 종류 1-2개에 집중 대응.",
      });
    }
  }

  // 2) 카테고리별 실패 패턴
  const sortedCats = Object.entries(failureCategories).sort(
    (a, b) => b[1].count - a[1].count,
  );
  for (const [cat, info] of sortedCats.slice(0, 3)) {
    if (info.count < 3) break;
    const sug = suggestionForCategory(cat, info.count);
    if (sug) out.push(sug);
  }

  // 3) 모델 성능 차이
  const modelEntries = Object.entries(modelPerformance).filter(
    ([, m]) => m.runs >= 5,
  );
  if (modelEntries.length >= 2) {
    modelEntries.sort((a, b) => b[1].successRate - a[1].successRate);
    const best = modelEntries[0];
    const worst = modelEntries[modelEntries.length - 1];
    if (best[1].successRate - worst[1].successRate > 0.2) {
      out.push({
        priority: "medium",
        area: "모델 우선순위",
        finding: `모델별 성공률 차이 ≥ 20% (최고 ${best[0]} ${pct(best[1].successRate)} vs 최저 ${worst[0]} ${pct(worst[1].successRate)})`,
        suggestion: `폴백 순서를 ${best[0]} 우선으로 조정하거나, 저성과 모델은 폴백에서만 사용 검토.`,
        affectedFiles: ["src/lib/photoEditGemini.ts", "src/lib/geminiVisionExtract.ts"],
      });
    }
  }

  // 4) 프롬프트 형식 미달
  if ((promptFormatIssues["exam-name-or-output-format"]?.count ?? 0) >= 5) {
    out.push({
      priority: "high",
      area: "프롬프트 형식 검증",
      finding: `「형식 미달」 폴백 ${promptFormatIssues["exam-name-or-output-format"].count}건`,
      suggestion:
        "PROMPT_EXAM_NAME 또는 PROMPT_DETECT_BOX 의 출력 예시를 더 명확히 하거나, 형식 검증 정규식을 더 관대하게 수정. 예시들을 점검:\n" +
        promptFormatIssues["exam-name-or-output-format"].examples.map((e) => `   · ${e}`).join("\n"),
      affectedFiles: ["src/lib/photoEditGemini.ts", "src/lib/promptBuilder.ts"],
    });
  }
  if ((promptFormatIssues["json-parse-failed"]?.count ?? 0) >= 3) {
    out.push({
      priority: "medium",
      area: "JSON 파싱",
      finding: `JSON 파싱 실패 ${promptFormatIssues["json-parse-failed"].count}건`,
      suggestion:
        "responseMimeType: 'application/json' 명시 + 프롬프트에 「JSON 한 줄만, 마크다운 금지」 강조. 또는 파싱 측에서 코드펜스·prefix 제거 정규식 보강.",
      affectedFiles: ["src/lib/photoEditGemini.ts"],
    });
  }
  if ((promptFormatIssues["header-unreadable"]?.count ?? 0) >= 3) {
    out.push({
      priority: "medium",
      area: "학교명 영역 추출",
      finding: `「헤더 텍스트 못 읽음」 ${promptFormatIssues["header-unreadable"].count}건`,
      suggestion:
        "사용자가 nameAreaBox 를 표시 안 했을 가능성. 시험지 편집 UI 에 「📌 시험명 영역」 버튼 강조 또는 자동 감지 로직 보강.",
      affectedFiles: ["src/app/edit/page.tsx"],
    });
  }

  // 5) 낮은 사용자 평점
  if (lowRatedRuns.length >= 3) {
    const sample = lowRatedRuns.slice(0, 3).map((r) => ({
      id: r.id.slice(0, 8),
      questionNo: r.questionNo,
      feedback: (r.feedback ?? "").slice(0, 100),
    }));
    out.push({
      priority: "high",
      area: "사용자 만족도",
      finding: `낮은 평점(≤2) ${lowRatedRuns.length} 건 — 공통 패턴 확인 필요`,
      suggestion:
        "다음 케이스들의 question_text·trace 를 직접 확인해 공통 원인 추출:\n" +
        sample.map((s) => `   · ${s.id} (${s.questionNo ?? "no#"}): ${s.feedback || "(피드백 없음)"}`).join("\n"),
      affectedFiles: ["src/lib/autoPipeline.ts", "src/lib/promptBuilder.ts"],
    });
  }

  // 6) 검수 적극성
  if (summary.totalRuns >= 20 && summary.reviewedCount / summary.totalRuns < 0.1) {
    out.push({
      priority: "low",
      area: "사용자 검수 데이터 수집",
      finding: `${summary.totalRuns} 건 중 검수(reviewed) ${summary.reviewedCount} 건 (${pct(summary.reviewedCount / summary.totalRuns)})`,
      suggestion:
        "사용자가 결과 검수·평점 입력하는 UX 노출 강화. 별점 위젯 또는 「개선 의견」 텍스트박스 노출 빈도 증가.",
      affectedFiles: ["src/app/auto/page.tsx"],
    });
  }

  // 7) 분석용 자료 누적도
  if (analysisCount === 0) {
    out.push({
      priority: "high",
      area: "RAG 참고자료",
      finding: "analysis_records 테이블 비어 있음 — 시중교재 OCR 데이터 0건",
      suggestion:
        "Drive 「분석용 자료/시중교재」 폴더에 PDF 업로드 후 POST /api/drive/analysis/sync. 또는 자동 백그라운드 스케줄러 (4시간 주기) 동작 확인.",
      affectedFiles: ["src/lib/driveAnalysisLearner.ts", "src/lib/driveAnalysisAutoSync.ts"],
    });
  } else if (analysisCount < 50) {
    out.push({
      priority: "low",
      area: "RAG 참고자료",
      finding: `analysis_records 누적 ${analysisCount} 건 — RAG 검색 다양성 부족 가능`,
      suggestion: "시중교재 분량 추가 업로드 권장 (다양한 단원·난이도 커버).",
    });
  }

  return out;
}

function suggestionForCategory(
  cat: string,
  count: number,
): ImprovementSuggestion | null {
  switch (cat) {
    case "quota-exhausted":
      return {
        priority: "high",
        area: "API 한도",
        finding: `quota 초과 ${count}건`,
        suggestion:
          "Gemini 무료 한도 초과 또는 Mathpix 잔여 부족. /api/mathpix-status 확인. 한도 큰 모델로 폴백 추가 검토.",
        affectedFiles: ["src/lib/geminiVisionExtract.ts", "src/lib/mathpixV3Text.ts"],
      };
    case "timeout":
      return {
        priority: "medium",
        area: "응답 timeout",
        finding: `timeout 실패 ${count}건`,
        suggestion:
          "callGemini timeoutMs 또는 recognizeMathpixPdf maxWaitMs 상향. 또는 입력 이미지 크기 축소 사전 처리.",
        affectedFiles: ["src/lib/photoEditGemini.ts", "src/lib/mathpixV3Pdf.ts"],
      };
    case "format-mismatch":
      return {
        priority: "high",
        area: "응답 형식",
        finding: `형식 미달 ${count}건`,
        suggestion:
          "프롬프트 「출력 형식」 강조 + 응답 검증 정규식 보강. responseMimeType: application/json 적용 검토.",
        affectedFiles: ["src/lib/photoEditGemini.ts"],
      };
    case "auth-error":
      return {
        priority: "high",
        area: "인증",
        finding: `auth/invalid_grant ${count}건`,
        suggestion:
          "Drive refresh_token 만료 가능. OAuth Playground 로 재발급 후 GOOGLE_REFRESH_TOKEN 갱신.",
        affectedFiles: ["src/lib/googleDrive.ts"],
      };
    case "network":
      return {
        priority: "medium",
        area: "네트워크",
        finding: `네트워크 실패 ${count}건`,
        suggestion: "재시도 정책(간격·횟수) 점검. Railway egress 한도 확인.",
        affectedFiles: ["src/lib/photoEditGemini.ts", "src/lib/mathpixV3Text.ts"],
      };
    case "empty-output":
      return {
        priority: "medium",
        area: "빈 응답",
        finding: `빈 텍스트 응답 ${count}건`,
        suggestion:
          "이미지 품질 또는 maxOutputTokens 부족 가능. thinkingBudget=0 + tokens 상향 검토.",
        affectedFiles: ["src/lib/photoEditGemini.ts"],
      };
    default:
      if (count >= 5) {
        return {
          priority: "low",
          area: `미분류 실패 (${cat})`,
          finding: `${cat} ${count}건`,
          suggestion:
            "에러 메시지 패턴을 retrospective.classifyError() 에 추가하여 향후 자동 분류.",
          affectedFiles: ["src/lib/retrospective.ts"],
        };
      }
      return null;
  }
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// ─── 마크다운 렌더러 (CLI 리포트용) ────────────────────────────────────────

export function renderRetrospectiveMarkdown(report: RetrospectiveReport): string {
  const out: string[] = [];
  const { period, summary, setup } = report;
  out.push(`# 회고 리포트 — ${period.start.slice(0, 10)} ~ ${period.end.slice(0, 10)}`);
  out.push("");
  out.push(`생성: ${report.generatedAt}`);
  out.push(`기간: 최근 ${period.days}일`);
  out.push("");
  if (!setup.supabaseConfigured) {
    out.push("> ⚠️ Supabase 미설정 — 분석 데이터 없음");
    out.push("");
  }

  out.push("## 요약");
  out.push("");
  out.push(`- 전체 실행: **${summary.totalRuns}** 건`);
  out.push(`- 성공: ${summary.successCount} (${pct(summary.successRate)})`);
  out.push(`- 실패: ${summary.failureCount}`);
  out.push(`- 평균 시도: ${summary.avgAttempts.toFixed(2)}`);
  out.push(`- 검수 완료: ${summary.reviewedCount}`);
  out.push(
    `- 평균 사용자 평점: ${summary.avgUserRating !== null ? summary.avgUserRating.toFixed(2) : "(평점 데이터 없음)"}`,
  );
  out.push(`- 낮은 평점 (≤2): ${summary.lowRatedCount}`);
  out.push("");

  if (Object.keys(report.failureCategories).length > 0) {
    out.push("## 실패 카테고리");
    out.push("");
    out.push("| 카테고리 | 건수 | 예시 |");
    out.push("|---|---:|---|");
    const sorted = Object.entries(report.failureCategories).sort(
      (a, b) => b[1].count - a[1].count,
    );
    for (const [cat, info] of sorted) {
      const ex = info.examples[0] ?? "";
      out.push(`| ${cat} | ${info.count} | ${ex.replace(/\|/g, "/")} |`);
    }
    out.push("");
  }

  if (Object.keys(report.modelPerformance).length > 0) {
    out.push("## 모델별 성능");
    out.push("");
    out.push("| 모델 | 실행 | 성공률 | 평균 시도 |");
    out.push("|---|---:|---:|---:|");
    const entries = Object.entries(report.modelPerformance).sort(
      (a, b) => b[1].runs - a[1].runs,
    );
    for (const [m, p] of entries) {
      out.push(`| ${m} | ${p.runs} | ${pct(p.successRate)} | ${p.avgAttempts.toFixed(2)} |`);
    }
    out.push("");
  }

  if (Object.keys(report.promptFormatIssues).length > 0) {
    out.push("## 프롬프트 형식 이슈");
    out.push("");
    for (const [k, v] of Object.entries(report.promptFormatIssues)) {
      out.push(`- **${k}**: ${v.count} 건`);
      for (const ex of v.examples) {
        out.push(`  - \`${ex.replace(/`/g, "")}\``);
      }
    }
    out.push("");
  }

  if (report.lowRatedRuns.length > 0) {
    out.push("## 낮은 평점 케이스");
    out.push("");
    out.push("| ID | 평점 | 문항# | 피드백 |");
    out.push("|---|---:|---|---|");
    for (const r of report.lowRatedRuns) {
      out.push(
        `| ${r.id.slice(0, 8)} | ${r.rating} | ${r.questionNo ?? "-"} | ${(r.feedback ?? "").slice(0, 80).replace(/\|/g, "/")} |`,
      );
    }
    out.push("");
  }

  out.push("## 개선 제안");
  out.push("");
  if (report.improvementSuggestions.length === 0) {
    out.push("_특별한 개선 제안 없음 — 현재 데이터 양호._");
  } else {
    for (const s of report.improvementSuggestions) {
      const icon = s.priority === "high" ? "🔴" : s.priority === "medium" ? "🟡" : "🟢";
      out.push(`### ${icon} [${s.priority.toUpperCase()}] ${s.area}`);
      out.push("");
      out.push(`**발견**: ${s.finding}`);
      out.push("");
      out.push(`**제안**: ${s.suggestion}`);
      if (s.affectedFiles && s.affectedFiles.length > 0) {
        out.push("");
        out.push(`**영향 파일**:`);
        for (const f of s.affectedFiles) {
          out.push(`- \`${f}\``);
        }
      }
      out.push("");
    }
  }

  return out.join("\n");
}
