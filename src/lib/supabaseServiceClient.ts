import { config } from "dotenv";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let dotenvLoaded = false;

/** Next `next dev` 가 부팅 시점에만 env를 읽는 경우가 있어, API 라우트에서 .env.local 을 한 번 더 로드한다. */
function loadLocalEnv() {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const root = process.cwd();
  config({ path: path.join(root, ".env.local") });
  config({ path: path.join(root, ".env") });
}

/**
 * 서버 전용(service_role). 클라이언트 번들에 포함하지 말 것.
 * @returns URL·키가 없으면 null
 */
export function getSupabaseServiceClient(): SupabaseClient | null {
  loadLocalEnv();
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    process.env.SUPABASE_URL?.trim() ||
    "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Academy Manager (학원 관리) 별도 Supabase 프로젝트 클라이언트.
 *  - 시험지 해설 제작 ↔ academy_manager 는 다른 Supabase 인스턴스이므로
 *    cross-app 비용 통계를 보려면 ACADEMY env 별도 추가 필요.
 *  - 누락 시 null — UI 에서 「academy 통계 미연결」 으로 표시.
 *
 *  env: ACADEMY_SUPABASE_URL + ACADEMY_SUPABASE_SERVICE_ROLE_KEY
 */
export function getAcademySupabaseClient(): SupabaseClient | null {
  loadLocalEnv();
  const url = process.env.ACADEMY_SUPABASE_URL?.trim() || "";
  const key = process.env.ACADEMY_SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
