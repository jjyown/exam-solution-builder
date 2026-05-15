/**
 * src/lib/explanationFigureHint.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  LLM 풀이 단계의 `figure_hint` 필드를 받아 보조 Gemini 호출로 matplotlib 코드를
 *  생성한다. 생성된 ```python``` 펜스는 explanationGraphInjection 의 기존 경로로
 *  실행되어 PNG 임베드된다.
 *
 *  안전 가드:
 *   (a) ENABLE_EXPLANATION_FIGURE=false 기본. 명시적 enable 시에만 호출.
 *   (b) EXPLANATION_FIGURE_MAX (기본 3) — 풀이 1건당 호출 횟수 상한.
 *   (d) figure_status: 'ok' | 'skipped_disabled' | 'skipped_limit' | 'failed'
 *
 *  비용: Gemini 1회 호출당 ~$0.0001 (text-only). 정확한 단가는 dry-run 으로 운영자 확인.
 * ────────────────────────────────────────────────────────────────────────────
 */

const FIGURE_PROMPT = `당신은 수학 해설 그림 작성자입니다.
주어진 풀이 단계의 figure_hint 를 그릴 matplotlib(Python) 코드를 작성하세요.

규칙:
- Python 코드 펜스(\`\`\`python ... \`\`\`) 1개만 출력 (다른 텍스트·설명·markdown 금지)
- import matplotlib.pyplot as plt 로 시작
- plt.savefig("output.png", dpi=150, bbox_inches="tight") 로 끝
- 한국어 폰트 깨짐 방지를 위해 라벨은 영문·수식 기호만 사용 (예: "x", "y", "f(x)")
- 그래프 크기 figsize=(5, 4) 권장. 단순·명확한 도형으로
`.trim();

export type FigureStatus = "ok" | "skipped_disabled" | "skipped_limit" | "failed";

export function isExplanationFigureEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.ENABLE_EXPLANATION_FIGURE || "");
}

export function explanationFigureMax(): number {
  const raw = Number(process.env.EXPLANATION_FIGURE_MAX);
  return Number.isFinite(raw) && raw > 0 && raw <= 10 ? Math.floor(raw) : 3;
}

/**
 * figure_hint + step 컨텍스트 → matplotlib Python 코드 (```python``` 펜스 포함).
 * 실패 시 throw — 호출자가 figure_status='failed' 로 표시.
 */
export async function generateMatplotlibCodeForFigureHint(opts: {
  figureHint: string;
  stepText?: string;
  stepEquation?: string;
}): Promise<{ code: string; usedModel: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY 미설정");
  const model =
    process.env.GEMINI_FIGURE_MODEL ||
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const contextLines = [
    `figure_hint: ${opts.figureHint}`,
    opts.stepText ? `단계 text: ${opts.stepText}` : "",
    opts.stepEquation ? `단계 equation: ${opts.stepEquation}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const sleeps = [0, 2000, 5000, 10000];
  let lastErr = "";
  for (let attempt = 0; attempt < sleeps.length; attempt += 1) {
    if (sleeps[attempt] > 0) {
      await new Promise((r) => setTimeout(r, sleeps[attempt]));
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${FIGURE_PROMPT}\n\n${contextLines}` }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const text: string =
        data?.candidates?.[0]?.content?.parts
          ?.map((p: { text?: string }) => p.text)
          .filter(Boolean)
          .join("") || "";
      const code = extractPythonFence(text);
      if (!code) throw new Error("Gemini 응답에 python 펜스 없음");
      return { code, usedModel: model };
    }

    const body = await res.text();
    lastErr = `Gemini figure ${res.status}: ${body.slice(0, 200)}`;
    const retryable =
      res.status === 429 ||
      res.status === 503 ||
      /RESOURCE_EXHAUSTED|quota|rate.*limit|exceeded/i.test(body);
    if (!retryable) throw new Error(lastErr);
  }
  throw new Error(`${lastErr} (${sleeps.length}회 재시도 모두 실패)`);
}

function extractPythonFence(text: string): string | null {
  const m = text.match(/```python\s*[\s\S]*?```/i);
  return m ? m[0] : null;
}
