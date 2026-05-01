import fs from "node:fs";
import path from "node:path";

function usage() {
  console.log(
    "Usage: node scripts/extract-hml-style-samples.mjs <zip-path> [output-path]\n" +
      "Example: node scripts/extract-hml-style-samples.mjs \"C:/Users/me/Downloads/Downloads (2).Zip\" ./docs/style-samples.txt",
  );
}

function stripTags(xmlText) {
  return xmlText
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function pickCoreSamples(plainText) {
  const anchors = ["[정답]", "[해설]"];
  const hasAnchors = anchors.every((token) => plainText.includes(token));
  if (!hasAnchors) return null;
  const answerIdx = plainText.indexOf("[정답]");
  const explainIdx = plainText.indexOf("[해설]");
  if (answerIdx === -1 || explainIdx === -1 || explainIdx < answerIdx) return null;
  const cut = plainText.slice(answerIdx, Math.min(plainText.length, explainIdx + 700));
  return cut;
}

async function main() {
  const [, , zipPathArg, outPathArg] = process.argv;
  if (!zipPathArg) {
    usage();
    process.exit(1);
  }

  const zipPath = path.resolve(zipPathArg);
  const outPath = path.resolve(outPathArg || "./docs/style-samples.txt");
  if (!fs.existsSync(zipPath)) {
    throw new Error(`ZIP file not found: ${zipPath}`);
  }

  // Minimal ZIP reader without extra deps: rely on .hml files likely small count.
  // We use PowerShell Expand-Archive through child process for reliability on Windows.
  const tempDir = path.resolve("./.tmp-style-samples");
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  const { spawnSync } = await import("node:child_process");
  const ps = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path "${zipPath.replace(/"/g, '""')}" -DestinationPath "${tempDir.replace(/"/g, '""')}" -Force`,
    ],
    { encoding: "utf-8" },
  );
  if (ps.status !== 0) {
    throw new Error(`Expand-Archive failed: ${ps.stderr || ps.stdout}`);
  }

  const files = fs
    .readdirSync(tempDir)
    .filter((name) => name.toLowerCase().endsWith(".hml"))
    .sort();
  const outputs = [];
  for (const name of files) {
    const fullPath = path.join(tempDir, name);
    const raw = fs.readFileSync(fullPath, "utf-8");
    const plain = stripTags(raw);
    const sample = pickCoreSamples(plain);
    if (!sample) continue;
    outputs.push(`=== ${name} ===\n${sample}\n`);
  }

  if (outputs.length === 0) {
    outputs.push("No [정답]/[해설] samples found.\n");
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outputs.join("\n"), "utf-8");
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log(`Extracted ${outputs.length} sample blocks -> ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
