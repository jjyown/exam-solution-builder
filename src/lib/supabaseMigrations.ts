/**
 * supabaseMigrations.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  서버 startup 시 supabase/*.sql 파일을 모두 자동 실행한다.
 *
 *  기존 SQL 파일들은 모두 `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
 *  EXISTS`, `CREATE EXTENSION IF NOT EXISTS` 형태로 멱등하게 작성되어 있어
 *  매번 실행해도 안전하다. 새 SQL 파일을 supabase/ 에 추가하면 다음 배포
 *  때 자동으로 적용된다 — 운영자가 Supabase Dashboard 에서 수동 실행할
 *  필요 없음.
 *
 *  ▷ 동작 조건
 *      - SUPABASE_DB_URL 환경변수 (Postgres connection string) 필요.
 *        Supabase Dashboard → Settings → Database → Connection string 에서 복사.
 *        없으면 silent skip — 기존처럼 운영자가 수동 실행해도 동작.
 *
 *  ▷ 동작
 *      1. supabase/ 폴더의 모든 .sql 파일 읽기 (이름순)
 *      2. pg Pool 로 Supabase Postgres 에 직접 연결
 *      3. 각 파일을 한 번의 query 로 실행 (transaction 보호)
 *      4. 결과 콘솔 로그 (성공/실패 파일명)
 *      5. 실패해도 startup 안 막음 (best-effort)
 * ────────────────────────────────────────────────────────────────────────────
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

let migrationsRan = false;

export async function runSupabaseMigrationsOnStartup(): Promise<void> {
  if (migrationsRan) return;
  migrationsRan = true;

  const dbUrl = process.env.SUPABASE_DB_URL?.trim();
  if (!dbUrl) {
    // 환경변수 없으면 운영자가 수동 실행하는 옛 흐름 그대로
    return;
  }

  // supabase/ 폴더 위치: 빌드 시 process.cwd() 가 프로젝트 루트
  const dir = path.join(process.cwd(), "supabase");
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    // supabase/ 폴더 없으면 그냥 종료
    return;
  }
  if (files.length === 0) return;

  // Supabase 는 SSL 강제. ssl: { rejectUnauthorized: false } 가 호환성 안전
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    max: 1, // startup 한 번 쓸 거라 minimal
    idleTimeoutMillis: 5_000,
  });

  const summary: Array<{ file: string; ok: boolean; error?: string }> = [];
  try {
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), "utf-8");
      try {
        await pool.query(sql);
        summary.push({ file, ok: true });
      } catch (e) {
        summary.push({ file, ok: false, error: (e as Error).message });
      }
    }
  } finally {
    try {
      await pool.end();
    } catch {
      // ignore
    }
  }

  const failed = summary.filter((s) => !s.ok);
  if (failed.length > 0) {
    // 실패 파일만 로그 — 운영자가 logs 에서 발견 가능
    // (CREATE IF NOT EXISTS 인데 실패하면 권한 문제 가능성)
    // eslint-disable-next-line no-console
    console.warn(
      `[supabase-migrations] ${failed.length}/${summary.length} 실패:`,
      failed.map((f) => `${f.file} (${f.error?.slice(0, 120)})`).join(" | "),
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`[supabase-migrations] ${summary.length}/${summary.length} 적용 완료`);
  }
}
