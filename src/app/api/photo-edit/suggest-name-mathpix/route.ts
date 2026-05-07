/**
 * POST /api/photo-edit/suggest-name-mathpix
 *  body: { image: dataUrl }
 *  응답: { ok, name, raw }
 *
 *  Mathpix OCR 로 텍스트 추출 → 정규식으로 학교명·연도·지역·학년·학기·시험 종류 파싱.
 *  Gemini 학교명 (1~2초) 보다 살짝 빠르고, OCR 정확도가 높아 텍스트가 깔끔.
 *  Gemini 가 가끔 잘리는 현상 없음 — 단점은 "추측" 이 안 되어 헤더에 정보 부족하면
 *  결과도 부족 (사용자 직접 보정 전제로 충분).
 *
 *  Mathpix 비용: 페이지당 ~$0.004 (헤더 영역만 잘라 보내면 적당).
 * ────────────────────────────────────────────────────────────────────────────
 */
import { NextResponse } from "next/server";
import {
  recognizeMathpixFromImageBase64,
  resolveMathpixCredentials,
} from "@/lib/mathpixV3Text";

function parseDataUrl(d: string): { mime: string; base64: string } | null {
  const m = d.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!m) return null;
  return { mime: m[1], base64: m[2] };
}

/** OCR 텍스트 → 한 줄 형식: "[중|고]n) YYYY 지역 학교명 [과목] N학년 M학기 [중간|기말]고사" */
function parseExamHeader(text: string): string {
  const t = text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();

  // 학교 — 「○○중학교」 / 「○○고등학교」
  const schoolMatch =
    t.match(/([가-힣]{2,8}(?:중학교|고등학교))/) || t.match(/([가-힣]{2,8})\s*(중|고)/);
  const school = schoolMatch ? schoolMatch[0].replace(/\s+/g, "") : "";
  const isHigh = /고등학교|고\b/.test(school);
  const isMid = /중학교|중\b/.test(school);

  // 연도 — 2025, 2025학년도, '25학년도
  let year = "";
  const yearM =
    t.match(/\b(20\d{2})\s*학년도?/) ||
    t.match(/\b(20\d{2})\s*년/) ||
    t.match(/['']\s*(\d{2})\s*학년도/);
  if (yearM) {
    const v = yearM[1];
    year = v.length === 2 ? (Number(v) >= 70 ? `19${v}` : `20${v}`) : v;
  }

  // 지역 — 「ㅇㅇ시」 / 「ㅇㅇ군」 / 「ㅇㅇ구」 (괄호 안 우선)
  let region = "";
  const inParen = t.match(/\(([^)]{1,40})\)/);
  if (inParen) {
    const r = inParen[1].match(/([가-힣]+(?:시|군|구))/);
    if (r) region = r[1];
  }
  if (!region) {
    const r = t.match(/([가-힣]+(?:시|군|구))/);
    if (r) region = r[1];
  }

  // 학년·학기 — "2-1", "2학년 1학기"
  let grade = "";
  let semester = "";
  const dashM = t.match(/\b([1-3])\s*[-~/]\s*([1-2])\b/);
  if (dashM) {
    grade = dashM[1];
    semester = dashM[2];
  } else {
    const longM = t.match(/([1-3])\s*학년\s*([1-2])\s*학기/);
    if (longM) {
      grade = longM[1];
      semester = longM[2];
    } else {
      const gm = t.match(/([1-3])\s*학년/);
      if (gm) grade = gm[1];
      const sm = t.match(/([1-2])\s*학기/);
      if (sm) semester = sm[1];
    }
  }

  // 시험 종류 — 중간 / 기말
  let examKind = "";
  if (/기말/.test(t)) examKind = "기말고사";
  else if (/중간/.test(t)) examKind = "중간고사";

  // 과목 (고등학교만, 보이는 경우만)
  let subject = "";
  if (isHigh) {
    const subM = t.match(
      /(확률과\s*통계|미분과\s*적분|미적분\s*[12]|미적분|수학\s*[12]|수학[IⅡ]+|기하|대수)/,
    );
    if (subM) {
      subject = subM[1]
        .replace(/\s+/g, "")
        .replace(/수학II/i, "수학2")
        .replace(/수학I/i, "수학1");
    }
  }

  // 조립
  const parts: string[] = [];
  const prefix = isHigh ? `고${grade || "?"})` : isMid ? `중${grade || "?"})` : "";
  if (prefix) parts.push(prefix);
  if (year) parts.push(year);
  if (region) parts.push(region);
  if (school) parts.push(school);
  if (subject) parts.push(subject);
  if (grade && semester) parts.push(`${grade}학년 ${semester}학기`);
  else if (grade) parts.push(`${grade}학년`);
  if (examKind) parts.push(examKind);

  return parts.join(" ").trim();
}

export async function POST(req: Request) {
  let body: { image?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.image) {
    return NextResponse.json(
      { ok: false, error: "image (data URL) is required" },
      { status: 400 },
    );
  }
  if (!resolveMathpixCredentials()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "MATHPIX_APP_ID / MATHPIX_APP_KEY 미설정 — Railway Variables 에 등록 후 사용하세요.",
      },
      { status: 503 },
    );
  }

  const parsed = parseDataUrl(body.image);
  if (!parsed) {
    return NextResponse.json({ ok: false, error: "이미지 형식 오류" }, { status: 400 });
  }

  const r = await recognizeMathpixFromImageBase64(parsed.base64, parsed.mime);
  if (!r.ok) {
    return NextResponse.json(
      { ok: false, error: r.message },
      { status: r.status >= 500 ? 502 : r.status },
    );
  }
  const rawText = r.data.text || "";
  const formatted = parseExamHeader(rawText);
  if (!formatted || formatted.length < 4) {
    return NextResponse.json(
      {
        ok: true,
        name: rawText.split("\n")[0]?.trim().slice(0, 200) || "",
        raw: rawText.slice(0, 400),
        warning: "헤더 파싱 결과가 짧습니다 — Mathpix OCR 텍스트 첫 줄을 그대로 반환.",
      },
    );
  }
  return NextResponse.json({ ok: true, name: formatted, raw: rawText.slice(0, 400) });
}
