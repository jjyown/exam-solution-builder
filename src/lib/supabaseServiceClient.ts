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
 * URL 이 createClient 가 받아들일 수 있는 형식인지 미리 확인.
 *  - https://*.supabase.co (또는 임의 https) 만 허용
 *  - 상대경로·잘못된 스킴·공백·한글 등은 거름
 *  - 불일치 시 null — 호출부는 「미설정」 처럼 처리하면 됨
 */
function safeUrl(raw: string | undefined): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * 서버 전용(service_role). 클라이언트 번들에 포함하지 말 것.
 * @returns URL·키가 없거나 URL 형식이 잘못되면 null (절대 throw 하지 않음)
 */
export function getSupabaseServiceClient(): SupabaseClient | null {
  loadLocalEnv();
  const url = safeUrl(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
  );
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!url || !key) return null;
  try {
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return null;
  }
}

/**
 * Academy Manager (학원 관리) 별도 Supabase 프로젝트 클라이언트.
 *  - 시험지 해설 제작 ↔ academy_manager 는 다른 Supabase 인스턴스이므로
 *    cross-app 비용 통계를 보려면 ACADEMY env 별도 추가 필요.
 *  - 누락·형식오류 시 null — UI 에서 「academy 통계 미연결」 으로 표시.
 *  - **절대 throw 하지 않음** — 잘못된 ACADEMY_SUPABASE_URL 이 cost-tracker
 *    같은 무관한 라우트를 500 으로 만들지 않게.
 *
 *  env: ACADEMY_SUPABASE_URL + ACADEMY_SUPABASE_SERVICE_ROLE_KEY
 */
export function getAcademySupabaseClient(): SupabaseClient | null {
  loadLocalEnv();
  const url = safeUrl(process.env.ACADEMY_SUPABASE_URL);
  const key = process.env.ACADEMY_SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!url || !key) return null;
  try {
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return null;
  }
}
