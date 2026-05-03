/** 일회성: ZIP PNG → Gemini 비전 (MCP generate_math_explanation과 동일 스택) */
import "../mcp/0-bootstrap.mjs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cropDir = path.join(root, "크롭된 시험지");
const zipPath = fs
  .readdirSync(cropDir)
  .filter((f) => f.endsWith(".zip") && f.includes("TEST1"))
  .map((f) => path.join(cropDir, f))[0];
if (!zipPath) throw new Error("zip not found");

const TASK = `한국 고등학교 수학. 이미지의 단일 문항만 풀어라.
출력 형식:
[문항 n]
[정답]
[해설]
수식은 LaTeX $...$ 사용. 간결하게.`;

async function main() {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY");
  const genAI = new GoogleGenerativeAI(key);
  const models = ["gemini-2.5-flash-lite", "gemini-2.0-flash"] as const;

  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const pngs = Object.keys(zip.files).filter((n) => n.endsWith(".png")).sort();

  const blocks: string[] = [];
  for (const name of pngs) {
    const b64 = (await zip.file(name)!.async("nodebuffer")).toString("base64");
    let text = "";
    let err: Error | null = null;
    for (const modelId of models) {
      try {
        const model = genAI.getGenerativeModel({ model: modelId });
        const res = await model.generateContent([
          `${TASK}\n파일:${name}`,
          { inlineData: { mimeType: "image/png", data: b64 } },
        ] as never);
        text = res.response.text()?.trim() ?? "";
        if (text) break;
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }
    }
    if (!text && err) throw err;
    blocks.push(`\n--- ${name} ---\n${text}`);
  }
  const outPath = path.join(
    root,
    "해설 작업중",
    "TEST1_크롭묶음",
    "MCP비전_원문.txt",
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, blocks.join("\n"), "utf8");
  console.log(blocks.join("\n"));
  console.error("\n[wrote]", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
