/**
 * Mathpix OCR v3 `/v3/pdf` — PDF 비동기 처리 wrapper.
 * @see https://docs.mathpix.com/reference/post-v3-pdf
 *
 * 흐름:
 *  1) POST /v3/pdf  (multipart) → `{ pdf_id }` 반환
 *  2) GET /v3/pdf/{id}  반복 폴링 → status: completed 또는 error
 *  3) GET /v3/pdf/{id}.{format}  → mmd 텍스트 다운로드
 *
 * 한국어 수식·도형 텍스트 추출 정확도가 Gemini Vision 보다 우수.
 * 비용: 페이지당 ~$0.005 (사용자 충전 크레딧 안에서 차감)
 */
import {
  resolveMathpixCredentials,
} from "./mathpixV3Text";

const MATHPIX_PDF_ENDPOINT =
  process.env.MATHPIX_PDF_URL?.trim() || "https://api.mathpix.com/v3/pdf";

export type MathpixPdfStatusBody = {
  pdf_id?: string;
  status?: "received" | "loaded" | "split" | "processing" | "completed" | "error";
  num_pages?: number;
  num_pages_completed?: number;
  percent_done?: number;
  error?: string;
  error_info?: { id?: string; message?: string };
  input_file?: string;
};

/** PDF 제출 → pdf_id 반환. */
export async function submitMathpixPdf(
  buffer: Buffer,
  fileName: string,
  options?: Record<string, unknown>,
): Promise<{ ok: true; pdfId: string } | { ok: false; status: number; message: string }> {
  const cred = resolveMathpixCredentials();
  if (!cred) {
    return { ok: false, status: 501, message: "MATHPIX_APP_ID/KEY 미설정" };
  }
  const form = new FormData();
  // Node 18+ 글로벌 Blob/FormData 사용. fetch multipart 지원.
  // Buffer → 새 ArrayBuffer 로 복사해 Blob 생성 (TS BlobPart 타입 호환).
  const ab = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(ab).set(buffer);
  const blob = new Blob([ab], { type: "application/pdf" });
  form.append("file", blob, fileName || "document.pdf");
  // 호출자가 includeLineData=true 를 넘기면 conversion_formats 에 lines.json 추가.
  // 페어링률 <40% PDF 의 자동 폴백에서만 사용 — 일반 동선은 그대로.
  const includeLineData = !!(options && (options as { includeLineData?: boolean }).includeLineData);
  const opts = { ...(options ?? {}) };
  delete (opts as { includeLineData?: boolean }).includeLineData;
  form.append(
    "options_json",
    JSON.stringify({
      // mmd · md 모두 가능 — 호환을 위해 둘 다 켜두고 호출 측에서 mmd 사용
      conversion_formats: includeLineData
        ? { mmd: true, md: true, "lines.json": true }
        : { mmd: true, md: true },
      // 한국어/수식 친화 — 인라인 $...$ / 디스플레이 $$...$$
      math_inline_delimiters: ["$", "$"],
      math_display_delimiters: ["$$", "$$"],
      rm_spaces: true,
      ...opts,
    }),
  );

  let res: Response;
  try {
    res = await fetch(MATHPIX_PDF_ENDPOINT, {
      method: "POST",
      headers: { app_id: cred.appId, app_key: cred.appKey },
      body: form,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, message: `네트워크 오류: ${msg}` };
  }

  let json: { pdf_id?: string; error?: string; error_info?: { message?: string } };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    const raw = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status || 502,
      message: `응답 파싱 실패: ${raw.slice(0, 300)}`,
    };
  }

  if (!res.ok || !json.pdf_id) {
    return {
      ok: false,
      status: res.status,
      message:
        json.error ||
        json.error_info?.message ||
        `Mathpix /v3/pdf HTTP ${res.status}`,
    };
  }
  return { ok: true, pdfId: json.pdf_id };
}

/** pdf_id 의 처리 상태 조회. */
export async function getMathpixPdfStatus(
  pdfId: string,
): Promise<
  | { ok: true; body: MathpixPdfStatusBody }
  | { ok: false; status: number; message: string }
> {
  const cred = resolveMathpixCredentials();
  if (!cred) {
    return { ok: false, status: 501, message: "MATHPIX_APP_ID/KEY 미설정" };
  }
  let res: Response;
  try {
    res = await fetch(`${MATHPIX_PDF_ENDPOINT}/${encodeURIComponent(pdfId)}`, {
      method: "GET",
      headers: { app_id: cred.appId, app_key: cred.appKey },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, message: `네트워크 오류: ${msg}` };
  }
  let body: MathpixPdfStatusBody;
  try {
    body = (await res.json()) as MathpixPdfStatusBody;
  } catch {
    return { ok: false, status: res.status, message: "응답 JSON 파싱 실패" };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: body.error || body.error_info?.message || `HTTP ${res.status}`,
    };
  }
  return { ok: true, body };
}

/**
 * Mathpix v3 PDF lines.json 응답 (간략화 — 핵심 필드만).
 * @see https://docs.mathpix.com/reference/pdf-lines-json
 *
 * 페어링률 <40% PDF 의 자동 폴백에서 segment 분할에 사용한다.
 * (텍스트 헤더 매칭이 깨졌을 때 좌표 기반으로 다시 분리)
 */
export type MathpixPdfLinesJson = {
  pages: Array<{
    page: number;
    image_id?: string;
    page_height?: number;
    page_width?: number;
    lines: Array<{
      id?: string;
      type?: string;          // "text" | "math" | "page_info" | ...
      cnt?: number[][];       // 픽셀 다각형 [[x,y],[x,y],...]
      text?: string;
      // 그 외 mathml/html/conf 등은 사용하지 않음
    }>;
  }>;
};

/** 완료된 pdf_id 의 lines.json 결과를 가져온다 — 자동 폴백 전용. */
export async function getMathpixPdfLinesJson(
  pdfId: string,
): Promise<
  | { ok: true; data: MathpixPdfLinesJson }
  | { ok: false; status: number; message: string }
> {
  const cred = resolveMathpixCredentials();
  if (!cred) {
    return { ok: false, status: 501, message: "MATHPIX_APP_ID/KEY 미설정" };
  }
  let res: Response;
  try {
    res = await fetch(
      `${MATHPIX_PDF_ENDPOINT}/${encodeURIComponent(pdfId)}.lines.json`,
      {
        method: "GET",
        headers: { app_id: cred.appId, app_key: cred.appKey },
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, message: `네트워크 오류: ${msg}` };
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      message: raw.slice(0, 300) || `HTTP ${res.status}`,
    };
  }
  let data: MathpixPdfLinesJson;
  try {
    data = (await res.json()) as MathpixPdfLinesJson;
  } catch {
    return { ok: false, status: 502, message: "lines.json 파싱 실패" };
  }
  if (!Array.isArray(data?.pages)) {
    return { ok: false, status: 502, message: "lines.json 응답에 pages 배열 없음" };
  }
  return { ok: true, data };
}

/** 완료된 pdf_id 의 결과를 mmd 또는 md 로 가져와 텍스트 반환. */
export async function getMathpixPdfResult(
  pdfId: string,
  format: "mmd" | "md" = "mmd",
): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
  const cred = resolveMathpixCredentials();
  if (!cred) {
    return { ok: false, status: 501, message: "MATHPIX_APP_ID/KEY 미설정" };
  }
  let res: Response;
  try {
    res = await fetch(
      `${MATHPIX_PDF_ENDPOINT}/${encodeURIComponent(pdfId)}.${format}`,
      {
        method: "GET",
        headers: { app_id: cred.appId, app_key: cred.appKey },
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, message: `네트워크 오류: ${msg}` };
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      message: raw.slice(0, 300) || `HTTP ${res.status}`,
    };
  }
  const text = await res.text();
  return { ok: true, text };
}

export type RecognizeMathpixPdfOptions = {
  /** 처리 timeout (ms). 기본 5분 — textbook 200페이지도 대부분 안에 끝남. */
  maxWaitMs?: number;
  /** 폴링 시작 간격 (ms). 기본 3초. */
  pollIntervalMs?: number;
  /** 폴링 최대 간격 (ms). 점진적 백오프 상한. 기본 10초. */
  maxPollIntervalMs?: number;
};

/**
 * 고수준 wrapper — PDF 제출 → 폴링 → 결과 텍스트 반환.
 * 호출자는 단일 await 로 사용 가능. 매쓰픽스 quota error 는 호출자가
 * `isMathpixQuotaError` + `markMathpixExhausted` 로 처리.
 */
export async function recognizeMathpixPdf(
  buffer: Buffer,
  fileName: string,
  opts?: RecognizeMathpixPdfOptions,
): Promise<
  | { ok: true; text: string; pages: number; pdfId: string }
  | { ok: false; status: number; message: string }
> {
  const submitR = await submitMathpixPdf(buffer, fileName);
  if (!submitR.ok) return submitR;
  const pdfId = submitR.pdfId;

  const maxWaitMs = opts?.maxWaitMs ?? 5 * 60 * 1000;
  let pollIntervalMs = opts?.pollIntervalMs ?? 3000;
  const maxPollIntervalMs = opts?.maxPollIntervalMs ?? 10000;
  const startedAt = Date.now();

  // 첫 짧은 대기 — 작은 PDF 는 거의 즉시 완료될 수 있음
  await sleep(Math.min(pollIntervalMs, 2000));

  while (Date.now() - startedAt < maxWaitMs) {
    const statusR = await getMathpixPdfStatus(pdfId);
    if (!statusR.ok) {
      // 5xx 일시적 오류 → 다음 폴링 회 까지 대기
      if (statusR.status >= 500 && statusR.status < 600) {
        await sleep(pollIntervalMs);
        pollIntervalMs = Math.min(maxPollIntervalMs, Math.floor(pollIntervalMs * 1.3));
        continue;
      }
      // 4xx 영구 오류
      return statusR;
    }
    const status = statusR.body.status;
    if (status === "completed") {
      const numPages =
        statusR.body.num_pages ?? statusR.body.num_pages_completed ?? 0;
      const resultR = await getMathpixPdfResult(pdfId, "mmd");
      if (!resultR.ok) return resultR;
      return { ok: true, text: resultR.text, pages: numPages, pdfId };
    }
    if (status === "error") {
      return {
        ok: false,
        status: 422,
        message:
          statusR.body.error ||
          statusR.body.error_info?.message ||
          "Mathpix PDF 처리 실패",
      };
    }
    // received / loaded / split / processing — 계속 폴링
    await sleep(pollIntervalMs);
    pollIntervalMs = Math.min(maxPollIntervalMs, Math.floor(pollIntervalMs * 1.3));
  }

  return {
    ok: false,
    status: 408,
    message: `Mathpix PDF 처리 ${(maxWaitMs / 1000) | 0}초 timeout (pdf_id=${pdfId})`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
