/**
 * photoEditGemini.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  「사진 편집기」(별도 로컬 앱) 의 Gemini 호출 3종을 highroad-math-solution 으로 포팅.
 *  - detectProblemBox: 시험지 인쇄 영역만 자동으로 잡는 정규화 박스
 *  - mimicCropBox    : 한 페이지 박스 → 다른 페이지에 같은 의도로 박스 복제
 *  - suggestExamName : 헤더에서 학교/연도/지역/과목/학년·학기를 형식 맞춰 한 줄 추출
 *  프롬프트는 사진 편집기 server.js 에서 검증된 그대로 가져옴.
 *
 *  공통:
 *   - GEMINI_OCR_DISABLED=true 킬스위치 적용 (비용 보호)
 *   - 모델: gemini-2.5-flash-lite 우선 + 폴백
 *   - 응답: { ok, ... } 또는 { ok: false, error }
 * ────────────────────────────────────────────────────────────────────────────
 */

type Box = { nx: number; ny: number; nw: number; nh: number; confidence?: number };

function killSwitched(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.GEMINI_OCR_DISABLED || "").trim());
}

function getApiKey(): string | null {
  const k = process.env.GEMINI_API_KEY?.trim();
  return k || null;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function parseBox(text: string): Box | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  let nx = Number(obj.nx);
  let ny = Number(obj.ny);
  let nw = Number(obj.nw);
  let nh = Number(obj.nh);
  if (![nx, ny, nw, nh].every((v) => Number.isFinite(v))) return null;
  nx = clamp01(nx);
  ny = clamp01(ny);
  nw = clamp01(nw);
  nh = clamp01(nh);
  if (nw < 0.06 || nh < 0.06) return null;
  if (nx + nw > 1) nw = 1 - nx;
  if (ny + nh > 1) nh = 1 - ny;
  if (nw < 0.06 || nh < 0.06) return null;
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = clamp01(confidence);
  return { nx, ny, nw, nh, confidence };
}

function extractGeminiText(json: unknown): string {
  const j = json as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const parts = j?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((p) => p?.text || "").join("");
}

/** data:image/...;base64,... → { mimeType, base64 } 그대로 반환 (잘못된 형식이면 null). */
function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const m = String(dataUrl || "").match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!m) return null;
  const mimeType = m[1];
  const data = m[2].replace(/\s/g, "");
  if (data.length > 12 * 1024 * 1024) return null;
  return { mimeType, data };
}

async function callGemini(opts: {
  model: string;
  parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>;
  generationConfig?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<unknown> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY 미설정");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 12000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: opts.parts }],
        generationConfig: opts.generationConfig ?? { temperature: 0 },
      }),
      signal: ctl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    if (!res.ok) {
      const msg = json?.error?.message || res.statusText || String(res.status);
      throw new Error(`Gemini ${res.status}: ${msg}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 모델 우선순위 — thinking 이 없는 모델을 먼저.
 * Gemini 2.5 시리즈는 기본적으로 thinking tokens 사용 → maxOutputTokens 안에서
 * thinking 이 토큰을 다 먹으면 실제 출력이 잘리는(중간에 끊기는) 현상 발생.
 * 2.0-flash-lite 는 thinking 없음 → 토큰 모두 출력에 사용 → 안전·빠름.
 */
const MODELS: string[] = ["gemini-2.0-flash-lite", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

/**
 * Gemini 2.5 모델용 thinking 비활성화 + 표준 generation 옵션.
 * 2.0 모델은 thinkingConfig 무시하므로 같은 옵션 안전하게 공유.
 */
function noThinkingConfig(maxOutputTokens: number, opts?: Record<string, unknown>): Record<string, unknown> {
  return {
    temperature: 0,
    maxOutputTokens,
    thinkingConfig: { thinkingBudget: 0 },
    ...(opts ?? {}),
  };
}

// ─── 1) 박스 자동 검출 ─────────────────────────────────────────────────────
const PROMPT_DETECT_BOX = `역할: 태블릿·노트 앱 화면 속 **인쇄 시험지(흰 종이)** 영역만 남기는 정규화 크롭 박스(nx,ny,nw,nh)를 찾습니다.
오직 **현재 이미지**만 보고 판단하세요.

## 포함/제외
- **포함**: 종이 위 첫 인쇄 줄(문항 번호·본문·도표)부터 마지막 인쇄 줄까지
- **포함**: 시험지에 인쇄된 「총 N면 중 M면」 같은 면표 (보이면 잘리면 안 됨)
- **제외**: 상단 도구박스/툴바/앱 헤더/상태줄
- **제외**: 하단 앱 UI (^ 캐럿, 원형 이전/다음, 알약형 페이지 표시, 어두운 독)
- **제외**: 좌우 검은 베젤·회색 앱 여백

## 결정 절차
1. 화면 중앙 밝은 직사각형(흰 종이) 좌우 가장자리에 박스 좌·우를 스냅
2. 상단: 툴바 1픽셀도 안 들어오게, 첫 인쇄 줄은 완전히 보이게 ny 결정
3. 하단: 마지막 인쇄 줄 또는 면표까지 포함, 그 아래 앱 UI 는 모두 제외
4. 좌우는 종이 세로 가장자리에 맞춤 (베젤·회색 띠 금지)

## 출력 (JSON 한 줄만, 설명·마크다운 금지)
{"nx":0~1,"ny":0~1,"nw":0~1,"nh":0~1,"confidence":0~1}
- nx+nw≤1, ny+nh≤1
- 각 값이 0.06 미만이면 안 됨 (너무 작은 박스 금지)`;

export async function geminiDetectProblemBox(
  imageDataUrl: string,
): Promise<
  | { ok: true; box: Box; model: string }
  | { ok: false; error: string; quotaExceeded?: boolean }
> {
  if (killSwitched()) {
    return { ok: false, error: "GEMINI_OCR_DISABLED — 킬스위치 활성화" };
  }
  const parsed = parseDataUrl(imageDataUrl);
  if (!parsed) return { ok: false, error: "이미지 데이터가 너무 크거나 잘못된 형식입니다." };

  let lastErr = "";
  let lastQuota = false;
  for (const model of MODELS) {
    try {
      const json = await callGemini({
        model,
        timeoutMs: 11000,
        generationConfig: noThinkingConfig(400, { responseMimeType: "application/json" }),
        parts: [
          { inline_data: { mime_type: parsed.mimeType, data: parsed.data } },
          { text: PROMPT_DETECT_BOX },
        ],
      });
      const text = extractGeminiText(json);
      const box = parseBox(text);
      if (!box) {
        lastErr = `${model}: 응답 박스 파싱 실패`;
        continue;
      }
      return { ok: true, box, model };
    } catch (e) {
      const msg = (e as Error).message;
      if (/RESOURCE_EXHAUSTED|quota|429/i.test(msg)) lastQuota = true;
      lastErr = `${model}: ${msg.slice(0, 160)}`;
    }
  }
  return { ok: false, error: `Gemini 박스 검출 실패 — ${lastErr}`, quotaExceeded: lastQuota || undefined };
}

// ─── 2) 박스 모방 (REFERENCE → TARGET) ──────────────────────────────────────
const PROMPT_MIMIC_BOX = `과제: TARGET 이미지에 대해, REFERENCE 이미지 + 사용자 박스가 보여 주는 잘라기 의도를 그대로 복제한 정규화 박스(nx,ny,nw,nh, 0~1)를 출력하세요.

## REFERENCE
- 사용자가 직접 맞춘 기준 박스. 그 의도(툴바를 어떻게 피했는지, 면표를 어떻게 포함했는지, 좌우 종이 가장자리에 어떻게 붙였는지)를 파악.

## 작업
1) REFERENCE 박스가 흰 종이와 맺는 관계를 분석
2) TARGET 의 같은 앱 UI 구조와 흰 종이를 식별
3) TARGET 에 같은 의도의 박스를 만들기 (좌표 단순 복사 금지 — 시각적 정렬 기준으로 재계산)
4) 툴바·상태줄·하단 네비·베젤은 항상 박스 밖, 면표는 보이는 한 안

## 출력 (JSON 한 줄, 설명 금지)
{"nx":0~1,"ny":0~1,"nw":0~1,"nh":0~1,"confidence":0~1}`;

export async function geminiMimicCropBox(
  referenceImageDataUrl: string,
  referenceBox: { nx: number; ny: number; nw: number; nh: number },
  targetImageDataUrl: string,
): Promise<
  | { ok: true; box: Box; model: string }
  | { ok: false; error: string; quotaExceeded?: boolean }
> {
  if (killSwitched()) {
    return { ok: false, error: "GEMINI_OCR_DISABLED — 킬스위치 활성화" };
  }
  const ref = parseDataUrl(referenceImageDataUrl);
  const tgt = parseDataUrl(targetImageDataUrl);
  if (!ref || !tgt) return { ok: false, error: "이미지 형식 오류" };

  const lead =
    `REFERENCE 박스(원본 기준 정규화): nx=${referenceBox.nx.toFixed(4)}, ny=${referenceBox.ny.toFixed(4)}, nw=${referenceBox.nw.toFixed(4)}, nh=${referenceBox.nh.toFixed(4)}\n\n`;

  let lastErr = "";
  let lastQuota = false;
  for (const model of MODELS) {
    try {
      const json = await callGemini({
        model,
        timeoutMs: 14000,
        generationConfig: noThinkingConfig(400, { responseMimeType: "application/json" }),
        parts: [
          { text: "REFERENCE 이미지:" },
          { inline_data: { mime_type: ref.mimeType, data: ref.data } },
          { text: "TARGET 이미지:" },
          { inline_data: { mime_type: tgt.mimeType, data: tgt.data } },
          { text: lead + PROMPT_MIMIC_BOX },
        ],
      });
      const text = extractGeminiText(json);
      const box = parseBox(text);
      if (!box) {
        lastErr = `${model}: 응답 박스 파싱 실패`;
        continue;
      }
      return { ok: true, box, model };
    } catch (e) {
      const msg = (e as Error).message;
      if (/RESOURCE_EXHAUSTED|quota|429/i.test(msg)) lastQuota = true;
      lastErr = `${model}: ${msg.slice(0, 160)}`;
    }
  }
  return { ok: false, error: `Gemini 박스 모방 실패 — ${lastErr}`, quotaExceeded: lastQuota || undefined };
}

// ─── 3) 학교명·시험명 한 줄 형식 추출 ──────────────────────────────────────
const PROMPT_EXAM_NAME = `이미지의 제목/헤더를 읽어 시험지 한 줄 형식으로 만드세요.
중요: 이전 답변·예시 복사 금지. 오직 현재 이미지에서 읽힌 텍스트만 사용.

이미지가 두 장 주어지면:
 - 1번 이미지 = 시험지 전체. 연도·지역·학기 등 컨텍스트.
 - 2번 이미지 = 학교명/헤더 영역만 확대한 크롭 (사용자가 표시한 정확 위치).
 → **2번 이미지에서 정확한 학교명 텍스트를 읽고, 1번 이미지에서 부족한 정보(연도·지역·학년·학기)를 보강**해
   아래 형식 한 줄로 합쳐 출력.

출력 형식:
[중|고]n) [YYYY(이미지에 시험 연도·학년도가 보일 때만, 4자리)] [지역(시/군/구)] [학교명] [과목(선택)] N학년 M학기 [중간고사|기말고사]
예: 중1) 2025 도봉구 창동중학교 1학년 2학기 중간고사
예: 고2) 2021 세종시 반곡고등학교 확률과 통계 2학년 1학기 중간고사
예: 고2) 2022 부산진구 부산진고등학교 수학2 2학년 1학기 기말고사
예: 중2) 2020 부산진구 광무여자중학교 2학년 1학기 기말고사

규칙:
1) "N-M"(예: 2-1, 1~2, 1/2)은 앞 숫자 N=학년, 뒤 숫자 M=학기. 절대 순서를 바꾸지 않는다(2-1 ⇒ 2학년 1학기).
2) 앞머리 [중|고]n)의 n은 반드시 N학년 M학기의 N과 같다.
3) 학교명은 이미지에 보이는 그대로. 학교 급은 학교명 끝의 "중학교" 또는 "고등학교"로만 판별.
4) 지역은 이미지에 보이는 시/군/구만 사용. 연도는 헤더에 보이면 4자리(2025·2025학년도·'25학년도 모두 2025).
5) 고등학교의 수학·선택 과목이면 학교명과 학년 사이에 과목명. 로마자 I·II는 아라비아 숫자(수학II ⇒ 수학2).
   허용 과목: 수학1, 수학2, 확률과 통계, 미분과 적분, 미적분, 대수, 미적분1, 미적분2, 기하.
6) 끝은 반드시 "중간고사" 또는 "기말고사".
7) 이미지에서 읽히지 않는 값은 추측 금지 — 단, 헤더에 「2-1 기말 수학 족보」처럼 압축 표기가 있으면 그대로 풀어 적용.
8) "기출", "족보", "수학" 같은 보조 단어는 출력에서 제거 (과목·학년·학기로 흡수).

반드시 한 줄만 출력 (설명·따옴표·마크다운·.pdf 확장자·파일명 금지문자(\\ / : * ? " < > |) 금지).`;

function sanitizeNameLine(s: string): string {
  let t = String(s || "")
    .replace(/\r?\n/g, " ")
    .replace(/^[「"'\s]+|[」"'\s]+$/g, "")
    .trim();
  t = t
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 200) t = t.slice(0, 200);
  return t;
}

/**
 * 형식 검증 — 「[중|고]n) … N학년 M학기 [중간고사|기말고사]」 패턴.
 * 통과하지 못한 응답은 raw text 반환으로 간주하고 다음 모델로 폴백.
 */
function isValidExamNameFormat(s: string): boolean {
  if (!s || s.length < 10) return false;
  // [중|고]N) 으로 시작
  if (!/^[중고]\s*\d\s*\)/.test(s)) return false;
  // N학년 M학기 포함
  if (!/\d\s*학년\s*\d\s*학기/.test(s)) return false;
  // 끝이 중간고사 또는 기말고사
  if (!/(중간고사|기말고사)\s*$/.test(s)) return false;
  return true;
}

export async function geminiSuggestExamName(
  imageDataUrl: string,
  focusImageDataUrl?: string,
): Promise<
  | { ok: true; name: string; model: string }
  | { ok: false; error: string; quotaExceeded?: boolean }
> {
  if (killSwitched()) {
    return { ok: false, error: "GEMINI_OCR_DISABLED — 킬스위치 활성화" };
  }
  const parsed = parseDataUrl(imageDataUrl);
  if (!parsed) return { ok: false, error: "이미지 형식 오류" };
  const focused = focusImageDataUrl ? parseDataUrl(focusImageDataUrl) : null;

  let lastErr = "";
  let lastQuota = false;
  for (const model of MODELS) {
    try {
      // 두 번째 이미지가 있으면: [전체, 확대본, 프롬프트]. 없으면: [전체, 프롬프트].
      const parts = focused
        ? [
            { text: "1번 이미지 (시험지 전체):" },
            { inline_data: { mime_type: parsed.mimeType, data: parsed.data } },
            { text: "2번 이미지 (학교명/헤더 영역 확대):" },
            { inline_data: { mime_type: focused.mimeType, data: focused.data } },
            { text: PROMPT_EXAM_NAME },
          ]
        : [
            { inline_data: { mime_type: parsed.mimeType, data: parsed.data } },
            { text: PROMPT_EXAM_NAME },
          ];
      const json = await callGemini({
        model,
        timeoutMs: 15000,
        // 256 토큰 + thinking 0 — Gemini 2.5 가 thinking 으로 토큰 소모해 출력이 「중2)」 처럼 잘리는 현상 방지.
        // 한 줄 시험명은 보통 30~50 토큰이라 256 은 충분히 여유.
        generationConfig: noThinkingConfig(256),
        parts,
      });
      const raw = extractGeminiText(json);
      const text = sanitizeNameLine(raw);
      // 형식 검증 — 「중2) ... N학년 M학기 ...고사」 패턴 통과해야 합격.
      // 미달이면 raw 반환으로 간주하고 다음 모델로 폴백.
      if (isValidExamNameFormat(text)) {
        return { ok: true, name: text, model };
      }
      lastErr = `${model}: 형식 미달 (raw="${raw.slice(0, 100)}")`;
    } catch (e) {
      const msg = (e as Error).message;
      if (/RESOURCE_EXHAUSTED|quota|429/i.test(msg)) lastQuota = true;
      lastErr = `${model}: ${msg.slice(0, 160)}`;
    }
  }
  return { ok: false, error: `Gemini 시험명 추출 실패 — ${lastErr}`, quotaExceeded: lastQuota || undefined };
}
