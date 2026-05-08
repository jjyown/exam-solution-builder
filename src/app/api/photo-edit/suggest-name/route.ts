/**
 * POST /api/photo-edit/suggest-name
 *  body: { image: dataUrl, focusImage?: dataUrl }
 *  - image       : 시험지 전체(또는 잘라낸 페이퍼) — 연도·지역·학기 등 컨텍스트
 *  - focusImage  : 사용자가 표시한 학교명 영역 확대 크롭 (선택) — 정확한 텍스트
 *  응답: { ok, name, model }
 */
import { NextResponse } from "next/server";
import { geminiSuggestExamName } from "@/lib/photoEditGemini";

export async function POST(req: Request) {
  let body: { image?: string; focusImage?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.image || typeof body.image !== "string") {
    return NextResponse.json({ ok: false, error: "image (data URL) is required" }, { status: 400 });
  }
  const focusImage =
    typeof body.focusImage === "string" && body.focusImage ? body.focusImage : undefined;
  const r = await geminiSuggestExamName(body.image, focusImage);
  if (!r.ok) return NextResponse.json(r, { status: 502 });
  return NextResponse.json(r);
}
