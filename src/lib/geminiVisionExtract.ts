/**
 * geminiVisionExtract.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  Gemini multimodal 로 시험지 이미지/PDF 에서 문제 본문을 한국어 친화적으로
 *  추출한다. Mathpix 대비 장점:
 *    - 한국어 발문 인식 정확도 ⭐
 *    - 도형/그래프를 글로 묘사 (Mathpix 는 무시)
 *    - 문항 구조 (발문/조건/보기/선지) 를 그대로 보존
 *    - PDF 를 페이지 단위 분리 없이 통째로 처리 (inlineData 50MB 한도)
 *    - 가격: gemini-2.0-flash 1장 ≈ $0.0001 (Mathpix 1page ≈ $0.004 → 40배 저렴)
 *    - 키 통일: GEMINI_API_KEY 하나면 끝
 * ────────────────────────────────────────────────────────────────────────────
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isGeminiRateLimitedMessage } from "./geminiRateLimit";

export type VisionExtractResult =
  | { ok: true; text: string; model: string; mimeType: string }
  | { ok: false; error: string; quotaExceeded?: boolean };

// 비용 폭탄 방지: 기본 후보를 가장 싼 단일 모델로 제한.
// 이전엔 [2.0-flash, 2.5-flash, 2.0-flash-lite] 였으나 429 시 비싼 2.5-flash 로
// 자동 진급 → output 토큰 8배 단가 → 2026-05-09 비용 spike 사례 발생.
// 단일 모델 + 호출처 backoff 로 처리. 필요 시 env GEMINI_MODELS_OCR 로 확장 가능.
const DEFAULT_OCR_MODELS = ["gemini-2.0-flash"];

/** 환경변수로 후보 모델을 오버라이드할 수 있게: `GEMINI_MODELS_OCR=gemini-2.5-flash,gemini-2.0-flash` */
function resolveOcrModelCandidates(): string[] {
  const raw = process.env.GEMINI_MODELS_OCR?.trim();
  if (!raw) return [...DEFAULT_OCR_MODELS];
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...DEFAULT_OCR_MODELS];
}

const KOREAN_EXAM_OCR_PROMPT = [
  "당신은 한국 중·고등 수학 시험지를 텍스트로 옮기는 OCR 전문가입니다.",
  "다음 규칙을 엄격히 따라주세요:",
  "",
  "1) **문항 번호 보존**: `1.`, `2.`, ... `30.` 같은 문항 번호를 그대로 옮긴다. 배점은 `[3점]` 처럼 대괄호로.",
  "2) **발문 본문**: 한국어 본문은 줄바꿈을 살려 그대로 옮긴다. 시험지 헤더/페이지 번호/시험지명 등 메타 정보는 제외.",
  "3) **수식**: 인라인 수식은 `$...$`, 디스플레이 수식(독립 줄·큰 수식)은 `$$...$$` 로 LaTeX 작성. 분수는 `\\frac{a}{b}`, 루트는 `\\sqrt{x}`, 적분은 `\\int`, 시그마는 `\\sum` 등 표준 명령어.",
  "4) **선지**: ①②③④⑤ 형태가 보이면 그대로, `1)` `2)` 형태면 원문 그대로. 각 선지는 별도 줄로.",
  "5) **<보기>·조건 박스**: 본문 안의 박스로 묶인 영역(\"보기\", \"조건\", \"<보기>\")은 다음과 같이 표시한다:",
  "      <보기>",
  "      (가) ...",
  "      (나) ...",
  "      </보기>",
  "6) **도형·그래프·표**: 그림이 있으면 본문 끝에 `[그림: 좌표평면 위의 ... ]` 처럼 한 줄로 핵심 요소를 묘사. 도형 좌표·점 라벨이 보이면 포함.",
  "7) **문항 분리**: 여러 문항이 한 페이지에 있으면 문항 사이를 빈 줄 한 줄로 구분.",
  "8) **문제집·해설지 합본 처리**: 같은 PDF 안에 문제와 해설이 모두 있으면 명확한 섹션 구분이 필요:",
  "      - 풀이가 시작되는 페이지에는 한 줄에 `[해설]` 또는 `[정답 및 해설]` 만 적어 풀이 섹션 시작을 표시.",
  "      - 풀이 섹션 안의 각 풀이는 원래 번호(`1.`, `2.` …)를 그대로 옮겨, 어느 문제의 풀이인지 알 수 있게.",
  "      - 빈 페이지·중복 페이지는 무시하고 내용 있는 텍스트만 옮긴다.",
  "8) **출력 형식**: 마크다운/코드블록 없이 평문으로. 설명·메타 코멘트(\"여기 OCR 결과...\") 일절 금지. 추출된 시험지 본문 텍스트만 반환.",
  "",
  "위 규칙대로 시험지 내용을 텍스트로 변환해 반환하세요.",
].join("\n");

function isGeminiQuotaError(message: string): boolean {
  return /RESOURCE_EXHAUSTED|spending\s*cap|quota|exceeded/i.test(message);
}

/**
 * 시중교재 페이지 전용 OCR 프롬프트.
 * 시험지 프롬프트는 "메타 정보 제외" 규칙 때문에 표지·안내·목차 페이지에서
 * 빈 응답을 반환한다. 교재는 표지·목차·단원 안내·문제·풀이까지 모두
 * 살려야 하므로 별도 프롬프트를 사용한다.
 */
const KOREAN_TEXTBOOK_OCR_PROMPT = [
  "당신은 한국 중·고등 수학 교재(쎈·EBS·RPM 등 시중교재) 페이지를 텍스트로 옮기는 OCR 전문가입니다.",
  "이 페이지는 문제·해설 합본 PDF 의 한 페이지일 가능성이 높습니다 (책 앞쪽 = 문제, 책 뒤쪽 = 정답 및 해설).",
  "다음 규칙을 엄격히 따르세요:",
  "",
  "1) **페이지 종류 판별·표시**: 페이지 본문 첫 줄에 다음 중 하나의 태그를 적습니다.",
  "   - `[페이지유형: 문제]`   — 문항·선지 위주의 문제 페이지",
  "   - `[페이지유형: 해설]`   — 풀이·정답 위주의 해설 페이지 (\"풀이\", \"정답\", \"step\", 색칠 박스의 정답·풀이 등 단서로 판단)",
  "   - `[페이지유형: 표지]`   — 책 표지·단원 표지·중간 안내 페이지",
  "   - `[페이지유형: 목차]`   — 차례·INDEX·구성과 특장점 안내",
  "   - `[페이지유형: 혼합]`   — 같은 페이지에 문제와 풀이가 같이 있음 (적은 경우)",
  "2) **섹션 전환 페이지**: 본 페이지가 「정답 및 해설」 섹션의 첫 페이지 (해설지 시작 페이지) 라고 판단되면 두 번째 줄에 `[정답 및 해설 시작]` 한 줄을 추가합니다.",
  "3) **모든 텍스트 추출**: 단원 제목·소제목·문항 번호·발문·선지·풀이·정답·표·캡션을 누락 없이 옮긴다.",
  "4) **표지/목차/안내 페이지도 그대로**: 표지면 제목·저자·출판사를, 목차면 차례를, 안내 페이지면 학습 방법을 옮긴다.",
  "5) **문항·풀이 번호 보존**: `1.`, `001`, `(1)` 등 원문 번호 그대로. 해설 페이지에서 풀이 번호는 `[풀이 1]`, `[풀이 2]` 또는 원문 표기(`1.`, `01`) 둘 다 허용 — 원문 형태 우선.",
  "6) **수식**: 인라인은 `$...$`, 디스플레이는 `$$...$$` 로 LaTeX. 분수 `\\frac{a}{b}`, 루트 `\\sqrt{x}`, 적분 `\\int` 등 표준.",
  "7) **선지**: ①②③④⑤ 형태 그대로, 또는 `1) 2) 3)` 그대로. 각 선지 별도 줄.",
  "8) **정답 표기**: 해설 페이지의 박스 안 정답은 `정답: ③` 또는 `정답: 16` 형식으로 옮긴다.",
  "9) **<보기>·조건 박스**: `<보기>` ... `</보기>` 태그로 감싼다.",
  "10) **도형·그래프·표**: 한 줄로 `[그림: ... ]` 식의 핵심 묘사. 표는 가능하면 마크다운 표로.",
  "11) **출력 형식**: 마크다운 코드블록 없이 평문. 메타 코멘트(\"여기 OCR 결과...\") 일절 금지. 추출된 본문 텍스트만 반환.",
  "12) **진짜 빈 페이지** (전혀 글자·그림 없음) 일 때만 `[페이지유형: 빈페이지]` 한 줄만 출력.",
  "",
  "예시 출력 형식:",
  "",
  "[페이지유형: 해설]",
  "[정답 및 해설 시작]",
  "01. 정답: ③",
  "$x^2 - 8x + 15 = (x-3)(x-5)$ 이므로 …",
  "",
  "위 규칙대로 페이지 내용을 텍스트로 변환해 반환하세요.",
].join("\n");

/**
 * 시중교재 페이지 1장을 Gemini Vision 으로 OCR.
 * 시험지용 extractTextWithGeminiVision 과 별도 — 표지/목차/안내 페이지도 살린다.
 * 빈 페이지는 `[빈 페이지]` 한 줄을 반환 (실패 아님).
 */
export async function extractTextbookPageWithGeminiVision(
  base64: string,
  mimeType: string,
): Promise<VisionExtractResult> {
  return runGeminiVisionWithPrompt(base64, mimeType, KOREAN_TEXTBOOK_OCR_PROMPT);
}

/**
 * 이미지/PDF base64 → Gemini multimodal 로 텍스트 추출.
 * mimeType 예: "image/png", "image/jpeg", "application/pdf".
 * Gemini SDK 는 inlineData 50MB 한도, application/pdf 는 페이지 합산.
 */
export async function extractTextWithGeminiVision(
  base64: string,
  mimeType: string,
): Promise<VisionExtractResult> {
  return runGeminiVisionWithPrompt(base64, mimeType, KOREAN_EXAM_OCR_PROMPT);
}

async function runGeminiVisionWithPrompt(
  base64: string,
  mimeType: string,
  prompt: string,
): Promise<VisionExtractResult> {
  if (isGeminiOcrKillSwitched()) {
    return {
      ok: false,
      error: "GEMINI_OCR_DISABLED=true — 비용 보호 킬스위치 활성화. Railway Variables 에서 해제하세요.",
    };
  }
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "GEMINI_API_KEY 미설정 — Railway/.env.local 에 추가 필요." };
  }
  const client = new GoogleGenerativeAI(apiKey);
  const candidates = resolveOcrModelCandidates();

  const failures: string[] = [];
  let lastQuota = false;
  for (const modelName of candidates) {
    try {
      const model = client.getGenerativeModel({ model: modelName });
      const result = await model.generateContent([
        { text: prompt },
        {
          inlineData: {
            data: base64,
            mimeType,
          },
        },
      ]);
      const raw = result.response.text()?.trim() ?? "";
      if (!raw) {
        failures.push(`${modelName}: 빈 응답`);
        continue;
      }
      // 모델이 코드블록·메타 안내를 포함했을 때 청소
      const cleaned = stripMetaWrappers(raw);
      if (!cleaned) {
        failures.push(`${modelName}: 청소 후 텍스트 없음`);
        continue;
      }
      await dumpRawVisionResponseIfEnabled(raw, cleaned, modelName, mimeType, prompt);
      return { ok: true, text: cleaned, model: modelName, mimeType };
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 비전 OCR 오류";
      if (/not found|is not supported/i.test(message)) {
        // 다음 후보로
        continue;
      }
      if (isGeminiQuotaError(message) || isGeminiRateLimitedMessage(message)) {
        lastQuota = true;
        failures.push(`${modelName}: 할당량/혼잡 (${message.slice(0, 120)})`);
        // 같은 키로 다른 Gemini 모델을 시도해도 같은 결과일 가능성이 높지만, 한번 더 가벼운 모델로
        continue;
      }
      failures.push(`${modelName}: ${message}`);
    }
  }

  return {
    ok: false,
    error: `Gemini Vision OCR 실패 — 후보 ${candidates.length}개 모두 실패: ${failures.join(" / ")}`,
    quotaExceeded: lastQuota || undefined,
  };
}

/** 모델이 가끔 ```text ... ``` 으로 감싸 보내는 경우 제거 */
function stripMetaWrappers(raw: string): string {
  let s = raw.trim();
  // 코드블록 펜스
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  // "여기 시험지 내용입니다:" 같은 머리말
  s = s.replace(/^(여기\s+|아래는\s+|다음은\s+).{0,40}(?:입니다|이다)[:：]?\s*\n+/i, "").trim();
  return s;
}

/**
 * 비용 비상 정지 킬 스위치.
 * GEMINI_OCR_DISABLED=true (또는 1/yes/on) 이면:
 *  - 모든 Gemini Vision OCR 호출이 즉시 거절됨
 *  - 분석자료 auto-sync 의 새 OCR 도 건너뜀 (이미 캐시된 자료는 정상 사용)
 *  - 시험지 PDF 도 pdfjs 텍스트 추출만 사용 (스캔본은 실패할 수 있음)
 * Railway Variables 에 한 줄 추가/제거로 즉시 토글 가능.
 */
function isGeminiOcrKillSwitched(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.GEMINI_OCR_DISABLED || "").trim());
}

/** 사용 가능 여부 — UI 가 fallback 분기 결정에 사용. 킬스위치 ON 이면 false. */
export function isGeminiVisionAvailable(): boolean {
  if (isGeminiOcrKillSwitched()) return false;
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/** 킬 스위치 상태 조회 — UI/관리 페이지용 */
export function isGeminiOcrDisabled(): boolean {
  return isGeminiOcrKillSwitched();
}

/**
 * 진단용 raw 응답 dump.
 * DEBUG_VISION_RAW_DUMP=true (또는 1/yes/on) 일 때만 동작. 기본 false.
 * cleaned 와 raw 둘 다 저장해 stripMetaWrappers 가 LaTeX 손상시키는지도 확인 가능.
 * 실패해도 OCR 진행은 막지 않는다 (fire-and-forget try/catch).
 * 저장 위치: project root/tmp/raw_vision_response_{ISO}.json (.gitignore 처리됨)
 */
async function dumpRawVisionResponseIfEnabled(
  raw: string,
  cleaned: string,
  modelName: string,
  mimeType: string,
  prompt: string,
): Promise<void> {
  const flag = (process.env.DEBUG_VISION_RAW_DUMP || "").trim();
  if (!/^(1|true|yes|on)$/i.test(flag)) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(process.cwd(), "tmp");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `raw_vision_response_${ts}.json`);
    const promptKind = prompt === KOREAN_TEXTBOOK_OCR_PROMPT ? "textbook" : "exam";
    const payload = {
      timestamp: ts,
      model: modelName,
      mimeType,
      promptKind,
      rawLength: raw.length,
      cleanedLength: cleaned.length,
      raw,
      cleaned,
    };
    await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // dump 실패는 OCR 진행을 막지 않음 (조용히 무시)
  }
}
