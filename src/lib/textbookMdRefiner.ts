/**
 * textbookMdRefiner.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  「교재 참고자료」 디렉토리에 이미 저장된 *_problemNN.md 들을, 같은 stem 의
 *  *_problemNN.png 크롭 이미지를 참조해 Gemini Vision 으로 다시 보정한다.
 *
 *  배경(왜 필요한가):
 *   - scripts/build-textbook-reference.mts 가 PDF 페이지를 Mathpix `line_data`
 *     bbox 로 분할해 *_problemNN.md / .png 를 생성한다.
 *   - 그러나 Mathpix OCR 결과에서 [문항 N] / [해설 N] / [정답 및 해설] 같은
 *     표준 마커가 자주 깨져, src/lib/driveAnalysisLearner.ts 의 1:1 매핑이
 *     1단계(parseProblemSolutionPairs) 에서 실패하고 1500자 chunk 폴백으로
 *     떨어진다 → 결과적으로 RAG 검색 품질·페어 적중률 저하.
 *   - 이 모듈은 *디스크의 md* 를 PNG 이미지를 다시 참조해 보정 — 한국어 OCR 강한
 *     Gemini Vision 으로 표준 마커 포함된 본문을 다시 받아 덮어쓴다.
 *
 *  안전 장치:
 *   - 이미 표준 마커가 잘 들어있는 md 는 skip (Vision 호출 비용 절약)
 *   - dry-run 모드(--dry) 로 변경 미리보기 가능
 *   - frontmatter 는 보존, OCR 본문 영역만 교체
 *   - --max 로 한 번에 처리할 파일 수 제한 (Gemini 한도 보호)
 *   - 기존 md 는 같은 폴더의 .md.bak 로 백업 (--no-backup 으로 끄기)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { extractTextWithGeminiVision } from "./geminiVisionExtract";
import { normalizeOcrTextForPairing } from "./analysisTextNormalizer";

export type RefineCandidate = {
  mdPath: string;
  imagePath: string;
  /** 왜 이 파일이 보정 후보인지 (디버깅·dry-run 출력용) */
  reasons: string[];
  /** 기존 frontmatter (보존 대상) */
  frontmatter: string;
  /** 기존 본문 ('## OCR_본문' 이후 텍스트) */
  body: string;
};

export type RefineOutcome =
  | { mdPath: string; status: "skipped"; reason: string }
  | { mdPath: string; status: "refined"; bytesBefore: number; bytesAfter: number; addedMarkers: string[] }
  | { mdPath: string; status: "failed"; error: string }
  | { mdPath: string; status: "dry"; addedMarkers: string[]; previewBefore: string; previewAfter: string };

export type RefineOptions = {
  /** 적용 안 하고 결과만 보여주기 */
  dryRun?: boolean;
  /** 기존 md 를 .md.bak 로 백업 (기본 true) */
  backup?: boolean;
  /** 한 번에 처리할 최대 파일 수 (Gemini 호출 보호) */
  max?: number;
  /** 이미 표준 마커가 들어있어도 강제로 보정 (기본 false) */
  force?: boolean;
};

/**
 * 디렉토리(재귀) 안에서 보정 후보 *_problemNN.md 들을 찾는다.
 * 같은 stem 의 .png 이미지가 없으면 후보에서 제외 (이미지 없으면 보정 불가).
 */
export async function findRefineCandidates(rootDir: string): Promise<RefineCandidate[]> {
  const out: RefineCandidate[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!/_problem\d+\.md$/.test(e.name)) continue;
      const mdPath = full;
      const stem = e.name.replace(/\.md$/, "");
      // 같은 stem 의 PNG / JPG 찾기
      const candidates = [
        path.join(dir, `${stem}.png`),
        path.join(dir, `${stem}.jpg`),
        path.join(dir, `${stem}.jpeg`),
      ];
      let imagePath = "";
      for (const c of candidates) {
        try {
          await fs.access(c);
          imagePath = c;
          break;
        } catch {
          // 다음
        }
      }
      if (!imagePath) continue;

      const raw = await fs.readFile(mdPath, "utf8");
      const split = splitFrontmatter(raw);
      const reasons = diagnoseRefineReasons(split.body);
      if (reasons.length === 0) continue;
      out.push({ mdPath, imagePath, reasons, frontmatter: split.frontmatter, body: split.body });
    }
  }

  await walk(rootDir);
  return out;
}

/**
 * 단일 후보를 처리. dry-run 이면 변경 안 함.
 * Gemini Vision 호출이 실패하면 status: 'failed' 로 반환 (다음 파일 진행).
 */
export async function refineOneCandidate(
  cand: RefineCandidate,
  opts: RefineOptions,
): Promise<RefineOutcome> {
  const buf = await fs.readFile(cand.imagePath);
  const ext = path.extname(cand.imagePath).toLowerCase();
  const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  const visionRes = await extractTextWithGeminiVision(buf.toString("base64"), mimeType);
  if (!visionRes.ok) {
    return { mdPath: cand.mdPath, status: "failed", error: visionRes.error };
  }
  const normalized = normalizeOcrTextForPairing(visionRes.text);
  const newBody = normalized.text.trim();

  if (newBody.length < 50) {
    return { mdPath: cand.mdPath, status: "failed", error: "Vision 보정 결과가 너무 짧음 (50자 미만)" };
  }

  // 기존 본문이 표준 마커를 이미 가지고 있고 force=false 면 skip — 비용 절약
  if (!opts.force && hasStandardMarkers(cand.body) && cand.body.length > 200) {
    return { mdPath: cand.mdPath, status: "skipped", reason: "이미 표준 마커 충분" };
  }

  const merged = `${cand.frontmatter}\n\n## OCR_본문\n\n${newBody}\n`;

  if (opts.dryRun) {
    return {
      mdPath: cand.mdPath,
      status: "dry",
      addedMarkers: normalized.appliedRules,
      previewBefore: cand.body.slice(0, 200),
      previewAfter: newBody.slice(0, 200),
    };
  }

  if (opts.backup !== false) {
    try {
      await fs.copyFile(cand.mdPath, `${cand.mdPath}.bak`);
    } catch {
      // 백업 실패해도 원본 덮어쓰기는 진행 (dry-run 모드 사용 권장)
    }
  }
  const before = (await fs.stat(cand.mdPath)).size;
  await fs.writeFile(cand.mdPath, merged, "utf8");
  const after = (await fs.stat(cand.mdPath)).size;
  return {
    mdPath: cand.mdPath,
    status: "refined",
    bytesBefore: before,
    bytesAfter: after,
    addedMarkers: normalized.appliedRules,
  };
}

/** frontmatter 와 본문 분리. OCR_본문 헤더 안의 텍스트를 본문으로 사용. */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const m = raw.match(/^(---\n[\s\S]*?\n---)\s*\n?/);
  const frontmatter = m ? m[1] : "---\n---";
  const rest = m ? raw.slice(m[0].length) : raw;
  const bodyMatch = rest.match(/##\s*OCR_본문\s*\n+([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1].trim() : rest.trim();
  return { frontmatter, body };
}

/** 표준 마커가 본문에 충분히 있는지 — 페어 매핑이 잘 될지 휴리스틱 판단 */
function hasStandardMarkers(body: string): boolean {
  const hasProblem = /\[문항\s*\d+\]/.test(body);
  const hasSolution = /\[해설(\s*\d+)?\]|\[정답\s*및\s*해설\]/.test(body);
  return hasProblem && hasSolution;
}

/** 어떤 이유로 보정 후보가 됐는지 진단 — UI / dry-run 출력용 */
function diagnoseRefineReasons(body: string): string[] {
  const reasons: string[] = [];
  if (body.length < 100) reasons.push("본문이 너무 짧음(<100자) — OCR 누락 의심");
  if (!/\[문항\s*\d+\]/.test(body) && !/\d+[\.\)]/.test(body.slice(0, 200))) {
    reasons.push("문항 마커·번호가 안 보임");
  }
  // 풀이가 있어야 할 페이지인데 표준 풀이 헤더 없음
  if (/해설|풀이|정답/.test(body) && !/\[해설(\s*\d+)?\]|\[정답\s*및\s*해설\]/.test(body)) {
    reasons.push("풀이 키워드는 있는데 표준 [정답 및 해설] / [해설 N] 마커 없음");
  }
  return reasons;
}
