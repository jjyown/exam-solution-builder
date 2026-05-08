#!/usr/bin/env tsx
/**
 * scripts/retrospective.mts
 * ────────────────────────────────────────────────────────────────────────────
 *  누적된 auto_pipeline_runs · analysis_records 를 분석하여 개선 제안 리포트
 *  생성. 결과는 docs/retrospective/YYYY-MM-DD.md 로 저장.
 *
 *  사용:
 *    npm run retrospective              # 최근 30일
 *    npm run retrospective -- --days 7  # 최근 7일
 *    npm run retrospective -- --json    # JSON 도 같이 저장
 *
 *  주기적 실행 (옵션):
 *    GitHub Actions 또는 Railway 스케줄러로 주 1회 실행 → docs/retrospective/
 *    에 누적 → PR 자동 생성하면 코드 리뷰 흐름과 통합 가능.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { config } from "dotenv";
import { promises as fs } from "node:fs";
import path from "node:path";

// Supabase 자격증명 로드 (Railway env 또는 로컬 .env.local)
config({ path: path.join(process.cwd(), ".env.local") });
config({ path: path.join(process.cwd(), ".env") });

const {
  generateRetrospective,
  renderRetrospectiveMarkdown,
} = await import("../src/lib/retrospective.js");

type Args = {
  days: number;
  maxRows: number;
  saveJson: boolean;
};

function parseArgs(): Args {
  const args: Args = { days: 30, maxRows: 1000, saveJson: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days" && argv[i + 1]) {
      args.days = Math.max(1, Math.min(365, Number(argv[++i]) || 30));
    } else if (a === "--max" && argv[i + 1]) {
      args.maxRows = Math.max(10, Math.min(10000, Number(argv[++i]) || 1000));
    } else if (a === "--json") {
      args.saveJson = true;
    } else if (a === "-h" || a === "--help") {
      console.log(
        "Usage: npm run retrospective [-- --days N] [--max N] [--json]",
      );
      process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(
    `[retrospective] 분석 시작 — 최근 ${args.days}일, 최대 ${args.maxRows} row`,
  );

  const report = await generateRetrospective({
    days: args.days,
    maxRows: args.maxRows,
  });

  if (!report.setup.supabaseConfigured) {
    console.error(
      "[retrospective] ❌ Supabase 미설정 — SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 환경변수 필요",
    );
    process.exit(1);
  }

  const md = renderRetrospectiveMarkdown(report);
  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(process.cwd(), "docs", "retrospective");
  await fs.mkdir(outDir, { recursive: true });

  const mdPath = path.join(outDir, `${today}.md`);
  await fs.writeFile(mdPath, md, "utf8");
  console.log(`[retrospective] ✓ Markdown 저장: ${path.relative(process.cwd(), mdPath)}`);

  if (args.saveJson) {
    const jsonPath = path.join(outDir, `${today}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
    console.log(
      `[retrospective] ✓ JSON 저장: ${path.relative(process.cwd(), jsonPath)}`,
    );
  }

  // 콘솔 요약
  console.log("");
  console.log(`[retrospective] 요약:`);
  console.log(`  - 전체 실행: ${report.summary.totalRuns}`);
  console.log(
    `  - 성공률: ${(report.summary.successRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  - 개선 제안: ${report.improvementSuggestions.length} 건`,
  );
  for (const s of report.improvementSuggestions) {
    const icon =
      s.priority === "high" ? "🔴" : s.priority === "medium" ? "🟡" : "🟢";
    console.log(`    ${icon} [${s.priority}] ${s.area} — ${s.finding}`);
  }
}

main().catch((err) => {
  console.error("[retrospective] 실패:", err);
  process.exit(1);
});
