/**
 * GET /api/retrospective
 * ────────────────────────────────────────────────────────────────────────────
 *  누적된 실행 데이터를 분석해 코드·프롬프트 개선 제안 리포트 반환.
 *
 *  Query:
 *    ?days=30           — 분석 기간 (기본 30일)
 *    ?max=1000          — 최대 row 수 (기본 1000)
 *    ?format=md         — markdown 으로 반환 (기본 json)
 *
 *  사용 예:
 *    curl https://exam-solution-builder.../api/retrospective
 *    curl https://exam-solution-builder.../api/retrospective?days=7
 *    curl https://exam-solution-builder.../api/retrospective?format=md > report.md
 */
import { NextResponse } from "next/server";
import {
  generateRetrospective,
  renderRetrospectiveMarkdown,
} from "@/lib/retrospective";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = clampInt(url.searchParams.get("days"), 30, 1, 365);
  const max = clampInt(url.searchParams.get("max"), 1000, 10, 10000);
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();

  const report = await generateRetrospective({ days, maxRows: max });

  if (format === "md" || format === "markdown") {
    const md = renderRetrospectiveMarkdown(report);
    return new NextResponse(md, {
      status: 200,
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
  return NextResponse.json({ ok: true, report });
}

function clampInt(
  v: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
