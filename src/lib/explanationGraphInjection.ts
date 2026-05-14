/**
 * src/lib/explanationGraphInjection.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  LLM 응답의 ```python``` 펜스 → 실행 → PNG → dataURL 마크다운으로 치환.
 *
 *  처리 대상:
 *   1. parsed.explanation_steps[i].text 안의 python 블록 (기존)
 *   2. questionText 안의 python 블록 (추가 — OCR 결과에 그래프 코드 포함 시)
 *
 *  안전장치:
 *   - 환경변수 `EXPLANATION_GRAPH_RUN=true` 가 명시적으로 켜져 있을 때만 시도.
 *     기본 OFF — Railway 등 Python·matplotlib 미설치 런타임에서 빌드를 깨지 않게.
 *   - 한 문항이 실패해도 다른 문항은 계속 — 모든 예외를 try/catch 로 흡수, 원본 그대로 반환.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripPythonFencesAndRunGraphs } from "./explanationPythonGraphRunner";

export type ParsedStep = { text: string; equation: string };
export type ParsedExplanation = {
  answer: string;
  explanation_steps: ParsedStep[];
  summary?: string;
};

export function isExplanationGraphRunEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.EXPLANATION_GRAPH_RUN || "");
}

/** PNG 파일 → base64 data URL */
async function pngToDataUrl(absPath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(absPath);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * runs 의 parsed.explanation_steps 와 questionText 를 후처리해,
 * ```python``` 블록이 있다면 matplotlib 으로 PNG 를 만들고
 * dataURL 마크다운 이미지로 치환.
 */
export async function injectGeneratedGraphsIntoRuns<
  T extends {
    questionNo: string;
    questionText?: string;
    parsed: ParsedExplanation | null;
  },
>(runs: T[]): Promise<{ runs: T[]; logs: string[] }> {
  const logs: string[] = [];
  if (!isExplanationGraphRunEnabled()) {
    logs.push(
      "graph-inject: skipped — EXPLANATION_GRAPH_RUN env 가 켜지지 않음. " +
        "Python·matplotlib 설치 후 Railway Variables 에 EXPLANATION_GRAPH_RUN=true 추가 시 활성.",
    );
    return { runs, logs };
  }

  const transformed: T[] = [];
  for (const run of runs) {
    // current 는 처리 중 업데이트되는 복사본
    let current: T = run;

    // ── explanation_steps python 블록 처리 ─────────────────────────────────
    if (current.parsed && Array.isArray(current.parsed.explanation_steps)) {
      const combined = current.parsed.explanation_steps.map((s) => s.text || "").join("\n\n");
      if (/```python/i.test(combined)) {
        let workdir: string | null = null;
        try {
          workdir = await fs.mkdtemp(
            path.join(os.tmpdir(), `highroad-graphs-${current.questionNo}-`),
          );
          const qNum = parseInt(current.questionNo, 10) || 1;
          const result = await stripPythonFencesAndRunGraphs(combined, qNum, workdir);
          logs.push(...result.logs);

          const dataUrls: string[] = [];
          for (const png of result.generatedPngAbsPaths) {
            const url = await pngToDataUrl(png);
            if (url) dataUrls.push(url);
          }

          const cleanedSteps = current.parsed.explanation_steps.map((s) => ({
            ...s,
            text: (s.text || "")
              .replace(/```python\s*[\s\S]*?```/gi, "")
              .replace(/\n{3,}/g, "\n\n")
              .trim(),
          }));
          const nonEmptySteps = cleanedSteps.filter((s) => s.text || s.equation);

          for (let i = 0; i < dataUrls.length; i += 1) {
            const label = dataUrls.length > 1 ? `그래프 ${i + 1}` : "그래프";
            nonEmptySteps.push({ text: `![${label}](${dataUrls[i]})`, equation: "" });
          }

          current = {
            ...current,
            parsed: { ...current.parsed, explanation_steps: nonEmptySteps },
          };
          logs.push(`문항 ${run.questionNo}: ${dataUrls.length}개 그래프 생성·임베드`);
        } catch (e) {
          logs.push(
            `문항 ${run.questionNo}: 그래프 실행 실패 — ${(e as Error).message.slice(0, 200)}`,
          );
        } finally {
          if (workdir) {
            try {
              await fs.rm(workdir, { recursive: true, force: true });
            } catch {
              /* swallow */
            }
          }
        }
      }
    }

    // ── questionText python 블록 처리 ──────────────────────────────────────
    if (current.questionText && /```python/i.test(current.questionText)) {
      let workdir: string | null = null;
      try {
        workdir = await fs.mkdtemp(
          path.join(os.tmpdir(), `highroad-qtext-${current.questionNo}-`),
        );
        const qNum = parseInt(current.questionNo, 10) || 1;
        const result = await stripPythonFencesAndRunGraphs(current.questionText, qNum, workdir);
        logs.push(...result.logs);

        const dataUrls: string[] = [];
        for (const png of result.generatedPngAbsPaths) {
          const url = await pngToDataUrl(png);
          if (url) dataUrls.push(url);
        }

        let newQText = result.cleanedText.trim();
        for (let i = 0; i < dataUrls.length; i += 1) {
          const label = dataUrls.length > 1 ? `그래프 ${i + 1}` : "그래프";
          newQText += `\n\n![${label}](${dataUrls[i]})`;
        }

        current = { ...current, questionText: newQText };
        logs.push(`문항 ${run.questionNo}: questionText ${dataUrls.length}개 그래프 생성`);
      } catch (e) {
        logs.push(
          `문항 ${run.questionNo}: questionText 그래프 실행 실패 — ${(e as Error).message.slice(0, 200)}`,
        );
      } finally {
        if (workdir) {
          try {
            await fs.rm(workdir, { recursive: true, force: true });
          } catch {
            /* swallow */
          }
        }
      }
    }

    transformed.push(current);
  }

  return { runs: transformed, logs };
}
