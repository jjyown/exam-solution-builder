import { createClient } from "@supabase/supabase-js";
import type { RuntimePromptRules } from "@/app/api/generate-explanation/prompts";

type PromptRulesRow = {
  id?: number;
  is_active: boolean;
  extra_constraints: string | null;
  examples_easy: string | null;
  examples_balanced: string | null;
  examples_killer: string | null;
  updated_at: string;
};

type PromptRuleEventRow = {
  event_type: "apply" | "rollback";
  rule_id: number | null;
  actor: string | null;
  reason: string | null;
  weak_explanation_hash: string | null;
  model: string | null;
  failure_details: string | null;
  created_at: string;
};

export type PromptRuleVersionItem = {
  id: number;
  is_active: boolean;
  updated_at: string;
  extra_constraints_preview: string;
};

function isMissingTableError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: string }).code || "") : "";
  return code === "42P01";
}

function isMissingRpcError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: string }).code || "") : "";
  return code === "42883";
}

function toPreview(text: string | null, max = 90) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

function createSupabaseAdminClient() {
  const cfg = getSupabaseConfig();
  if (!cfg) return null;
  return createClient(cfg.url, cfg.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function getRuntimePromptRules(): Promise<RuntimePromptRules | null> {
  const client = createSupabaseAdminClient();
  if (!client) return null;

  const { data, error } = await client
    .from("prompt_rules")
    .select("is_active,extra_constraints,examples_easy,examples_balanced,examples_killer,updated_at")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<PromptRulesRow>();

  if (error || !data) return null;
  return {
    extraConstraints: data.extra_constraints || undefined,
    examplesEasy: data.examples_easy || undefined,
    examplesBalanced: data.examples_balanced || undefined,
    examplesKiller: data.examples_killer || undefined,
  };
}

export async function applyRuntimePromptRules(rules: RuntimePromptRules) {
  const client = createSupabaseAdminClient();
  if (!client) {
    throw new Error("SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.");
  }

  const payload: PromptRulesRow = {
    is_active: true,
    extra_constraints: rules.extraConstraints?.trim() || null,
    examples_easy: rules.examplesEasy?.trim() || null,
    examples_balanced: rules.examplesBalanced?.trim() || null,
    examples_killer: rules.examplesKiller?.trim() || null,
    updated_at: new Date().toISOString(),
  };

  const { data: rpcData, error: rpcError } = await client.rpc("apply_prompt_rules", {
    p_extra_constraints: payload.extra_constraints,
    p_examples_easy: payload.examples_easy,
    p_examples_balanced: payload.examples_balanced,
    p_examples_killer: payload.examples_killer,
  });
  if (!rpcError && rpcData && Array.isArray(rpcData) && rpcData.length > 0) {
    return rpcData[0];
  }
  if (rpcError && !isMissingRpcError(rpcError)) {
    throw new Error(`규칙 적용 RPC 실패: ${rpcError.message}`);
  }

  const { data, error } = await client
    .from("prompt_rules")
    .insert(payload)
    .select("id,updated_at")
    .single();
  if (error) {
    throw new Error(`새 규칙 저장 실패: ${error.message}`);
  }

  const createdId = data?.id;
  if (typeof createdId !== "number") {
    throw new Error("새 규칙 ID를 확인하지 못했습니다.");
  }

  const { error: disableOldError } = await client
    .from("prompt_rules")
    .update({ is_active: false })
    .eq("is_active", true)
    .neq("id", createdId);
  if (disableOldError) {
    throw new Error(`기존 활성 규칙 정리 실패: ${disableOldError.message}`);
  }
  return data;
}

export async function listPromptRuleVersions(limit = 20): Promise<PromptRuleVersionItem[]> {
  const client = createSupabaseAdminClient();
  if (!client) return [];
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 20;
  const { data, error } = await client
    .from("prompt_rules")
    .select("id,is_active,updated_at,extra_constraints")
    .order("updated_at", { ascending: false })
    .limit(safeLimit);
  if (error || !Array.isArray(data)) return [];
  return data
    .filter((item) => typeof item.id === "number")
    .map((item) => ({
      id: Number(item.id),
      is_active: Boolean(item.is_active),
      updated_at: String(item.updated_at || ""),
      extra_constraints_preview: toPreview(
        typeof item.extra_constraints === "string" ? item.extra_constraints : null,
      ),
    }));
}

export async function rollbackPromptRuleById(ruleId: number) {
  const client = createSupabaseAdminClient();
  if (!client) {
    throw new Error("SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 설정되지 않았습니다.");
  }

  const { data: target, error: targetError } = await client
    .from("prompt_rules")
    .select("id")
    .eq("id", ruleId)
    .single();
  if (targetError || !target || typeof target.id !== "number") {
    throw new Error("롤백 대상 규칙을 찾지 못했습니다.");
  }

  const { error: activateError } = await client
    .from("prompt_rules")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", ruleId);
  if (activateError) {
    throw new Error(`롤백 대상 활성화 실패: ${activateError.message}`);
  }

  const { error: disableOldError } = await client
    .from("prompt_rules")
    .update({ is_active: false })
    .eq("is_active", true)
    .neq("id", ruleId);
  if (disableOldError) {
    throw new Error(`기존 활성 규칙 정리 실패: ${disableOldError.message}`);
  }

  return { id: ruleId, updated_at: new Date().toISOString() };
}

export async function logPromptRuleEvent(event: Omit<PromptRuleEventRow, "created_at">) {
  const client = createSupabaseAdminClient();
  if (!client) return;
  const payload: PromptRuleEventRow = {
    ...event,
    created_at: new Date().toISOString(),
  };
  const { error } = await client.from("prompt_rule_events").insert(payload);
  if (error && !isMissingTableError(error)) {
    throw new Error(`규칙 이벤트 로그 저장 실패: ${error.message}`);
  }
}
