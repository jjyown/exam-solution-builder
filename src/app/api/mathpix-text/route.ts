import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  mathpixBase64WithinLimit,
  recognizeMathpixFromImageBase64,
  type MathpixV3TextJson,
} from "@/lib/mathpixV3Text";

type Body = {
  imageBase64?: string;
  imageMimeType?: string;
  skipCache?: boolean;
};

const CACHE_SUBDIR = [".cache", "mathpix"] as const;

function cacheDir(): string {
  return path.join(process.cwd(), ...CACHE_SUBDIR);
}

function cachePathForImage(buffer: Buffer): string {
  const hash = createHash("sha256").update(buffer).digest("hex");
  return path.join(cacheDir(), `${hash}.json`);
}

type CacheFile = {
  v: 1;
  savedAt: string;
  payload: MathpixV3TextJson;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    const rawB64 = body.imageBase64?.trim() ?? "";
    const mime = body.imageMimeType?.trim() || "image/png";
    const skipCache = body.skipCache === true;

    if (!rawB64) {
      return NextResponse.json({ error: "imageBase64가 비어 있습니다." }, { status: 400 });
    }

    const normalizedB64 = rawB64.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
    if (!mathpixBase64WithinLimit(normalizedB64)) {
      return NextResponse.json(
        { error: "base64 이미지가 Mathpix 한도(약 2MB 인코딩)를 초과합니다." },
        { status: 413 },
      );
    }

    const imageBuffer = Buffer.from(normalizedB64, "base64");
    if (imageBuffer.length === 0) {
      return NextResponse.json({ error: "base64 디코딩 결과가 비었습니다." }, { status: 400 });
    }

    if (!skipCache) {
      try {
        const p = cachePathForImage(imageBuffer);
        const cached = JSON.parse(await readFile(p, "utf8")) as CacheFile;
        if (cached?.v === 1 && cached.payload && typeof cached.payload === "object") {
          return NextResponse.json({
            ok: true,
            fromCache: true,
            ...cached.payload,
          });
        }
      } catch {
        // miss
      }
    }

    const result = await recognizeMathpixFromImageBase64(normalizedB64, mime);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.message },
        { status: result.status === 501 ? 501 : 502 },
      );
    }

    if (!skipCache && result.data) {
      try {
        const dir = cacheDir();
        await mkdir(dir, { recursive: true });
        const out: CacheFile = {
          v: 1,
          savedAt: new Date().toISOString(),
          payload: result.data,
        };
        await writeFile(cachePathForImage(imageBuffer), JSON.stringify(out), "utf8");
      } catch {
        // 캐시 실패는 무시
      }
    }

    return NextResponse.json({
      ok: true,
      fromCache: false,
      ...result.data,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
