/**
 * 응답 마크다운의 \`\`\`python … \`\`\` 를 추출해 실행하고 PNG를 남긴다.
 * Node child_process, 임시 .py는 실행 후 삭제.
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const PYTHON_FENCE = /```python\s*([\s\S]*?)```/gi;

export type PythonGraphRunResult = {
  cleanedText: string;
  generatedPngAbsPaths: string[];
  logs: string[];
};

function resolvePythonCommand(): { cmd: string; argsPrefix: string[] } {
  const fromEnv = process.env.PYTHON?.trim() || process.env.PYTHON_EXE?.trim();
  if (fromEnv) {
    const parts = fromEnv.split(/\s+/).filter(Boolean);
    return { cmd: parts[0]!, argsPrefix: parts.slice(1) };
  }
  if (process.platform === "win32") {
    return { cmd: "py", argsPrefix: ["-3"] };
  }
  return { cmd: "python3", argsPrefix: [] };
}

function wrapUserMatplotlibCode(userCode: string, outPngAbs: string): string {
  const outJson = JSON.stringify(outPngAbs);
  return `
import os, sys
_mpl = os.path.join(os.path.dirname(__file__), ".mplconfig")
os.makedirs(_mpl, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", _mpl)

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams["font.family"] = ["Malgun Gothic", "Malgun Gothic", "AppleGothic", "NanumGothic", "Noto Sans CJK KR", "sans-serif"]
plt.rcParams["axes.unicode_minus"] = False

${userCode}

_figs = plt.get_fignums()
if _figs:
    plt.figure(_figs[-1])
    plt.savefig(${outJson}, dpi=220, bbox_inches="tight")
plt.close("all")
`.trimStart();
}

/**
 * `markdown` 안의 모든 python 펜스를 순서대로 실행하고, `q{n}_generated_graph.png` 등으로 저장.
 * 펜스는 `cleanedText`에서 제거된다.
 */
export async function stripPythonFencesAndRunGraphs(
  markdown: string,
  questionNum: number,
  workdirAbs: string,
): Promise<PythonGraphRunResult> {
  const logs: string[] = [];
  const generatedPngAbsPaths: string[] = [];
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  const re = /```python\s*([\s\S]*?)```/gi;
  while ((m = re.exec(markdown)) !== null) {
    const c = m[1]?.trim();
    if (c) blocks.push(c);
  }

  if (blocks.length === 0) {
    return {
      cleanedText: markdown.trimEnd(),
      generatedPngAbsPaths: [],
      logs: [`문항 ${questionNum}: python 펜스 없음`],
    };
  }

  const { cmd, argsPrefix } = resolvePythonCommand();
  await fs.mkdir(workdirAbs, { recursive: true });

  for (let i = 0; i < blocks.length; i += 1) {
    const user = blocks[i]!;
    const pngName =
      blocks.length === 1
        ? `q${questionNum}_generated_graph.png`
        : `q${questionNum}_generated_graph_${i + 1}.png`;
    const outPngAbs = path.join(workdirAbs, pngName);
    const wrapped = wrapUserMatplotlibCode(user, outPngAbs);
    const tmpPy = path.join(
      os.tmpdir(),
      `highroad_graph_q${questionNum}_${i}_${Date.now()}.py`,
    );
    await fs.writeFile(tmpPy, wrapped, "utf8");
    const args = [...argsPrefix, tmpPy];
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      cwd: workdirAbs,
      env: { ...process.env, PYTHONUTF8: "1" },
      maxBuffer: 8 * 1024 * 1024,
    });
    try {
      await fs.unlink(tmpPy);
    } catch {
      /* ignore */
    }
    if (r.status !== 0) {
      throw new Error(
        `문항 ${questionNum}: matplotlib 실행 실패(exit ${r.status}). Python·matplotlib·폰트 확인.\n${(r.stderr || r.stdout || "").slice(0, 1200)}`,
      );
    }
    await fs.access(outPngAbs);
    generatedPngAbsPaths.push(outPngAbs);
    logs.push(`OK ${pngName}`);
  }

  const cleanedText = markdown
    .replace(/```python\s*[\s\S]*?```/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  return { cleanedText, generatedPngAbsPaths, logs };
}
