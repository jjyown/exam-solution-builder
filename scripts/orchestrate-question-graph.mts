/**
 * 문항 해설 .md 에 그래프 삽입 자동화 (로컬 CLI)
 *
 * 1) 문제/해설 텍스트로 「그래프 필수」 여부 판단 (Gemini)
 * 2) 원본 시험지에서 따 온 도형 크롭이 있으면 (--diagram-crop) matplotlib 생성보다 우선해 복사·삽입
 * 3) 필요 시 JSON graph spec → scripts/graphs/plot_from_spec.py → 문항NN_그래프.png
 * 4) [해설] 직후 ![](문항NN_그래프.png) 삽입
 * 5) Vision 으로 축·교점 대략 일치 여부 확인 (경고만 출력, --skip-vision 으로 생략)
 *
 * 사용:
 *   npm run graph:for-md -- --md "해설 작업중/[TEST] TEST1.pdf/문항05_API초안.md"
 *   npm run graph:for-md -- --md ".../문항05_API초안.md" --diagram-crop ./도형크롭.png
 *   npm run graph:for-md -- --md ".../문항05_API초안.md" --dry-run
 *
 * 필요: .env.local 의 GEMINI_API_KEY, Python + pip install -r scripts/graphs/requirements.txt
 */
import { config } from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { spawnSync } from "node:child_process";
import { copyFile, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

config({ path: path.join(process.cwd(), ".env.local") });
config({ path: path.join(process.cwd(), ".env") });

const MODEL =
  process.env.GRAPH_ORCHESTRATE_MODEL?.trim() || process.env.GEMINI_MODELS_PRECHECK?.trim() || "gemini-2.0-flash";

type Cli = {
  mdPath: string;
  diagramCrop: string | null;
  dryRun: boolean;
  skipVision: boolean;
  forceGraph: boolean;
};

function parseArgs(argv: string[]): Cli {
  let mdPath = "";
  let diagramCrop: string | null = null;
  let dryRun = false;
  let skipVision = false;
  let forceGraph = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--md" && argv[i + 1]) {
      mdPath = argv[i + 1];
      i += 1;
    } else if (a === "--diagram-crop" && argv[i + 1]) {
      diagramCrop = argv[i + 1];
      i += 1;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--skip-vision") {
      skipVision = true;
    } else if (a === "--force-graph") {
      forceGraph = true;
    }
  }
  return { mdPath, diagramCrop, dryRun, skipVision, forceGraph };
}

function extractQuestionLabelFromFilename(fileName: string): string | null {
  const m = /^문항(\d{1,2})_API초안\.md$/i.exec(fileName);
  return m ? m[1] : null;
}

function graphImageName(questionLabel: string): string {
  return `문항${questionLabel.padStart(2, "0")}_그래프.png`;
}

function stripJsonFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  }
  return t.trim();
}

async function geminiText(apiKey: string, prompt: string): Promise<string> {
  const gen = new GoogleGenerativeAI(apiKey);
  const model = gen.getGenerativeModel({ model: MODEL });
  const res = await model.generateContent(prompt);
  return res.response.text()?.trim() ?? "";
}

async function geminiVision(apiKey: string, prompt: string, imagePath: string, mime: string): Promise<string> {
  const gen = new GoogleGenerativeAI(apiKey);
  const model = gen.getGenerativeModel({ model: MODEL });
  const b64 = (await readFile(imagePath)).toString("base64");
  const res = await model.generateContent([
    prompt,
    { inlineData: { mimeType: mime, data: b64 } },
  ] as never);
  return res.response.text()?.trim() ?? "";
}

/** 본문에 이미 그래프용 이미지 링크가 있으면 중복 삽입 방지 */
function markdownAlreadyHasGraphFigure(md: string): boolean {
  return (
    /!\[[^\]]*\]\([^)]*그래프[^)]*\.(png|jpe?g|webp)\)/i.test(md) ||
    /!\[[^\]]*\]\([^)]*문항\d+_그래프\.png\)/i.test(md)
  );
}

function insertGraphAfterExplanationHeader(md: string, imageFileName: string): { next: string; changed: boolean } {
  const imgMd = `\n\n![그래프](${imageFileName})\n\n`;
  if (new RegExp(`!\\[[^\\]]*\\]\\([^)]*${imageFileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^)]*\\)`).test(md)) {
    return { next: md, changed: false };
  }
  if (!/\[해설\]/i.test(md)) {
    return { next: md + `\n\n[해설]${imgMd}`, changed: true };
  }
  const replaced = md.replace(/(\[해설\]\s*\n)/i, `$1${imgMd}`);
  if (replaced === md) {
    const replaced2 = md.replace(/(\[해설\])/i, `$1${imgMd}`);
    return { next: replaced2, changed: replaced2 !== md };
  }
  return { next: replaced, changed: true };
}

function resolvePythonBin(): string {
  if (process.platform === "win32") {
    const tryPy = spawnSync("py", ["-3", "-c", "print(1)"], { encoding: "utf-8" });
    if (tryPy.status === 0) return "py";
  }
  return "python";
}

function runPlotter(specPath: string, outPath: string): void {
  const root = process.cwd();
  const plotScript = path.join(root, "scripts", "graphs", "plot_from_spec.py");
  const bin = resolvePythonBin();
  const args =
    bin === "py"
      ? ["-3", plotScript, "--spec", specPath, "--out", outPath, "--dpi", "200"]
      : [plotScript, "--spec", specPath, "--out", outPath, "--dpi", "200"];
  const r = spawnSync(bin, args, { encoding: "utf-8", cwd: root, maxBuffer: 10 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error("plot_from_spec.py 실행 실패 (Python·matplotlib 설치 확인)");
  }
  if (r.stdout?.trim()) console.log(r.stdout.trim());
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.error("GEMINI_API_KEY 가 필요합니다 (.env.local)");
    process.exit(1);
  }

  const cli = parseArgs(process.argv);
  if (!cli.mdPath) {
    console.error("사용법: npm run graph:for-md -- --md \"경로/문항05_API초안.md\" [--diagram-crop 도형.png]");
    process.exit(1);
  }

  const mdAbs = path.resolve(cli.mdPath);
  const dir = path.dirname(mdAbs);
  const base = path.basename(mdAbs);
  const qLabel = extractQuestionLabelFromFilename(base);
  if (!qLabel) {
    console.error("파일명이 문항NN_API초안.md 형식이어야 합니다.");
    process.exit(1);
  }
  const imageName = graphImageName(qLabel);
  const imageAbs = path.join(dir, imageName);

  const mdRaw = await readFile(mdAbs, "utf-8");
  const snippet = mdRaw.slice(0, 6000);

  if (!cli.diagramCrop && !cli.forceGraph && markdownAlreadyHasGraphFigure(mdRaw)) {
    console.log("[건너뜀] 해설에 그래프/도형 PNG 링크가 이미 있습니다. 교체하려면 --force-graph 또는 --diagram-crop");
    return;
  }

  if (cli.diagramCrop) {
    console.log("[우선] 원본 시험지 도형 크롭 사용:", cli.diagramCrop);
    if (!cli.dryRun) {
      await copyFile(path.resolve(cli.diagramCrop), imageAbs);
      const ins = insertGraphAfterExplanationHeader(mdRaw, imageName);
      if (ins.changed) await writeFile(mdAbs, ins.next, "utf-8");
      console.log("저장:", imageAbs);
      if (!ins.changed) console.log("(이미 동일 이미지 링크가 있음)");
    }
    if (!cli.skipVision && !cli.dryRun) {
      const ex = mdRaw.match(/\[해설\]\s*([\s\S]+)/i)?.[1]?.slice(0, 3500) ?? mdRaw.slice(0, 3500);
      const vprompt = `이 PNG는 수학 해설에 삽입된 그래프/도형이다. 아래 해설 본문에 나온 x축·y축 범위, 교점·꼭짓점 좌표와 시각적으로 대체로 맞는지 한국어로 짧게 평가하라. JSON만 출력: {"aligned":true/false,"notes":"..."}\n\n[해설 발췌]\n${ex}`;
      const vout = await geminiVision(apiKey, vprompt, imageAbs, "image/png");
      console.log("[비전 검수]", vout);
    }
    return;
  }

  const classifyPrompt = `역할: 중고등 수학 교재 편집자. 아래는 한 문항의 해설 마크다운 일부다.

[그래프 삽입이 **필요하다**고 볼 때 — 아래 중 하나라도 해당하면 needsGraph=true 쪽으로 판단]
1) 삼각함수·지수·로그·이차함수 등 **곡선**이고, **직선 y=k 또는 x=k와의 교점·교점 개수·x좌표의 합** 등이 본질인 경우
2) **주기·위상** 또는 **x의 구간/반개구간** 안에서 해의 개수를 말하는 경우(축 위 상황이 핵심)
3) 좌표평면에서 **부등식·영역·꼭짓점·절편**을 시각화해야 하는 경우
4) 문제·해설에 **그래프/그림을 참고**하라는 취지 또는 **도형·작도**가 중심인 경우

[불필요하다고 볼 때]
- 근호·분수·연립만으로 끝나고 **축·교점·그래프 맥락이 없는** 순수 대수 계산만 있는 경우

JSON만 출력 (코드펜스 금지): {"needsGraph":true/false,"confidence":0~1,"reasons":["한국어 짧게"]}

---
${snippet}
`;

  const clsRaw = await geminiText(apiKey, classifyPrompt);
  let cls: { needsGraph?: boolean; confidence?: number; reasons?: string[] };
  try {
    cls = JSON.parse(stripJsonFence(clsRaw)) as typeof cls;
  } catch {
    console.error("판단 JSON 파싱 실패:", clsRaw.slice(0, 500));
    process.exit(1);
  }

  console.log("[판단]", JSON.stringify(cls, null, 2));

  if (!cli.forceGraph && !cls.needsGraph) {
    console.log("그래프 필수로 보이지 않아 종료 (--force-graph 로 강제 가능)");
    return;
  }

  const specPrompt = `아래 문제·해설을 바탕으로 matplotlib용 그래프 JSON 명세를 만들어라. 교과서 해설지 수준으로 **교점·꼭짓점·구간 끝**이 드러나게.

규칙:
- curves[].expr_python: 변수 x (numpy 배열)만. 예: "2*np.sin(np.pi*x/6)"
- 교점이 y=k 와 생기면 hlines에 {"y":1,"xmin":xlim0,"xmax":xlim1,"linestyle":"-","linewidth":1.8} 처럼 **선분**으로 그리고, curves 라벨에 함수식을 넣어라.
- 교점 좌표는 points에 {"x":1,"y":1,"size":45} 처럼 **닫힌 점**. 원점 (0,0)이면 label "O".
- **반개구간** 끝 (예: x<6 이라서 (6,0) 미포함) 은 points에 {"x":6,"y":0,"marker_open":true,"size":55} 로 빈 원.
- 최고점 등 특수점은 points로 표시하고, 필요하면 vlines에 {"x":3,"ymin":0,"ymax":2,"linestyle":"--"} 처럼 **보조 세로선**(축~점)을 넣어라.
- xlim, ylim 은 해설 구간·y=k 를 모두 담도록.
- line_width_pt 기본 2, font_family ["Malgun Gothic","DejaVu Sans"]

JSON만 출력 (코드펜스 금지). 스키마 예:
{"title":"","xlim":[0,6.2],"ylim":[-0.3,2.3],"xlabel":"$x$","ylabel":"$y$","line_width_pt":2,"font_family":["Malgun Gothic","DejaVu Sans"],"curves":[{"expr_python":"2*np.sin(np.pi*x/6)","label":"$y=2\\\\sin\\\\frac{\\\\pi}{6}x$","samples":800,"color":"C0"}],"points":[{"x":0,"y":0,"label":"O","size":40},{"x":1,"y":1,"size":45},{"x":5,"y":1,"size":45},{"x":3,"y":2,"size":45},{"x":6,"y":0,"marker_open":true,"size":55}],"vlines":[{"x":1,"ymin":0,"ymax":1,"linestyle":"--"},{"x":5,"ymin":0,"ymax":1,"linestyle":"--"}],"hlines":[{"y":1,"xmin":0,"xmax":6,"linestyle":"-","linewidth":1.8}]}

(위는 예시이니 해설 내용에 맞게 수치를 바꿔라.)

---
${snippet}
`;

  if (cli.dryRun) {
    console.log("[dry-run] 명세 생성·plot 생략");
    return;
  }

  const specRaw = await geminiText(apiKey, specPrompt);
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(stripJsonFence(specRaw)) as Record<string, unknown>;
  } catch {
    console.error("graph spec JSON 파싱 실패:", specRaw.slice(0, 800));
    process.exit(1);
  }

  const specPath = path.join(dir, `.graph_spec_${qLabel}.json`);
  await writeFile(specPath, JSON.stringify(spec, null, 2), "utf-8");
  try {
    runPlotter(specPath, imageAbs);
  } finally {
    await unlink(specPath).catch(() => {});
  }

  const ins = insertGraphAfterExplanationHeader(mdRaw, imageName);
  if (ins.changed) await writeFile(mdAbs, ins.next, "utf-8");
  console.log("해설 갱신:", mdAbs);
  if (!ins.changed) console.log("(이미 동일 이미지 링크가 있음)");

  if (!cli.skipVision) {
    const ex = mdRaw.match(/\[해설\]\s*([\s\S]+)/i)?.[1]?.slice(0, 3500) ?? mdRaw.slice(0, 3500);
    const vprompt = `첨부 PNG는 방금 생성한 함수 그래프다. 해설 발췌에 적힌 식·축·교점·특수점과 그림이 대체로 일치하는지 한국어로 짧게 평가하라. JSON만: {"aligned":true/false,"notes":"..."}

[해설 발췌]
${ex}`;
    const vout = await geminiVision(apiKey, vprompt, imageAbs, "image/png");
    console.log("[비전 검수]", vout);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
