import { NextResponse } from "next/server";
import { logPromptRuleEvent, rollbackPromptRuleById } from "@/lib/supabasePromptRules";

type RollbackBody = {
  ruleId?: number;
  reason?: string;
};

export async function POST(request: Request) {
  try {
    const requiredAdminToken = process.env.PROMPT_RULES_ADMIN_TOKEN?.trim() || "";
    const providedToken = request.headers.get("x-admin-token")?.trim() || "";
    if (requiredAdminToken && providedToken !== requiredAdminToken) {
      return NextResponse.json({ error: "운영자 토큰이 올바르지 않습니다." }, { status: 401 });
    }

    const body = (await request.json()) as RollbackBody;
    const ruleId = Number(body.ruleId);
    if (!Number.isFinite(ruleId) || ruleId <= 0) {
      return NextResponse.json({ error: "유효한 ruleId가 필요합니다." }, { status: 400 });
    }

    const rolledBack = await rollbackPromptRuleById(Math.floor(ruleId));
    await logPromptRuleEvent({
      event_type: "rollback",
      rule_id: Math.floor(ruleId),
      actor: "admin-ui",
      reason: body.reason?.trim() || "manual-rollback",
      weak_explanation_hash: null,
      model: null,
      failure_details: null,
    });
    return NextResponse.json({ ok: true, rolledBack });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: `규칙 롤백 중 오류가 발생했습니다: ${message}` },
      { status: 500 },
    );
  }
}
