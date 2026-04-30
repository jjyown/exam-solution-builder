import fs from "node:fs";
import path from "node:path";

const apiUrl = process.env.HML_APPEND_API_URL || "http://localhost:3000/api/hml/append-solution";
const manualSelection = process.env.HML_MANUAL_SELECTION || "1-30";
const requestTimeoutMs = Number(process.env.HML_SMOKE_TIMEOUT_MS || "240000");
const smokeFast = (process.env.HML_SMOKE_FAST || "1").toLowerCase();
const smokeMode = process.env.HML_SMOKE_MODE === "auto_assist" ? "auto_assist" : "manual";
const minQuestionCount = Number(process.env.HML_SMOKE_MIN_QUESTION_COUNT || "8");
const minCoverageRatio = Number(process.env.HML_SMOKE_MIN_COVERAGE_RATIO || "0.6");
const maxMismatchRatio = Number(process.env.HML_SMOKE_MAX_MISMATCH_RATIO || "0.35");

const defaultSamples = [
  "c:/Users/mirun/Downloads/내신 2026년 충북 청주시 봉명고 고3공통 1학기중간 확률과통계.Hml",
  "c:/Users/mirun/Downloads/[고3] 고3) 2026 부산 해동고등학교 확률과통계 3학년 1학기 중간고사.hml",
  "c:/Users/mirun/Downloads/내신 2026년 서울 송파구 보인고 고2공통 1학기중간 확률과통계.Hml",
  "c:/Users/mirun/Downloads/내신 2026년 부산 동래구 부산중앙여고 고3공통 1학기중간 확률과통계.Hml",
];
const sampleFilter = (process.env.HML_SMOKE_SAMPLES || "").trim();
const samples = sampleFilter
  ? sampleFilter.split("||").map((item) => item.trim()).filter(Boolean)
  : defaultSamples;

async function runOne(filePath) {
  const name = path.basename(filePath);
  if (!fs.existsSync(filePath)) {
    return { file: name, ok: false, error: "파일 없음" };
  }
  const form = new FormData();
  form.append("hmlFile", new Blob([fs.readFileSync(filePath)], { type: "text/xml" }), name);
  form.append("manualQuestionSelection", manualSelection);
  form.append("smokeFast", smokeFast);
  form.append("mode", smokeMode);

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const res = await fetch(apiUrl, { method: "POST", body: form, signal: controller.signal });
    const text = await res.text();
    const elapsedMs = Date.now() - startedAt;
    if (!res.ok) {
      return { file: name, ok: false, status: res.status, elapsedMs, error: text.slice(0, 300) };
    }
    const json = JSON.parse(text);
    return {
      file: name,
      ok: true,
      elapsedMs,
      questionCount: json.questionCount ?? 0,
      coverageRatio: json.parsingQuality?.coverageRatio ?? null,
      mismatchRatio: json.parsingQuality?.mismatchRatio ?? null,
      pass: Boolean(json.parsingQuality?.pass),
      quickAnswerStats: json.quickAnswerStats ?? null,
    };
  } catch (error) {
    return {
      file: name,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error:
        error instanceof Error
          ? error.name === "AbortError"
            ? `요청 시간 초과(${requestTimeoutMs}ms)`
            : error.message
          : "알 수 없는 오류",
    };
  }
  finally {
    clearTimeout(timer);
  }
}

async function main() {
  const results = [];
  for (const sample of samples) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runOne(sample);
    results.push(result);
    console.log(result);
  }
  const evaluated = results.map((item) => {
    if (!item.ok) return { ...item, passByThreshold: false, failReasons: ["요청/응답 실패"] };
    const reasons = [];
    if ((item.questionCount ?? 0) < minQuestionCount) reasons.push(`문항수 부족(<${minQuestionCount})`);
    if ((item.coverageRatio ?? 0) < minCoverageRatio) reasons.push(`커버리지 부족(<${minCoverageRatio})`);
    if ((item.mismatchRatio ?? 0) > maxMismatchRatio) reasons.push(`불일치 과다(>${maxMismatchRatio})`);
    if (!item.pass) reasons.push("API 품질판정 fail");
    return { ...item, passByThreshold: reasons.length === 0, failReasons: reasons };
  });
  const failed = evaluated.filter((item) => !item.passByThreshold);
  console.log("\n== HML Smoke Summary ==");
  console.log(
    JSON.stringify(
      {
        apiUrl,
        smokeMode,
        manualSelection,
        thresholds: { minQuestionCount, minCoverageRatio, maxMismatchRatio, requestTimeoutMs },
        smokeFast,
        total: evaluated.length,
        failed: failed.length,
        results: evaluated,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) process.exit(1);
}

await main();
