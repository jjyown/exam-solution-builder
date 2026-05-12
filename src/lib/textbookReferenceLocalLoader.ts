/**
 * textbookReferenceLocalLoader.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  로컬 디스크의 「교재 참고자료/」 디렉토리에 빌드된 *_problem*.md / *.p###.md
 *  파일들을 ReferenceRecord[] 로 변환해 retriever 에 주입한다.
 *
 *  배경:
 *   - Drive 자동 동기화는 Mathpix /v3/pdf 통째 호출이라 교재 같은 큰 PDF 는
 *     앞쪽 몇 페이지만 OCR 된 채로 끝남 (analysis_records 에 1~10건 정도만 적재).
 *   - 한편 `npm run textbook:build-reference` 는 PDF 를 페이지 분할 + bbox 문항
 *     분리해서 「교재 참고자료/<unit>/<type>/<difficulty>/*.md」 로 빌드해 두는데,
 *     이 산출물이 autoPipelineRetriever 에 연결되어 있지 않아 RAG 에 안 들어감.
 *   - 이 로더가 그 단절을 메운다.
 *
 *  ▷ 입력 디렉토리: process.env.TEXTBOOK_REFERENCE_DIR (기본: 「교재 참고자료」)
 *  ▷ 인식 패턴: frontmatter (`unit/type/difficulty/sourceImage`) + 본문
 *               (build-textbook-reference / textbook_page_split_mathpix 산출물)
 *  ▷ 비활성화: TEXTBOOK_REFERENCE_DIR= (빈 값) 으로 끄기.
 *
 *  성능: 1k 개 md 파일 ≈ 100~200ms 1회 로드 후 인메모리 캐시.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ReferenceRecord } from "./referenceRetriever";

type Frontmatter = {
  unit?: string;
  type?: string;
  difficulty?: string;
  sourceImage?: string;
};

function defaultRootDir(): string {
  const env = process.env.TEXTBOOK_REFERENCE_DIR?.trim();
  if (env === "") return ""; // 명시적 비활성화
  if (env) return env;
  return path.join(process.cwd(), "교재 참고자료");
}

/** YAML 흉내 frontmatter 파서 — 첫 `---` 블록의 `key: value` 만 추출. */
function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: raw };
  const fmBlock = m[1] ?? "";
  const body = m[2] ?? "";
  const fm: Frontmatter = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    const key = kv[1] as keyof Frontmatter;
    fm[key] = kv[2];
  }
  return { fm, body };
}

/** `## OCR_본문` 헤더 이하만 추려 본문으로 사용. 없으면 전체 본문 그대로. */
function extractOcrBody(body: string): string {
  const idx = body.indexOf("## OCR_본문");
  if (idx < 0) return body.trim();
  const after = body.slice(idx + "## OCR_본문".length);
  return after.replace(/^\s*\n/, "").trim();
}

function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

async function walkMdFiles(root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "README.md") continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      await walkMdFiles(full, out);
      continue;
    }
    if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
}

/**
 * 로컬 「교재 참고자료/」 디렉토리에서 ReferenceRecord 들을 로드.
 * 디렉토리 없거나 비활성화면 빈 배열 (silent).
 */
export async function loadLocalTextbookReferenceRecords(opts?: {
  rootDir?: string;
}): Promise<{ records: ReferenceRecord[]; rootDir: string; fileCount: number }> {
  const rootDir = opts?.rootDir ?? defaultRootDir();
  if (!rootDir) return { records: [], rootDir: "", fileCount: 0 };

  const files: string[] = [];
  await walkMdFiles(rootDir, files);
  if (files.length === 0) return { records: [], rootDir, fileCount: 0 };

  const records: ReferenceRecord[] = [];
  for (const absPath of files) {
    let raw: string;
    try {
      raw = await fs.readFile(absPath, "utf8");
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    const ocr = extractOcrBody(body);
    if (ocr.length < 10) continue; // 거의 빈 md 는 skip

    const rel = path.relative(rootDir, absPath).replace(/\\/g, "/");
    const id = `textbook-local-${shortHash(rel)}`;
    const source = `local/교재 참고자료/${rel}`;
    // problem_hint 는 BM25 가중치를 받는 짧은 문자열 — 단원·유형이 적격.
    const hintParts: string[] = [];
    if (fm.unit) hintParts.push(fm.unit);
    if (fm.type) hintParts.push(fm.type);
    if (fm.difficulty && !/미분류/.test(fm.difficulty)) hintParts.push(fm.difficulty);
    const problem_hint = hintParts.join(" ");

    records.push({
      id,
      source,
      answer: "",
      problem_hint,
      content: ocr,
      equations: [],
    });
  }

  return { records, rootDir, fileCount: files.length };
}
