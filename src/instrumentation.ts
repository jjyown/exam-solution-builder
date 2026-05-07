/**
 * src/instrumentation.ts — Next.js 서버 startup hook.
 * Node 런타임에서만 한 번 호출. 백그라운드 스케줄러를 등록한다.
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startDriveAnalysisAutoSync } = await import("./lib/driveAnalysisAutoSync");
  startDriveAnalysisAutoSync();
}
