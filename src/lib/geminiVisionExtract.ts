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
import { isGeminiRateLimitedMessage } from "./geminiRateLimit";

export type VisionExtractResult =
  | { ok: true; text: string; model: string; mimeType: string }
  | { ok: false; error: string; quotaExceeded?: boolean };

const DEFAULT_OCR_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-2.0-flash-lite",
];

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
  "8) **출력 형식**: 마크다운/코드블록 없이 평문으로. 설명·메타 코멘트(\"여기 OCR 결과...\") 일절 금지. 추출된 시험지 본문 텍스트만 반환.",
  "",
  "위 규칙대로 시험지 내용을 텍스트로 변환해 반환하세요.",
].join("\n");

function isGeminiQuotaError(message: string): boolean {
  return /RESOURCE_EXHAUSTED|spending\s*cap|quota|exceeded/i.test(message);
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
        { text: KOREAN_EXAM_OCR_PROMPT },
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

/** 사용 가능 여부 — UI 가 fallback 분기 결정에 사용 */
export function isGeminiVisionAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}
