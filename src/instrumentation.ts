/**
 * src/instrumentation.ts — Next.js 서버 startup hook.
 * Node 런타임에서만 한 번 호출. 백그라운드 스케줄러를 등록한다.
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 1) Supabase 마이그레이션 자동 적용 (멱등) — SUPABASE_DB_URL 있을 때만
  try {
    const { runSupabaseMigrationsOnStartup } = await import("./lib/supabaseMigrations");
    await runSupabaseMigrationsOnStartup();
  } catch {
    // best-effort — 실패해도 서버는 정상 기동
  }

  // 2) Drive 분석자료 백그라운드 자동 동기화 스케줄러
  const { startDriveAnalysisAutoSync } = await import("./lib/driveAnalysisAutoSync");
  startDriveAnalysisAutoSync();
}
