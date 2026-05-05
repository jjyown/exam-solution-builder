import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_REFERENCE_DIR = "교재 참고자료";

type RefDoc = {
  filePath: string;
  unit: string;
  type: string;
  difficulty: string;
  content: string;
};

function parseFrontmatter(md: string) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m?.[1]) return { unit: "", type: "", difficulty: "", body: md };
  const header = m[1];
  const body = md.slice(m[0].length);
  const pick = (key: string) =>
    header.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? "";
  return {
    unit: pick("unit"),
    type: pick("type"),
    difficulty: pick("difficulty"),
    body,
  };
}

async function walkMarkdownFiles(dir: string, out: string[]) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkMarkdownFiles(full, out);
      continue;
    }
    if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(full);
  }
}

function scoreDoc(doc: RefDoc, params: {
  unit?: string;
  type?: string;
  difficulty?: string;
}): number {
  let score = 0;
  const eq = (a: string, b: string) => a.trim() && b.trim() && a.trim() === b.trim();
  const inc = (a: string, b: string) =>
    a.trim() && b.trim() && (a.includes(b) || b.includes(a));
  if (eq(doc.unit, params.unit || "")) score += 4;
  else if (inc(doc.unit, params.unit || "")) score += 2;
  if (eq(doc.type, params.type || "")) score += 3;
  else if (inc(doc.type, params.type || "")) score += 1;
  if (eq(doc.difficulty, params.difficulty || "")) score += 2;
  else if (inc(doc.difficulty, params.difficulty || "")) score += 1;
  return score;
}

export async function buildTextbookReferencePromptBlock(params: {
  unit?: string;
  type?: string;
  difficulty?: string;
  maxItems?: number;
  referenceDir?: string;
  includeAllWhenNoTag?: boolean;
}): Promise<string> {
  const cwd = process.cwd();
  const refDir = path.isAbsolute(params.referenceDir || "")
    ? (params.referenceDir as string)
    : path.join(cwd, params.referenceDir || DEFAULT_REFERENCE_DIR);
  let files: string[] = [];
  try {
    await fs.access(refDir);
    await walkMarkdownFiles(refDir, files);
  } catch {
    return "";
  }
  if (files.length === 0) return "";

  const docs: RefDoc[] = [];
  for (const f of files) {
    const raw = await fs.readFile(f, "utf8");
    const fm = parseFrontmatter(raw);
    docs.push({
      filePath: f,
      unit: fm.unit,
      type: fm.type,
      difficulty: fm.difficulty,
      content: fm.body.trim(),
    });
  }

  const taggedQueryExists = Boolean(
    (params.unit || "").trim() || (params.type || "").trim() || (params.difficulty || "").trim(),
  );
  const sortedByScore = docs
    .map((doc) => ({ doc, score: scoreDoc(doc, params) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, params.maxItems ?? 12);

  const picked = taggedQueryExists
    ? sortedByScore.filter((x) => x.score > 0)
    : (params.includeAllWhenNoTag ?? true)
      ? sortedByScore
      : [];

  if (picked.length === 0) return "";
  const lines: string[] = [
    "[교재 참고자료]",
    taggedQueryExists
      ? "- 아래는 동일/유사 단원·유형·난이도의 교재 OCR 참고이다."
      : "- 태그 미지정으로 전체 교재 OCR 참고자료를 폭넓게 반영한다.",
    "- 참고는 서술 톤·전개 밀도·검산 포인트에만 반영하고, 현재 문항 조건에 맞게 재작성한다.",
    "",
  ];
  picked.forEach((item, idx) => {
    const d = item.doc;
    const body = d.content.split("\n").slice(0, 12).join("\n");
    lines.push(
      `### 참고 ${idx + 1} (unit=${d.unit || "-"}, type=${d.type || "-"}, difficulty=${d.difficulty || "-"})`,
      body,
      "",
    );
  });
  return lines.join("\n");
}
