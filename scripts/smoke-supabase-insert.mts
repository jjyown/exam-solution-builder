/** Supabase auto_pipeline_runs INSERT 실측. */
const { config } = await import("dotenv");
const path = await import("node:path");
config({ path: path.join(process.cwd(), ".env.local") });

const { createClient } = await import("@supabase/supabase-js");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const client = createClient(url, key);

console.log("[1] count check:");
const c = await client.from("auto_pipeline_runs").select("*", { count: "exact", head: true });
console.log("  ", c.error ? `ERR: ${c.error.message}` : `count=${c.count}`);

console.log("[2] insert test:");
const i = await client
  .from("auto_pipeline_runs")
  .insert({
    exam_name: "smoke-direct",
    question_no: "1",
    question_text: "테스트 문제",
    model: "gemini",
    top_k: 3,
    max_retries: 2,
    ok: false,
    attempts: 0,
    parsed: null,
    trace: [],
    errors: ["smoke"],
    manual_review_checklist: [],
  })
  .select("id")
  .single();
console.log("  ", i.error ? `ERR: ${i.error.message}` : `inserted id=${i.data?.id}`);
