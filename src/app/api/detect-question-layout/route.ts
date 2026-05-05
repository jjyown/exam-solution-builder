import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { isGeminiRateLimitedMessage } from "@/lib/geminiRateLimit";
import { DEFAULT_GEMINI_COST_MODELS } from "@/lib/geminiDefaultModels";

export const runtime = "nodejs";
export const maxDuration = 120;

type NormRect = { x: number; y: number; w: number; h: number };

type DetectItem = {
  printedNo: number;
  stem: NormRect;
  diagrams: NormRect[];
};

type RequestBody = {
  imageBase64?: string;
  imageMimeType?: string;
  /** 비우면 페이지에 보이는 전체 문항 */
  questionNumbers?: number[] | null;
};

function parseModelCandidatesFromEnv(envKey: string, fallback: string[]) {
  const normalize = (models: string[]) =>
    Array.from(
      new Set(
        models
          .map((item) => item.trim())
          .filter(Boolean)
          .filter((name) => !/^gemini-1\.5-(pro|flash)$/i.test(name)),
      ),
    );

  const raw = process.env[envKey]?.trim();
  if (!raw) {
    const normalizedFallback = normalize(fallback);
    return normalizedFallback.length > 0 ? normalizedFallback : [...DEFAULT_GEMINI_COST_MODELS];
  }
  const parsed = normalize(raw.split(","));
  if (parsed.length > 0) return parsed;
  const normalizedFallback = normalize(fallback);
  return normalizedFallback.length > 0 ? normalizedFallback : [...DEFAULT_GEMINI_COST_MODELS];
}

const DETECT_MODEL_CANDIDATES = parseModelCandidatesFromEnv("GEMINI_MODELS_QUESTION_DETECT", [
  ...DEFAULT_GEMINI_COST_MODELS,
]);

function stripCodeFence(raw: string) {
  const t = raw.trim();
  if (!t.startsWith("```")) return t;
  return t
    .replace(/^```[a-zA-Z0-9_-]*\s*/m, "")
    .replace(/\s*```$/m, "")
    .trim();
}

function extractJsonObject(raw: string): string | null {
  const cleaned = stripCodeFence(raw);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || first >= last) return null;
  return cleaned.slice(first, last + 1);
}

function asFinite01(n: unknown): number | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

function parseNormRect(input: unknown): NormRect | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const x = asFinite01(o.x);
  const y = asFinite01(o.y);
  const w = asFinite01(o.w ?? o.width);
  const h = asFinite01(o.h ?? o.height);
  if (x === null || y === null || w === null || h === null) return null;
  if (w < 0.02 || h < 0.02) return null;
  if (x + w > 1.001 || y + h > 1.001) return null;
  return {
    x: Math.max(0, Math.min(1 - w, x)),
    y: Math.max(0, Math.min(1 - h, y)),
    w: Math.max(0.02, Math.min(1, w)),
    h: Math.max(0.02, Math.min(1, h)),
  };
}

function normalizePayload(payload: unknown, filter: Set<number> | null): { items: DetectItem[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!payload || typeof payload !== "object") {
    warnings.push("모델 응답이 객체가 아닙니다.");
    return { items: [], warnings };
  }
  const root = payload as Record<string, unknown>;
  const rawItems = Array.isArray(root.items) ? root.items : [];
  const items: DetectItem[] = [];

  for (const entry of rawItems) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const noRaw = e.printedNo ?? e.no ?? e.questionNo ?? e.n;
    const printedNo =
      typeof noRaw === "number" && Number.isFinite(noRaw) ? Math.floor(noRaw)
      : typeof noRaw === "string" && /^\d+$/.test(noRaw.trim()) ? Number.parseInt(noRaw.trim(), 10)
      : NaN;
    if (!Number.isFinite(printedNo) || printedNo < 1) continue;
    if (filter && !filter.has(printedNo)) continue;

    const stem = parseNormRect(e.stem ?? e.problem ?? e.body);
    if (!stem) {
      warnings.push(`문항 ${printedNo}: stem 박스를 해석하지 못했습니다.`);
      continue;
    }
    const diagrams: NormRect[] = [];
    const dRaw = e.diagrams ?? e.figures ?? e.graphs;
    if (Array.isArray(dRaw)) {
      for (const d of dRaw) {
        const dr = parseNormRect(d);
        if (dr) diagrams.push(dr);
      }
    }
    items.push({ printedNo, stem, diagrams });
  }

  items.sort((a, b) => {
    if (Math.abs(a.stem.y - b.stem.y) > 0.02) return a.stem.y - b.stem.y;
    return a.stem.x - b.stem.x;
  });

  return { items, warnings };
}

export async function POST(request: Request) {
  try {
    const apiKey =
      process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY(또는 GOOGLE_API_KEY)가 설정되지 않았습니다." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as RequestBody;
    const imageBase64 = body.imageBase64?.trim();
    const imageMimeType = body.imageMimeType?.trim() || "image/png";
    const nums = Array.isArray(body.questionNumbers) ? body.questionNumbers : null;
    const filter =
      nums && nums.length > 0 ? new Set(nums.filter((n) => typeof n === "number" && n > 0)) : null;

    if (!imageBase64) {
      return NextResponse.json({ error: "imageBase64가 비어 있습니다." }, { status: 400 });
    }

    const cleanB64 = imageBase64.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
    if (cleanB64.length < 80) {
      return NextResponse.json({ error: "이미지 데이터가 너무 짧습니다." }, { status: 400 });
    }

    const filterHint =
      filter && filter.size > 0
        ? `반드시 다음 인쇄 문항 번호만 출력한다: ${[...filter].sort((a, b) => a - b).join(", ")}. 다른 번호는 포함하지 마라.`
        : "페이지에 인쇄된 모든 문항 번호를 읽는 순서(위→아래, 같은 높이면 왼→오른)로 출력한다.";

    const prompt = [
      "너는 한국 수능·모의고사 형태의 시험지 한 페이지 이미지를 분석하는 레이아웃 검출기다.",
      "각 문항에 대해:",
      "- printedNo: 인쇄된 문항 번호(정수).",
      "- stem: 본문·조건·객관식 보기까지 포함하는 하나의 직사각형. 좌표는 이미지 전체에 대한 비율(0~1)이다: x,y는 좌상단, w,h는 너비·높이.",
      "- diagrams: 같은 문항에 속하는 그래프·도형·표(문항 전용 그림)가 stem과 분리되어 있으면 별도 박스 배열로 넣는다. 없으면 빈 배열.",
      "주의:",
      "- stem과 diagrams는 서로 겹치지 않게 최대한 나눈다. 그림이 본문 바로 아래에 붙어 있으면 stem에 포함하고 diagrams는 비워도 된다.",
      "- 이웃 문항의 그림을 가져오지 마라.",
      "- 좌표는 반드시 0 이상 1 이하, w,h는 최소 약 0.02 이상.",
      filterHint,
      '반드시 JSON 하나만 출력한다. 형식: {"items":[{"printedNo":1,"stem":{"x":0.1,"y":0.05,"w":0.35,"h":0.12},"diagrams":[]}]}',
    ].join("\n");

    const client = new GoogleGenerativeAI(apiKey);
    const failures: string[] = [];
    let lastText = "";

    for (const modelName of DETECT_MODEL_CANDIDATES) {
      try {
        const model = client.getGenerativeModel({ model: modelName });
        const result = await model.generateContent([
          { text: prompt },
          {
            inlineData: {
              mimeType: imageMimeType.includes("/") ? imageMimeType : "image/png",
              data: cleanB64,
            },
          },
        ]);
        lastText = result.response.text().trim();
        const jsonStr = extractJsonObject(lastText);
        if (!jsonStr) {
          failures.push(`${modelName}: JSON 추출 실패`);
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonStr) as unknown;
        } catch {
          failures.push(`${modelName}: JSON 파싱 실패`);
          continue;
        }
        const { items, warnings } = normalizePayload(parsed, filter);
        if (items.length === 0) {
          failures.push(`${modelName}: items 비어 있음`);
          continue;
        }
        const missing: number[] = [];
        if (filter) {
          for (const n of filter) {
            if (!items.some((it) => it.printedNo === n)) missing.push(n);
          }
          if (missing.length > 0) {
            warnings.push(`요청했으나 찾지 못한 번호: ${missing.join(", ")}`);
          }
        }
        return NextResponse.json({
          ok: true,
          items,
          warnings,
          model: modelName,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`${modelName}: ${msg.slice(0, 200)}`);
        if (isGeminiRateLimitedMessage(msg)) {
          await new Promise((r) => setTimeout(r, 900));
        }
      }
    }

    return NextResponse.json(
      {
        error: "문항 레이아웃 검출에 실패했습니다.",
        details: failures,
        rawPreview: lastText.slice(0, 400),
      },
      { status: 502 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
