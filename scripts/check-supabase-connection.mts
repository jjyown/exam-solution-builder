/**
 * .env.local 의 Supabase URL + service_role 로 테이블 읽기 권한 확인
 *   npm run check-supabase
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import path from "node:path";

config({ path: path.join(process.cwd(), ".env.local") });
config({ path: path.join(process.cwd(), ".env") });

const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
  process.env.SUPABASE_URL?.trim() ||
  "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";

if (!url || !key) {
  console.error("환경변수가 없습니다. .env.local 에 다음을 넣으세요:");
  console.error("  NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_URL");
  console.error("  SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const masked = `${url.replace(/^https:\/\//, "").slice(0, 24)}…`;
console.log(`URL(일부): ${masked}`);
console.log(`SERVICE_ROLE: ${key.slice(0, 12)}… (길이 ${key.length})`);

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const tables = ["exam_solutions", "explanation_reviews"] as const;

async function main() {
  let ok = 0;
  for (const t of tables) {
    const { error } = await sb.from(t).select("*").limit(1);
    if (error) {
      console.error(`[${t}] 실패: ${error.message}`);
    } else {
      console.log(`[${t}] OK — SELECT 허용`);
      ok += 1;
    }
  }
  if (ok === 0) {
    console.error("\n두 테이블 모두 실패면: supabase/*.sql DDL 실행 여부·프로젝트 URL·service_role 키를 확인하세요.");
    process.exit(1);
  }
  console.log("\n연결 확인 완료.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
