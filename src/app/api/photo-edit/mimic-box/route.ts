/**
 * POST /api/photo-edit/mimic-box
 *  body: { referenceImage, referenceBox, targetImage }
 *  응답: { ok, box: { nx, ny, nw, nh, confidence }, model }
 */
import { NextResponse } from "next/server";
import { geminiMimicCropBox } from "@/lib/photoEditGemini";

export async function POST(req: Request) {
  let body: {
    referenceImage?: string;
    referenceBox?: { nx?: number; ny?: number; nw?: number; nh?: number };
    targetImage?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.referenceImage || !body.targetImage || !body.referenceBox) {
    return NextResponse.json(
      { ok: false, error: "referenceImage, referenceBox, targetImage 모두 필요합니다." },
      { status: 400 },
    );
  }
  const ref = body.referenceBox;
  const refBox = {
    nx: Number(ref.nx),
    ny: Number(ref.ny),
    nw: Number(ref.nw),
    nh: Number(ref.nh),
  };
  if (![refBox.nx, refBox.ny, refBox.nw, refBox.nh].every((v) => Number.isFinite(v))) {
    return NextResponse.json({ ok: false, error: "referenceBox 좌표 오류" }, { status: 400 });
  }
  const r = await geminiMimicCropBox(body.referenceImage, refBox, body.targetImage);
  if (!r.ok) return NextResponse.json(r, { status: 502 });
  return NextResponse.json(r);
}
