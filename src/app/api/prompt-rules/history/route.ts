import { NextResponse } from "next/server";
import { listPromptRuleVersions } from "@/lib/supabasePromptRules";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Number.parseInt(searchParams.get("limit") || "20", 10);
    const versions = await listPromptRuleVersions(limit);
    return NextResponse.json({ ok: true, versions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: `규칙 이력 조회 중 오류가 발생했습니다: ${message}` },
      { status: 500 },
    );
  }
}
