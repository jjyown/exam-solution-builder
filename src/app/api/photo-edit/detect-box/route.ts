/**
 * POST /api/photo-edit/detect-box
 *  body: { image: dataUrl }
 *  응답: { ok, box: { nx, ny, nw, nh, confidence }, model }
 */
import { NextResponse } from "next/server";
import { geminiDetectProblemBox } from "@/lib/photoEditGemini";
import { logApiCall } from "@/lib/apiCallLogger";

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
  const r = await geminiDetectProblemBox(body.image);
  void logApiCall({
    route: "/api/photo-edit/detect-box",
    purpose: "사진 편집기 — 문제 박스 자동감지",
    vendor: "gemini",
    model: (r.ok && r.model) || "gemini-2.5-flash-lite",
    ok: r.ok,
  });
  if (!r.ok) return NextResponse.json(r, { status: 502 });
  return NextResponse.json(r);
}
