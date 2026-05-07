/**
 * POST /api/photo-edit/suggest-name
 *  body: { image: dataUrl }
 *  응답: { ok, name, model }
 */
import { NextResponse } from "next/server";
import { geminiSuggestExamName } from "@/lib/photoEditGemini";

export async function POST(req: Request) {
  let body: { image?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.image || typeof body.image !== "string") {
    return NextResponse.json({ ok: false, error: "image (data URL) is required" }, { status: 400 });
  }
  const r = await geminiSuggestExamName(body.image);
  if (!r.ok) return NextResponse.json(r, { status: 502 });
  return NextResponse.json(r);
}
