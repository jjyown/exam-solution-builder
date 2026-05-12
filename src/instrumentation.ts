/**
 * src/instrumentation.ts — Next.js 서버 startup hook.
 * Node 런타임에서만 한 번 호출. 백그라운드 스케줄러를 등록한다.
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

/**
 * 일부 환경(Railway 특정 빌드, custom server 등)에서 instrumentation 이 호출 안 되는
 * 사례가 있어 register 호출 여부를 모듈 전역 플래그로 노출.
 * 헬스체크에서 이 플래그를 보고 instrumentation 미동작을 즉시 진단할 수 있다.
 */
export let instrumentationRegistered = false;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  console.log("[instrumentation] register() 호출 — 백그라운드 스케줄러 등록 시작");

  // 1) Supabase 마이그레이션 자동 적용 (멱등) — SUPABASE_DB_URL 있을 때만
  try {
    const { runSupabaseMigrationsOnStartup } = await import("./lib/supabaseMigrations");
    await runSupabaseMigrationsOnStartup();
  } catch (e) {
    console.warn("[instrumentation] supabase migration skipped:", (e as Error).message);
  }

  // 2) Drive 분석자료 백그라운드 자동 동기화 스케줄러
  try {
    const { startDriveAnalysisAutoSync } = await import("./lib/driveAnalysisAutoSync");
    startDriveAnalysisAutoSync();
    console.log("[instrumentation] startDriveAnalysisAutoSync() 등록 완료");
  } catch (e) {
    console.error("[instrumentation] drive sync 등록 실패:", (e as Error).message);
  }

  // 3) 감독관 (retrospective) 자동 루프
  try {
    const { startSupervisorScheduler } = await import("./lib/supervisorScheduler");
    startSupervisorScheduler();
    console.log("[instrumentation] startSupervisorScheduler() 등록 완료");
  } catch (e) {
    console.error("[instrumentation] supervisor 등록 실패:", (e as Error).message);
  }

  // 3-b) 시중교재 / 시험지 원안 페이지 OCR 자동 빌더 (24h 주기)
  try {
    const { startTextbookDriveBuildAutoRun } = await import("./lib/textbookDriveBuildAutoRun");
    startTextbookDriveBuildAutoRun();
    console.log("[instrumentation] startTextbookDriveBuildAutoRun() 등록 완료");
  } catch (e) {
    console.error("[instrumentation] textbook-build-auto 등록 실패:", (e as Error).message);
  }

  // 4) 메모리 사용량 주기 로깅 — Railway 「Killed」(OOM) 진단용.
  //    부팅 직후 1회 + 60초마다 1회. 한 줄짜리 로그라 비용 무시 가능.
  //    누수 의심 시: rss/heapUsed 가 시간에 따라 우상향 → 메모리 누수.
  //    한도 의심 시: rss 가 일정 천장 근처에서 Killed → Railway 인스턴스 메모리 부족.
  try {
    const logMem = (label: string) => {
      const m = process.memoryUsage();
      const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(0)}MB`;
      const uptime = Math.round(process.uptime());
      console.log(
        `[mem] ${label} uptime=${uptime}s rss=${fmt(m.rss)} heapUsed=${fmt(m.heapUsed)} heapTotal=${fmt(m.heapTotal)} external=${fmt(m.external)} arrayBuffers=${fmt(m.arrayBuffers)}`,
      );
    };
    logMem("boot");
    setInterval(() => logMem("tick"), 60_000).unref?.();
  } catch (e) {
    console.warn("[instrumentation] memory logger 등록 실패:", (e as Error).message);
  }

  instrumentationRegistered = true;
  console.log("[instrumentation] register() 완료 — instrumentationRegistered=true");
}
