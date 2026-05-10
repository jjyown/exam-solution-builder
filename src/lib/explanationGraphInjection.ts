/**
 * src/lib/explanationGraphInjection.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  LLM 응답의 ```python``` 펜스 → 실행 → PNG → dataURL 마크다운으로 치환.
 *
 *  배경:
 *   - chiefEditorPrompts 가 「시각화 필수면 matplotlib python 코드를 ```python```
 *     블록으로 포함」 지시 중이지만, 그 코드를 실제로 실행해서 그림으로 만드는 단계가
 *     production 파이프라인에 와이어되어 있지 않았음 (이전엔 stripPythonFencesAndRunGraphs
 *     모듈이 export 만 되고 호출 0건).
 *   - 결과: 그래프 코드가 본문 텍스트로 그대로 남아 사용자가 「왜 그림이 안 나오지」 라고 보고.
 *
 *  와이어 위치:
 *   /api/auto-pipeline/hml · /api/auto-pipeline/docx 가 buildExamExplanation* 호출 직전.
 *   별도 단계라 LLM 호출 비용은 추가 X (이미 받은 parsed 를 후처리만).
 *
 *  안전장치:
 *   - 환경변수 `EXPLANATION_GRAPH_RUN=true` 가 명시적으로 켜져 있을 때만 시도.
 *     기본 OFF — Railway 등 Python·matplotlib 미설치 런타임에서 빌드를 깨지 않게.
 *   - 한 문항이 실패해도 다른 문항은 계속 — 모든 예외를 try/catch 로 흡수, 원본 그대로 반환.
 *
 *  데이터 흐름:
 *   parsed.explanation_steps[i].text 안에 ```python``` 가 있으면:
 *     1) 해당 step 의 python 펜스를 제거 (cleanedText)
 *     2) 생성된 PNG 들을 dataURL 로 인코딩
 *     3) 각 PNG 1개당 step 1개를 새로 append (`![그래프 N](data:image/png;base64,...)`)
 *   → DOCX/HML 빌더의 마크다운 이미지 라인 처리(parseMarkdownImageLine + bufferFromDataUrl)에
 *     자연스럽게 흡수됨.
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

/**
 * 환경변수로 활성화 여부 결정. /^(1|true|yes|on)$/i 매칭.
 * 운영자는 Railway Variables 에 EXPLANATION_GRAPH_RUN=true 를 추가하기 전에
 * 호스트에 Python3 + matplotlib + 한글 폰트(Malgun Gothic 등)가 깔려 있는지 확인.
 */
export function isExplanationGraphRunEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.EXPLANATION_GRAPH_RUN || "");
}

/**
 * runs 의 parsed.explanation_steps 를 후처리해, ```python``` 블록이 있다면
 * matplotlib 으로 PNG 를 만들고 dataURL 마크다운 이미지로 치환.
 *
 * 반환값:
 *   - runs: 후처리된 새 배열 (원본 mutate 안 함)
 *   - logs: 진단 메시지 (서버 로그 출력 또는 응답 헤더에 노출 가능)
 */
export async function injectGeneratedGraphsIntoRuns<
  T extends { questionNo: string; parsed: ParsedExplanation | null },
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
    if (!run.parsed || !Array.isArray(run.parsed.explanation_steps)) {
      transformed.push(run);
      continue;
    }

    // 모든 step 의 text 를 합쳐서 python 펜스가 어디 있든 한 번에 처리.
    const combined = run.parsed.explanation_steps.map((s) => s.text || "").join("\n\n");
    if (!/```python/i.test(combined)) {
      transformed.push(run);
      continue;
    }

    let workdir: string | null = null;
    try {
      workdir = await fs.mkdtemp(path.join(os.tmpdir(), `highroad-graphs-${run.questionNo}-`));
      const qNum = parseInt(run.questionNo, 10) || 1;
      const result = await stripPythonFencesAndRunGraphs(combined, qNum, workdir);
      logs.push(...result.logs);

      // PNG → dataURL — 같은 요청 내에서 즉시 빌더로 흘려보낼 거라 임시 파일 시스템 OK.
      const dataUrls: string[] = [];
      for (const png of result.generatedPngAbsPaths) {
        try {
          const buf = await fs.readFile(png);
          dataUrls.push(`data:image/png;base64,${buf.toString("base64")}`);
        } catch {
          /* 한 PNG 실패는 무시 — 가능한 만큼 진행 */
        }
      }

      // 기존 step 의 python 펜스만 제거. text 의 나머지 설명은 보존.
      const cleanedSteps = run.parsed.explanation_steps.map((s) => ({
        ...s,
        text: (s.text || "")
          .replace(/```python\s*[\s\S]*?```/gi, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      }));

      // 빈 텍스트 스텝(원래 python 만 있던 케이스)은 제거 — 빈 step 으로 본문 흐름이 안 끊기게.
      const nonEmptySteps = cleanedSteps.filter((s) => s.text || s.equation);

      // 생성된 그래프를 별도 step 으로 차곡차곡 append (마크다운 이미지 1줄).
      for (let i = 0; i < dataUrls.length; i += 1) {
        const label = dataUrls.length > 1 ? `그래프 ${i + 1}` : "그래프";
        nonEmptySteps.push({
          text: `![${label}](${dataUrls[i]})`,
          equation: "",
        });
      }

      transformed.push({
        ...run,
        parsed: {
          ...run.parsed,
          explanation_steps: nonEmptySteps,
        },
      });
      logs.push(`문항 ${run.questionNo}: ${dataUrls.length}개 그래프 생성·임베드`);
    } catch (e) {
      // 가장 흔한 실패: Python 미설치, matplotlib 미설치, 폰트 누락, 코드 자체 에러.
      // 원본을 그대로 유지하고 로그만 남김 — 빌드를 막지 않음.
      logs.push(
        `문항 ${run.questionNo}: 그래프 실행 실패 — ${(e as Error).message.slice(0, 200)}`,
      );
      transformed.push(run);
    } finally {
      // 임시 디렉터리 best-effort 정리 — 실패해도 Railway 컨테이너 재시작 시 어차피 사라짐.
      if (workdir) {
        try {
          await fs.rm(workdir, { recursive: true, force: true });
        } catch {
          /* swallow */
        }
      }
    }
  }

  return { runs: transformed, logs };
}
