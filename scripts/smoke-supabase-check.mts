/**
 * Supabase 연결 + auto_pipeline_runs 테이블 존재 여부 확인.
 */
const { config } = await import("dotenv");
const path = await import("node:path");
config({ path: path.join(process.cwd(), ".env.local") });

const { createClient } = await import("@supabase/supabase-js");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) {
  console.log("✗ Supabase env not set");
  process.exit(1);
}
console.log(`Supabase URL: ${url}`);
const client = createClient(url, key);

// 실제 INSERT 시도로 schema cache까지 확인 (count는 false-positive 가능)
const probeInsert = await client
  .from("auto_pipeline_runs")
  .insert({
    exam_name: "_probe",
    question_text: "schema-probe",
    model: "probe",
    top_k: 0,
    max_retries: 0,
    ok: false,
    attempts: 0,
  })
  .select("id")
  .single();

if (probeInsert.error) {
  console.log(`✗ auto_pipeline_runs 테이블 사용 불가: ${probeInsert.error.message}`);
  console.log("   → Supabase Dashboard → SQL Editor 에서 다음 파일을 실행하세요:");
  console.log("     supabase/auto_pipeline_runs.sql");
  process.exit(2);
}
console.log(`✓ auto_pipeline_runs 테이블 사용 가능 (probe id ${probeInsert.data?.id})`);
// probe row 정리
await client.from("auto_pipeline_runs").delete().eq("id", probeInsert.data!.id);

// 가장 최근 행 1개 보여주기
const { data: latest } = await client
  .from("auto_pipeline_runs")
  .select("id, created_at, exam_name, question_no, ok, attempts, user_rating")
  .order("created_at", { ascending: false })
  .limit(1);
if (latest && latest.length > 0) {
  console.log("최근 행:", JSON.stringify(latest[0], null, 2));
} else {
  console.log("(아직 행 없음)");
}
