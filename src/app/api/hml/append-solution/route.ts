import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  SectionType,
  TabStopType,
  TextRun,
} from "docx";
import { isGoogleDriveConfigured, uploadCompletedDocx } from "@/lib/googleDrive";

const OUTPUT_DIR = path.join(process.cwd(), "작업 완료");
const MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"] as const;
const MIN_QUESTION_COUNT_FOR_PASS = 3;
const MIN_COVERAGE_RATIO = 0.6;
const MAX_MISMATCH_RATIO = 0.35;

type QuestionItem = {
  no: number;
  text: string;
};

type HmlParagraph = {
  text: string;
  autonumNo: number | null;
};

type QuickAnswerStatus = "verified" | "filled" | "mismatch";

type GeneratedItem = {
  no: number;
  solution: string;
  generatedAnswer: string;
  expectedAnswer: string | null;
  status: QuickAnswerStatus;
};

type QuestionQualityInfo = {
  score: number;
  noisy: boolean;
};

type GenerationProfile = "normal" | "noisy";

type ParsingQuality = {
  pass: boolean;
  warnings: string[];
  coverageRatio: number;
  mismatchRatio: number;
};

type SourceProfile = "default" | "core-request-set";
type HmlExecutionMode = "manual" | "auto_assist";

function detectSourceProfile(fileName: string): SourceProfile {
  const lower = fileName.toLowerCase();
  const markers = ["해동고등학교", "부산중앙여고", "보인고", "봉명고"];
  return markers.some((m) => lower.includes(m.toLowerCase())) ? "core-request-set" : "default";
}

function extractJsonArray(text: string) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim();
}

function stripTags(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHmlPlainText(hml: string) {
  const paragraphs = [...hml.matchAll(/<P\b[\s\S]*?<\/P>/gi)];
  const lines: string[] = [];

  for (const para of paragraphs) {
    const block = para[0];
    const chunks: string[] = [];
    const tokenMatches = block.matchAll(
      /<AUTONUM\b[^>]*\bNumber="([0-9]+)"[^>]*>|<CHAR[^>]*>([\s\S]*?)<\/CHAR>|<SCRIPT[^>]*>([\s\S]*?)<\/SCRIPT>|<LINEBREAK\s*\/>|<TAB\s*\/>/gi,
    );
    for (const token of tokenMatches) {
      if (token[1]) {
        chunks.push(`${token[1]}) `);
        continue;
      }
      if (token[2]) {
        const value = decodeXmlText(stripTags(token[2]));
        if (value) chunks.push(value);
        continue;
      }
      if (token[3]) {
        const value = decodeXmlText(stripTags(token[3]));
        if (value) chunks.push(value);
        continue;
      }
      if (/^<LINEBREAK/i.test(token[0])) {
        chunks.push("\n");
        continue;
      }
      if (/^<TAB/i.test(token[0])) {
        chunks.push(" ");
      }
    }
    const line = chunks.join(" ").replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();
    if (line) lines.push(line);
  }

  return lines.join("\n").replace(/\n{2,}/g, "\n").trim();
}

function extractHmlParagraphs(hml: string): HmlParagraph[] {
  const paragraphs = [...hml.matchAll(/<P\b[\s\S]*?<\/P>/gi)];
  const items: HmlParagraph[] = [];

  for (const para of paragraphs) {
    const block = para[0];
    let autonumNo: number | null = null;
    const chunks: string[] = [];
    const tokenMatches = block.matchAll(
      /<AUTONUM\b[^>]*\bNumber="([0-9]+)"[^>]*>|<CHAR[^>]*>([\s\S]*?)<\/CHAR>|<SCRIPT[^>]*>([\s\S]*?)<\/SCRIPT>|<LINEBREAK\s*\/>|<TAB\s*\/>/gi,
    );
    for (const token of tokenMatches) {
      if (token[1]) {
        const parsed = Number.parseInt(token[1], 10);
        if (Number.isFinite(parsed)) {
          autonumNo = parsed;
          chunks.push(`${parsed}) `);
        }
        continue;
      }
      if (token[2]) {
        const value = decodeXmlText(stripTags(token[2]));
        if (value) chunks.push(value);
        continue;
      }
      if (token[3]) {
        const value = decodeXmlText(stripTags(token[3]));
        if (value) chunks.push(value);
        continue;
      }
      if (/^<LINEBREAK/i.test(token[0])) {
        chunks.push("\n");
        continue;
      }
      if (/^<TAB/i.test(token[0])) {
        chunks.push(" ");
      }
    }
    const text = chunks.join(" ").replace(/[ \t]+/g, " ").replace(/\s+\n/g, "\n").trim();
    if (!text) continue;
    items.push({ text, autonumNo });
  }
  return items;
}

function removeEndnotes(hml: string) {
  return hml.replace(/<ENDNOTE(?:\s|>)[\s\S]*?<\/ENDNOTE>/gi, " ");
}

function isQuestionStartParagraph(item: HmlParagraph, options?: { relaxed?: boolean }) {
  const relaxed = Boolean(options?.relaxed);
  const text = item.text;
  const hasQuestionLabel = /\[문제\]/.test(text);
  const hasQuestionStyle =
    /(다음|확률|함수|경우의 수|옳은 것|구하시오|\?)/.test(text) &&
    !/\[정답\]|\[해설\]|빠른\s*정답|정답표/.test(text);
  if (item.autonumNo && hasQuestionLabel) return true;
  if (item.autonumNo && hasQuestionStyle && item.autonumNo <= 60) return true;
  if (relaxed && item.autonumNo && item.autonumNo <= 120 && item.text.length > 12) return true;
  if (/^([1-9][0-9]?)\)\s*\[문제\]/.test(text)) return true;
  return false;
}

function splitQuestions(plainText: string, options?: { relaxed?: boolean }): QuestionItem[] {
  const relaxed = Boolean(options?.relaxed);
  const normalized = plainText
    .replace(/\r/g, "\n")
    .replace(/([1-9][0-9]?)\s*(?:\)|\.|번)\s*/g, "\n$1) ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const matches = [
    ...normalized.matchAll(
      /(?:^|\n)\s*([1-9][0-9]?)\)\s*([\s\S]*?)(?=(?:\n\s*[1-9][0-9]?\)\s)|$)/g,
    ),
  ];
  return matches
    .map((item) => ({
      no: Number.parseInt(item[1] ?? "0", 10),
      text: (item[2] ?? "").replace(/\s+/g, " ").trim(),
    }))
    .filter(
      (item) =>
        item.no > 0 &&
        item.text.length > 8 &&
        (relaxed || /\[문제\]|구하시오|\?/.test(item.text)) &&
        !/빠른\s*정답|정답표/i.test(item.text) &&
        !/^\[정답\]/.test(item.text),
    );
}

function splitQuestionsFromParagraphs(paragraphs: HmlParagraph[], options?: { relaxed?: boolean }) {
  const relaxed = Boolean(options?.relaxed);
  const picked = paragraphs.filter((item) => !/빠른\s*정답|정답표/.test(item.text));
  const questions: QuestionItem[] = [];

  for (let i = 0; i < picked.length; i += 1) {
    const current = picked[i];
    if (!isQuestionStartParagraph(current, { relaxed })) continue;

    const inferredNo =
      current.autonumNo ??
      Number.parseInt((current.text.match(/^([1-9][0-9]?)\)/)?.[1] ?? "0"), 10);
    if (!inferredNo || inferredNo > 120) continue;

    const chunks: string[] = [current.text];
    for (let j = i + 1; j < picked.length; j += 1) {
      if (isQuestionStartParagraph(picked[j], { relaxed })) break;
      const line = picked[j].text;
      if (!line || /\[정답\]|\[해설\]/.test(line)) continue;
      chunks.push(line);
      if (chunks.join(" ").length > 1800) break;
    }
    const merged = chunks
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/^([1-9][0-9]?)\)\s*/, "")
      .trim();
    if (merged.length < (relaxed ? 14 : 20)) continue;

    if (!relaxed && !(/\[문제\]|구하시오|\?/.test(merged))) continue;
    questions.push({ no: inferredNo, text: merged });
  }

  const dedup = new Map<number, QuestionItem>();
  for (const item of questions) {
    if (!dedup.has(item.no)) {
      dedup.set(item.no, item);
    }
  }
  return [...dedup.values()].sort((a, b) => a.no - b.no);
}

function splitQuestionsFromAutonumBlocks(hml: string): QuestionItem[] {
  const bodyOnly = removeEndnotes(hml);
  const blockPattern =
    /<AUTONUM\b[^>]*\bNumber="([0-9]+)"[^>]*>[\s\S]*?(?=<AUTONUM\b[^>]*\bNumber="[0-9]+"|<\/SECTION>|$)/gi;
  const questions: QuestionItem[] = [];

  for (const match of bodyOnly.matchAll(blockPattern)) {
    const no = Number.parseInt(match[1] ?? "0", 10);
    if (!no || no > 120) continue;
    const block = match[0];
    const tokens = block.matchAll(
      /<CHAR[^>]*>([\s\S]*?)<\/CHAR>|<SCRIPT[^>]*>([\s\S]*?)<\/SCRIPT>|<LINEBREAK\s*\/>|<TAB\s*\/>/gi,
    );
    const parts: string[] = [];
    for (const token of tokens) {
      if (token[1]) {
        const text = decodeXmlText(stripTags(token[1]));
        if (text) parts.push(text);
        continue;
      }
      if (token[2]) {
        const text = decodeXmlText(stripTags(token[2]));
        if (text) parts.push(text);
        continue;
      }
      if (/^<LINEBREAK/i.test(token[0])) {
        parts.push("\n");
        continue;
      }
      if (/^<TAB/i.test(token[0])) {
        parts.push(" ");
      }
    }
    const merged = parts.join(" ").replace(/\s+/g, " ").trim();
    if (!merged || merged.length < 20) continue;
    if (/빠른\s*정답|정답표|\[정답\]|\[해설\]/.test(merged)) continue;
    questions.push({ no, text: merged });
  }

  const dedup = new Map<number, QuestionItem>();
  for (const item of questions) {
    if (!dedup.has(item.no)) dedup.set(item.no, item);
  }
  return [...dedup.values()].sort((a, b) => a.no - b.no);
}

function splitQuestionsFromParagraphKnownNumbers(paragraphs: HmlParagraph[], numbers: number[]) {
  const known = new Set(numbers.filter((n) => n > 0 && n <= 120));
  if (known.size === 0 || paragraphs.length === 0) return [] as QuestionItem[];

  const startPoints = paragraphs
    .map((p, idx) => ({ idx, no: p.autonumNo, text: p.text }))
    .filter((x) => x.no && known.has(x.no))
    .filter((x) => !/빠른\s*정답|정답표/.test(x.text));

  if (startPoints.length === 0) return [] as QuestionItem[];

  const dedupStart = new Map<number, number>();
  for (const start of startPoints) {
    if (!start.no) continue;
    if (!dedupStart.has(start.no) || start.idx < (dedupStart.get(start.no) ?? Number.MAX_SAFE_INTEGER)) {
      dedupStart.set(start.no, start.idx);
    }
  }
  const orderedStarts = [...dedupStart.entries()]
    .map(([no, idx]) => ({ no, idx }))
    .sort((a, b) => a.idx - b.idx);

  const out: QuestionItem[] = [];
  for (let i = 0; i < orderedStarts.length; i += 1) {
    const current = orderedStarts[i];
    const next = orderedStarts[i + 1];
    const segmentParas = paragraphs.slice(current.idx, next ? next.idx : paragraphs.length);
    const text = segmentParas
      .map((p) => p.text)
      .filter(Boolean)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length < 20) continue;
    if (!/[가-힣]/.test(text)) continue;
    if (/빠른\s*정답|정답표/.test(text)) continue;
    out.push({ no: current.no, text });
  }

  return out.sort((a, b) => a.no - b.no);
}

function splitQuestionsByKnownNumbers(plainText: string, numbers: number[]) {
  const normalized = plainText.replace(/\s+/g, " ").trim();
  const uniqueNumbers = [...new Set(numbers)].filter((n) => n > 0 && n <= 120).sort((a, b) => a - b);
  if (uniqueNumbers.length === 0 || !normalized) return [] as QuestionItem[];

  const markers: Array<{ no: number; idx: number; len: number }> = [];
  for (const no of uniqueNumbers) {
    const regex = new RegExp(`(^|\\s)${no}\\s*(?:\\)|\\.|번)\\s*`, "g");
    const match = regex.exec(normalized);
    if (!match || match.index === undefined) continue;
    markers.push({ no, idx: match.index, len: match[0].length });
  }
  markers.sort((a, b) => a.idx - b.idx);
  if (markers.length === 0) return [] as QuestionItem[];

  const questions: QuestionItem[] = [];
  for (let i = 0; i < markers.length; i += 1) {
    const current = markers[i];
    const next = markers[i + 1];
    const start = current.idx + current.len;
    const end = next ? next.idx : normalized.length;
    const raw = normalized.slice(start, end).replace(/\s+/g, " ").trim();
    if (raw.length < 15) continue;
    if (!/[가-힣]/.test(raw)) continue;
    if (/빠른\s*정답|정답표|\[정답\]|\[해설\]/.test(raw)) continue;
    questions.push({ no: current.no, text: raw });
  }

  return questions;
}

function splitQuestionsByHierarchy(paragraphs: HmlParagraph[], knownNumbers: number[]) {
  const picked = paragraphs.filter((item) => !/빠른\s*정답|정답표|\[정답\]|\[해설\]/.test(item.text));
  if (picked.length === 0) return [] as QuestionItem[];

  const known = new Set(knownNumbers.filter((n) => n > 0 && n <= 120));
  const starts: Array<{ idx: number; no: number }> = [];

  for (let i = 0; i < picked.length; i += 1) {
    const current = picked[i];
    const fromPrefix = current.text.match(/^([1-9][0-9]?)\s*(?:\)|\.|번)\s*/);
    const inferredNo = current.autonumNo ?? (fromPrefix ? Number.parseInt(fromPrefix[1], 10) : null);
    if (!inferredNo || inferredNo > 120) continue;
    if (known.size > 0 && !known.has(inferredNo)) continue;

    const hasQuestionSignal =
      /\[문제\]|구하시오|옳은 것|다음|확률|함수|\?/.test(current.text) ||
      /①|②|③|④|⑤/.test(current.text);
    if (!hasQuestionSignal) continue;
    starts.push({ idx: i, no: inferredNo });
  }

  if (starts.length === 0) return [] as QuestionItem[];

  const dedupStart = new Map<number, number>();
  for (const start of starts) {
    if (!dedupStart.has(start.no) || start.idx < (dedupStart.get(start.no) ?? Number.MAX_SAFE_INTEGER)) {
      dedupStart.set(start.no, start.idx);
    }
  }
  const ordered = [...dedupStart.entries()]
    .map(([no, idx]) => ({ no, idx }))
    .sort((a, b) => a.idx - b.idx);

  const out: QuestionItem[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const current = ordered[i];
    const next = ordered[i + 1];
    const segment = picked.slice(current.idx, next ? next.idx : picked.length);
    const merged = segment
      .map((p) => p.text)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^([1-9][0-9]?)\s*(?:\)|\.|번)\s*/, "")
      .trim();

    if (merged.length < 30) continue;
    if (!/[가-힣]/.test(merged)) continue;
    const hasChoiceBlock = /①|②|③|④|⑤/.test(merged);
    const hasQuestionSignal = /\[문제\]|구하시오|옳은 것|다음|확률|함수|\?/.test(merged);
    if (!hasChoiceBlock && !hasQuestionSignal) continue;
    out.push({ no: current.no, text: merged });
  }

  return out.sort((a, b) => a.no - b.no);
}

function parseManualQuestionSelection(input: string | null) {
  if (!input) return [] as number[];
  const text = input.trim();
  if (!text) return [] as number[];
  const out = new Set<number>();
  for (const token of text.split(",")) {
    const part = token.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) continue;
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      for (let n = from; n <= to && n <= 120; n += 1) out.add(n);
      continue;
    }
    const single = Number(part);
    if (Number.isFinite(single) && single > 0 && single <= 120) out.add(single);
  }
  return [...out].sort((a, b) => a - b);
}

function normalizeAnswerToken(value: string) {
  const token = value.trim().replace(/\s+/g, "");
  if (!token) return "";
  const circled = token.match(/[①②③④⑤]/)?.[0];
  if (circled) return circled;
  const numeric = token.match(/[1-5]/)?.[0];
  if (!numeric) return token;
  const map: Record<string, string> = {
    "1": "①",
    "2": "②",
    "3": "③",
    "4": "④",
    "5": "⑤",
  };
  return map[numeric] ?? token;
}

function parseAnswerFromSolution(text: string) {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith("[정답]"));
  if (!line) return "";
  const body = line.replace(/^\[정답\]\s*/i, "");
  const token = body.match(/[①②③④⑤]|[1-5]/)?.[0] ?? "";
  return normalizeAnswerToken(token);
}

function extractQuickAnswers(plainText: string) {
  const map = new Map<number, string>();
  const normalized = plainText
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n");
  const quickStart = normalized.search(/빠른\s*정답|정답표|정답/);
  if (quickStart === -1) return map;
  const segment = normalized.slice(quickStart, quickStart + 5000);
  const pattern = /([1-9][0-9]?)\s*(?:\)|\.|번|:)?\s*([①②③④⑤]|[1-5])/g;
  for (const item of segment.matchAll(pattern)) {
    const no = Number.parseInt(item[1] ?? "0", 10);
    const answer = normalizeAnswerToken(item[2] ?? "");
    if (no > 0 && answer) {
      map.set(no, answer);
    }
  }
  return map;
}

function extractQuickAnswersFromHmlRaw(hml: string) {
  const map = new Map<number, string>();
  const endnotes = [...hml.matchAll(/<ENDNOTE(?:\s|>)[\s\S]*?<\/ENDNOTE>/gi)];
  for (const note of endnotes) {
    const block = note[0];
    const noMatch = block.match(/<AUTONUM\b[^>]*\bNumber="([0-9]+)"/i);
    if (!noMatch) continue;
    const questionNo = Number.parseInt(noMatch[1] ?? "0", 10);
    if (!questionNo) continue;

    const answerToken =
      block.match(/\[정답\]\s*([①②③④⑤]|[1-5])/)?.[1] ??
      block.match(/<CHAR[^>]*>\s*([①②③④⑤]|[1-5])\s*<\/CHAR>/)?.[1] ??
      "";
    const normalized = normalizeAnswerToken(answerToken);
    if (normalized) {
      map.set(questionNo, normalized);
    }
  }
  return map;
}

function extractQuestionsFromEndnoteBlocks(hml: string, knownNumbers: number[]) {
  const endnotes = [...hml.matchAll(/<ENDNOTE(?:\s|>)[\s\S]*?<\/ENDNOTE>/gi)];
  const known = new Set(knownNumbers.filter((n) => n > 0 && n <= 120));
  const out: QuestionItem[] = [];

  for (const note of endnotes) {
    const block = note[0];
    const no = Number.parseInt(block.match(/<AUTONUM\b[^>]*\bNumber="([0-9]+)"/i)?.[1] ?? "0", 10);
    if (!no || no > 120) continue;
    if (known.size > 0 && !known.has(no)) continue;

    const tokens = [...block.matchAll(/<CHAR[^>]*>([\s\S]*?)<\/CHAR>|<SCRIPT[^>]*>([\s\S]*?)<\/SCRIPT>/gi)]
      .map((m) => decodeXmlText(stripTags(m[1] || m[2] || "")))
      .filter(Boolean);
    const merged = tokens.join(" ").replace(/\s+/g, " ").trim();
    if (!merged) continue;

    const choiceMatches = merged.match(/①[\s\S]*?(?=빠른\s*정답|$)/);
    const choiceText = choiceMatches ? choiceMatches[0].replace(/\s+/g, " ").trim() : "";
    const answerToken = normalizeAnswerToken(
      merged.match(/\[정답\]\s*([①②③④⑤]|[1-5])/)?.[1] ?? "",
    );
    const base = choiceText || merged;
    if (!/①|②|③|④|⑤/.test(base)) continue;

    const synthesized = `[문제] ${no}번 문항 원문 텍스트 일부가 누락되어 보기 중심으로 복원되었습니다.\n${base}\n[참고정답] ${answerToken || "미확인"}`;
    out.push({ no, text: synthesized });
  }

  const dedup = new Map<number, QuestionItem>();
  for (const item of out) {
    if (!dedup.has(item.no)) dedup.set(item.no, item);
  }
  return [...dedup.values()].sort((a, b) => a.no - b.no);
}

function validateExplanationFormat(text: string) {
  const answerMatch = text.match(/\[정답\]\s*([^\n\r]*)/i);
  const explanationMatch = text.match(/\[해설\]\s*([\s\S]+)/i);
  return Boolean(
    answerMatch &&
      explanationMatch &&
      answerMatch[1]?.trim() &&
      explanationMatch[1]?.trim(),
  );
}

function isLikelyTruncatedSolution(text: string) {
  const explanation = text.match(/\[해설\]\s*([\s\S]*)/i)?.[1]?.trim() ?? "";
  if (explanation.length < 50) return true;
  if (/[,:+\-*/=]$/.test(explanation)) return true;
  const openParen = (explanation.match(/[({\[]/g) ?? []).length;
  const closeParen = (explanation.match(/[)}\]]/g) ?? []).length;
  return openParen > closeParen;
}

function normalizeStudentMathText(value: string) {
  return value
    .replace(/\$\$?/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\binom\{([^}]+)\}\{([^}]+)\}/g, "$1C$2")
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "$1/$2")
    .replace(/\\sqrt\{([^}]+)\}/g, "√$1")
    .replace(/\\times|\\cdot/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\geq|\\ge/g, "≥")
    .replace(/\\leq|\\le/g, "≤")
    .replace(/\\neq/g, "≠")
    .replace(/\\pm/g, "±")
    .replace(/\\cdots|\\dots/g, "...")
    .replace(/\\alpha/g, "α")
    .replace(/\\beta/g, "β")
    .replace(/\\gamma/g, "γ")
    .replace(/\\theta/g, "θ")
    .replace(/\\,/g, " ")
    .replace(/\{([^{}]+)\}/g, "$1")
    .replace(/\\([A-Za-z]+)/g, "$1")
    .replace(/\r\n/g, "\n")
    .replace(/[ \f\v]+/g, " ")
    .trim();
}

function evaluateQuestionTextQuality(text: string): QuestionQualityInfo {
  const length = text.length;
  const scriptTokenCount = (text.match(/it_\{|smallprod|left\(|right\)|\{rm\{|\`/g) ?? []).length;
  const oddSymbolCount = (text.match(/[{}<>`$]/g) ?? []).length;
  const hasQuestionSignal = /\[문제\]|구하시오|\?/.test(text);
  let score = 100;

  if (length < 30) score -= 25;
  if (!hasQuestionSignal) score -= 20;
  if (scriptTokenCount >= 8) score -= 20;
  if (oddSymbolCount >= 20) score -= 15;
  if (scriptTokenCount >= 20) score -= 20;

  return { score, noisy: score < 65 };
}

function selectBestQuestions(primary: QuestionItem[], fallback: QuestionItem[]) {
  const map = new Map<number, QuestionItem>();
  const fallbackMap = new Map(fallback.map((item) => [item.no, item]));
  const notes: string[] = [];

  for (const item of primary) {
    const quality = evaluateQuestionTextQuality(item.text);
    if (!quality.noisy) {
      map.set(item.no, item);
      continue;
    }
    const alt = fallbackMap.get(item.no);
    if (alt) {
      const altQuality = evaluateQuestionTextQuality(alt.text);
      if (altQuality.score > quality.score) {
        map.set(item.no, alt);
        notes.push(`${item.no}번 문항: 문단 추출 노이즈로 평문 추출로 대체`);
        continue;
      }
    }
    map.set(item.no, item);
    notes.push(`${item.no}번 문항: 노이즈 가능성 유지`);
  }

  for (const item of fallback) {
    if (!map.has(item.no)) {
      map.set(item.no, item);
      notes.push(`${item.no}번 문항: 평문 대체 추출로 추가`);
    }
  }
  return {
    merged: [...map.values()].sort((a, b) => a.no - b.no),
    notes,
  };
}

async function generateSolutionForQuestion(
  client: GoogleGenerativeAI,
  questionNo: number,
  questionText: string,
  expectedAnswer?: string,
  profile: GenerationProfile = "normal",
) {
  const recoveredOnly = /원문 텍스트 일부가 누락되어 보기 중심으로 복원/.test(questionText);
  const compactQuestion =
    profile === "noisy"
      ? questionText
          .replace(/it_\{[^}]*\}/g, " ")
          .replace(/smallprod|left\(|right\)|\{rm\{|\`/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : questionText;
  const promptBase = [
    "중고등 수학 문제를 해설하라.",
    "수식은 LaTeX 표기(\\binom, \\frac 등)로 쓰지 말고 학생이 읽기 쉬운 일반 표기로 작성하라.",
    "조합은 반드시 nCk 표기(예: 10C3)로 작성하라.",
    "[해설] 본문 첫 줄에 문제 번호(예: 17.)를 다시 쓰지 마라.",
    "반드시 내부적으로 다음 순서로 수행: 1) 문제 풀이 2) 빠른정답 확정 3) 해설 작성.",
    "출력은 반드시 아래 형식:",
    "[정답] ...",
    "[해설]",
    "...",
    profile === "noisy"
      ? "문제 텍스트에 수식/태그 노이즈가 포함될 수 있다. 핵심 문장과 보기만 사용해 답을 구하라."
      : "",
    recoveredOnly
      ? "원문 본문이 일부 누락된 문항이다. 제공된 보기/숫자 정보만 근거로 풀이하고, 없는 조건은 추정하지 마라."
      : "",
    `문항 번호: ${questionNo}`,
    `[문제] ${compactQuestion}`,
  ];
  if (expectedAnswer) {
    promptBase.push(`빠른정답(검증용): ${expectedAnswer}`);
    promptBase.push("풀이를 먼저 수행하고, 계산 결과가 빠른정답과 일치하는지 검증한 뒤 출력하라.");
  }
  const prompt = promptBase.join("\n");

  const failures: string[] = [];
  const modelOrder =
    profile === "noisy"
      ? ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"]
      : [...MODEL_CANDIDATES];
  for (const modelName of modelOrder) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        generationConfig: {
          temperature: profile === "noisy" ? 0.1 : 0.2,
          maxOutputTokens: profile === "noisy" ? 1800 : 2200,
        },
      });
      const first = await model.generateContent([{ text: prompt }]);
      const text = first.response.text()?.trim() ?? "";
      const parsed = parseAnswerFromSolution(text);
      const answerMatches = expectedAnswer ? parsed === normalizeAnswerToken(expectedAnswer) : true;
      if (text && validateExplanationFormat(text) && answerMatches && !isLikelyTruncatedSolution(text)) {
        return { text, model: modelName };
      }
      const retryPrompt =
        profile === "noisy"
          ? [
              "노이즈가 섞인 문제였다. 핵심 문장과 숫자/보기를 기반으로만 다시 풀어라.",
              expectedAnswer
                ? `[정답]은 반드시 ${normalizeAnswerToken(expectedAnswer)} 로 맞춰라.`
                : "",
              "해설이 중간에 끊기지 않게 마지막 문장까지 완결해서 작성하라.",
              "[정답] 한 줄 + [해설] 본문 형식만 출력하라.",
            ]
              .filter(Boolean)
              .join(" ")
          : expectedAnswer
            ? `형식 또는 정답 검증이 실패했습니다. 반드시 [정답] 한 줄, [해설] 본문 형식으로 출력하고 [정답]은 ${normalizeAnswerToken(expectedAnswer)} 와 일치시켜라.`
            : "형식이 맞지 않았습니다. 반드시 [정답] 한 줄, [해설] 본문 형식으로만 다시 출력하세요. 해설은 중간에 끊기지 않게 완결하세요.";
      const retry = await model.generateContent([
        { text: prompt },
        {
          text: retryPrompt,
        },
      ]);
      const retryText = retry.response.text()?.trim() ?? "";
      const retryParsed = parseAnswerFromSolution(retryText);
      const retryMatches = expectedAnswer
        ? retryParsed === normalizeAnswerToken(expectedAnswer)
        : true;
      if (
        retryText &&
        validateExplanationFormat(retryText) &&
        retryMatches &&
        !isLikelyTruncatedSolution(retryText)
      ) {
        return { text: retryText, model: modelName };
      }
      failures.push(`${modelName}: 형식/정답 검증 실패`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 모델 호출 오류";
      failures.push(`${modelName}: ${message}`);
    }
  }
  throw new Error(`문항 ${questionNo} 해설 생성 실패: ${failures.join(" | ")}`);
}

async function extractQuestionsWithAi(
  client: GoogleGenerativeAI,
  plainText: string,
  quickAnswerNumbers: number[],
) {
  const model = client.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0.1, maxOutputTokens: 3000 },
  });
  const hint = quickAnswerNumbers.length > 0 ? `정답표 문항 번호 힌트: ${quickAnswerNumbers.join(",")}` : "";
  const payload = plainText.slice(0, 40000);
  const prompt = [
    "아래 텍스트에서 수학 문항을 추출하라.",
    "반드시 JSON 배열만 출력: [{\"no\":number,\"text\":string}]",
    "text는 문항 원문 핵심만, 20자 이상.",
    "정답표/해설/메타 문구는 제외.",
    "번호(no)는 1~120 정수.",
    hint,
    "[원문]",
    payload,
  ]
    .filter(Boolean)
    .join("\n");
  const res = await model.generateContent([{ text: prompt }]);
  const raw = res.response.text()?.trim() ?? "";
  const arr = extractJsonArray(raw);
  if (!arr) return [];
  return arr
    .map((item) => ({
      no: Number.parseInt(String((item as { no?: unknown }).no ?? "0"), 10),
      text: String((item as { text?: unknown }).text ?? "").replace(/\s+/g, " ").trim(),
    }))
    .filter((item) => item.no > 0 && item.no <= 120 && item.text.length >= 20)
    .slice(0, 30);
}

async function generateSolutionWithOpenAiFallback(
  questionNo: number,
  questionText: string,
  expectedAnswer?: string,
  profile: GenerationProfile = "normal",
) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY가 없어 GPT 백업 경로를 사용할 수 없습니다.");
  }

  const recoveredOnly = /원문 텍스트 일부가 누락되어 보기 중심으로 복원/.test(questionText);
  const compactQuestion =
    profile === "noisy"
      ? questionText
          .replace(/it_\{[^}]*\}/g, " ")
          .replace(/smallprod|left\(|right\)|\{rm\{|\`/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : questionText;

  const prompt = [
    "중고등 수학 문제를 해설하라.",
    "수식은 LaTeX 표기(\\binom, \\frac 등)로 쓰지 말고 학생이 읽기 쉬운 일반 표기로 작성하라.",
    "조합은 반드시 nCk 표기(예: 10C3)로 작성하라.",
    "[해설] 본문 첫 줄에 문제 번호(예: 17.)를 다시 쓰지 마라.",
    "반드시 내부적으로 다음 순서로 수행: 1) 문제 풀이 2) 빠른정답 확정 3) 해설 작성.",
    "출력은 반드시 아래 형식만 사용:",
    "[정답] ...",
    "[해설]",
    "...",
    profile === "noisy"
      ? "문제에 노이즈가 섞였으므로 핵심 문장/보기만으로 해석해 풀어라."
      : "",
    recoveredOnly
      ? "원문 본문 일부 누락 상태다. 제시된 보기/수치 정보만 사용하고, 없는 조건은 임의 가정하지 마라."
      : "",
    expectedAnswer ? `빠른정답(검증용): ${normalizeAnswerToken(expectedAnswer)}` : "",
    `문항 번호: ${questionNo}`,
    `[문제] ${compactQuestion}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-5.5-medium",
      messages: [{ role: "user", content: prompt }],
      temperature: profile === "noisy" ? 0.1 : 0.2,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GPT 백업 호출 실패: ${response.status} ${text}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text || !validateExplanationFormat(text) || isLikelyTruncatedSolution(text)) {
    throw new Error("GPT 백업 응답 형식이 올바르지 않습니다.");
  }
  const parsed = parseAnswerFromSolution(text);
  if (expectedAnswer && parsed !== normalizeAnswerToken(expectedAnswer)) {
    throw new Error("GPT 백업 응답이 빠른정답과 일치하지 않습니다.");
  }
  return { text, model: "gpt-5.5-medium" };
}

function buildDocx(
  originalTitle: string,
  items: GeneratedItem[],
) {
  const normalizeObjective = (value: string) =>
    value
      .trim()
      .replace("①", "1")
      .replace("②", "2")
      .replace("③", "3")
      .replace("④", "4")
      .replace("⑤", "5")
      .match(/^[1-5]$/)?.[0] ?? null;
  const getAnswerKind = (item: GeneratedItem) => {
    const objective = normalizeObjective(item.generatedAnswer || item.expectedAnswer || "");
    if (objective) return "objective" as const;
    const explain = item.solution.match(/\[해설\]\s*([\s\S]*)/i)?.[1] ?? "";
    if (
      /서술|논술|증명|설명하|과정을\s*쓰/.test(`${item.generatedAnswer} ${explain}`) ||
      (item.generatedAnswer || "").trim().length >= 24
    ) {
      return "essay" as const;
    }
    return "short" as const;
  };

  const quickEntries = items.map((item) => {
    const kind = getAnswerKind(item);
    const objective = normalizeObjective(item.generatedAnswer || item.expectedAnswer || "");
    const display =
      kind === "essay"
        ? "해설참고"
        : objective
          ? objective
          : (item.generatedAnswer || item.expectedAnswer || "?");
    return `${item.no}) ${display}`;
  });
  const quickRows: Paragraph[] = [];
  for (let i = 0; i < quickEntries.length; i += 2) {
    quickRows.push(
      new Paragraph({
        tabStops: [{ type: TabStopType.LEFT, position: 5200 }],
        children: [
          new TextRun({ text: quickEntries[i] ?? "", bold: true }),
          new TextRun({ text: "\t" }),
          new TextRun({ text: quickEntries[i + 1] ?? "", bold: true }),
        ],
        spacing: { after: 110 },
      }),
    );
  }

  const explanationChildren: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: "[해설]", bold: true })],
      spacing: { after: 180 },
    }),
  ];

  items.forEach((item) => {
    const kind = getAnswerKind(item);
    const objective = normalizeObjective(item.generatedAnswer || item.expectedAnswer || "");
    const quickAnswerText =
      kind === "essay"
        ? "해설참고"
        : objective
          ? objective
          : (item.generatedAnswer || item.expectedAnswer || "?");
    const lines = item.solution
      .split("\n")
      .map((line) => normalizeStudentMathText(line))
      .filter(Boolean);
    explanationChildren.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [
          new TextRun({
            text: `${item.no}) (${item.status === "verified" ? "검증완료" : item.status === "filled" ? "정답보완" : "불일치검토필요"})`,
            bold: true,
          }),
        ],
        spacing: { before: 160, after: 80 },
      }),
    );
    explanationChildren.push(
      new Paragraph({
        children: [new TextRun({ text: `[빠른정답] ${quickAnswerText}`, bold: true })],
        spacing: { after: 90 },
      }),
    );
    lines.forEach((line) => {
      const isKey = /^\[정답\]|\[해설\]/.test(line);
      explanationChildren.push(
        new Paragraph({
          children: [new TextRun({ text: line, bold: isKey })],
          spacing: { after: 100 },
        }),
      );
    });
  });

  return new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: `${originalTitle}(해설)`, bold: true })],
            spacing: { after: 220 },
          }),
          new Paragraph({
            children: [new TextRun({ text: "[빠른 정답]", bold: true })],
            spacing: { after: 100 },
          }),
          ...(quickRows.length > 0
            ? quickRows
            : [new Paragraph({ children: [new TextRun({ text: "추출/생성된 정답 없음" })] })]),
        ],
      },
      {
        properties: {
          type: SectionType.CONTINUOUS,
          column: {
            count: 2,
            space: 708,
          },
        },
        children: explanationChildren,
      },
    ],
  });
}

function evaluateParsingQuality(params: {
  questions: QuestionItem[];
  quickAnswerCount: number;
  mismatchCount: number;
}): ParsingQuality {
  const { questions, quickAnswerCount, mismatchCount } = params;
  const warnings: string[] = [];
  const denominator = quickAnswerCount > 0 ? quickAnswerCount : Math.max(questions.length, 1);
  const coverageRatio = questions.length / Math.max(1, denominator);
  const mismatchRatio = mismatchCount / Math.max(1, questions.length);

  if (questions.length < MIN_QUESTION_COUNT_FOR_PASS) {
    warnings.push(
      `추출 문항 수가 너무 적습니다(${questions.length}문항). 원본 형식 점검이 필요합니다.`,
    );
  }
  if (quickAnswerCount >= 10 && coverageRatio < MIN_COVERAGE_RATIO) {
    warnings.push(
      `문항 추출 커버리지가 낮습니다(${Math.round(coverageRatio * 100)}%). 정답표/문항 분리 규칙 재점검이 필요합니다.`,
    );
  }
  if (questions.length >= 5 && mismatchRatio > MAX_MISMATCH_RATIO) {
    warnings.push(
      `정답 불일치 비율이 높습니다(${Math.round(mismatchRatio * 100)}%). 추출 품질 또는 문제 해석 재검토가 필요합니다.`,
    );
  }

  return {
    pass: warnings.length === 0,
    warnings,
    coverageRatio,
    mismatchRatio,
  };
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY가 설정되지 않았습니다." }, { status: 500 });
    }

    const formData = await request.formData();
    const file = formData.get("hmlFile");
    const manualSelectionInputRaw = formData.get("manualQuestionSelection");
    const smokeFastRaw = formData.get("smokeFast");
    const modeRaw = formData.get("mode");
    const manualSelectionInput =
      typeof manualSelectionInputRaw === "string" ? manualSelectionInputRaw : null;
    const manualSelection = parseManualQuestionSelection(manualSelectionInput);
    const smokeFast = typeof smokeFastRaw === "string" && ["1", "true", "yes"].includes(smokeFastRaw.toLowerCase());
    const mode: HmlExecutionMode =
      typeof modeRaw === "string" && modeRaw === "auto_assist" ? "auto_assist" : "manual";
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "HML 파일이 필요합니다." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".hml")) {
      return NextResponse.json({ error: "확장자가 .hml 인 파일만 지원합니다." }, { status: 400 });
    }
    const sourceProfile = detectSourceProfile(file.name);

    const text = await file.text();
    const plain = extractHmlPlainText(text);
    const bodyOnlyHml = removeEndnotes(text);
    const bodyOnlyPlain = extractHmlPlainText(bodyOnlyHml);
    const paragraphs = extractHmlParagraphs(bodyOnlyHml);
    const paragraphQuestions = splitQuestionsFromParagraphs(paragraphs, { relaxed: true });
    const autonumBlockQuestions = splitQuestionsFromAutonumBlocks(text);
    const bodyFallbackQuestions = splitQuestions(bodyOnlyPlain, { relaxed: true });
    const fallbackQuestions = splitQuestions(plain, { relaxed: true });
    const betterFallback =
      bodyFallbackQuestions.length >= fallbackQuestions.length
        ? bodyFallbackQuestions
        : fallbackQuestions;
    const selected = sourceProfile === "core-request-set"
      ? {
          merged:
            betterFallback.length > 0
              ? betterFallback
              : paragraphQuestions.length > 0
                ? paragraphQuestions
                : autonumBlockQuestions,
          notes: ["대표 샘플 프로필 적용: 해설 확보 우선 경로 사용"],
        }
      : paragraphQuestions.length > 0
      ? selectBestQuestions(
          paragraphQuestions,
          autonumBlockQuestions.length > 0
            ? autonumBlockQuestions
            : betterFallback,
        )
      : autonumBlockQuestions.length > 0
        ? {
            merged: autonumBlockQuestions,
            notes: ["문단 추출 실패로 AUTONUM 블록 기반 구조 추출 사용"],
          }
        : {
            merged: betterFallback,
            notes: [
              bodyFallbackQuestions.length >= fallbackQuestions.length
                ? "문단 추출 실패로 본문(ENDNOTE 제외) 대체 추출 사용"
                : "문단 추출 실패로 전체 평문 대체 추출 사용(커버리지 우선)",
            ],
          };
    const questions = selected.merged.slice(0, 30);
    if (questions.length === 0) {
      const hint = plain.slice(0, 180).replace(/\n/g, " ");
      return NextResponse.json(
        {
          error:
            "문항 번호 패턴(1), 1., 1번)을 찾지 못했습니다. 원본 형식 확인이 필요합니다.",
          preview: hint,
        },
        { status: 400 },
      );
    }

    const quickAnswerMapFromRaw = extractQuickAnswersFromHmlRaw(text);
    const quickAnswerMap = quickAnswerMapFromRaw.size > 0 ? quickAnswerMapFromRaw : extractQuickAnswers(plain);

    const client = new GoogleGenerativeAI(apiKey);
    let aiExtractedQuestionCount = 0;
    let workingQuestions = questions;
    if (mode === "auto_assist") {
      const knownParagraphQuestions = splitQuestionsFromParagraphKnownNumbers(paragraphs, [...quickAnswerMap.keys()]);
      if (knownParagraphQuestions.length > workingQuestions.length) {
        workingQuestions = knownParagraphQuestions.slice(0, 30);
        selected.notes.push("문단 AUTONUM + 정답표 번호 결합 세그먼트 추출로 대체");
      }
      const knownNumberQuestions = splitQuestionsByKnownNumbers(plain, [...quickAnswerMap.keys()]);
      if (knownNumberQuestions.length > workingQuestions.length) {
        workingQuestions = knownNumberQuestions.slice(0, 30);
        selected.notes.push("정답표 번호 앵커 기반 세그먼트 추출로 대체");
      }
      const hierarchyQuestions = splitQuestionsByHierarchy(paragraphs, [...quickAnswerMap.keys()]);
      if (hierarchyQuestions.length > workingQuestions.length) {
        workingQuestions = hierarchyQuestions.slice(0, 30);
        selected.notes.push("태그 계층 기반 번호-본문-보기 결합 추출(3차)로 대체");
      }
      const endnoteQuestions = extractQuestionsFromEndnoteBlocks(text, [...quickAnswerMap.keys()]);
      if (endnoteQuestions.length > workingQuestions.length) {
        workingQuestions = endnoteQuestions.slice(0, 30);
        selected.notes.push("ENDNOTE 보기 기반 복원 추출(저품질 원문 보완)로 대체");
      }
      if (workingQuestions.length < 5 && quickAnswerMap.size >= 8) {
        const aiQuestions = await extractQuestionsWithAi(client, plain, [...quickAnswerMap.keys()].sort((a, b) => a - b));
        if (aiQuestions.length > workingQuestions.length) {
          workingQuestions = aiQuestions;
          aiExtractedQuestionCount = aiQuestions.length;
        }
      }
    }
    if (manualSelection.length > 0) {
      const selectedNos = new Set(manualSelection);
      workingQuestions = workingQuestions
        .filter((item) => selectedNos.has(item.no))
        .sort((a, b) => a.no - b.no);
      selected.notes.push(`수동 문항 선택 적용: ${manualSelection.join(", ")}`);
      if (workingQuestions.length === 0) {
        return NextResponse.json(
          {
            error: "수동 선택 번호와 일치하는 문항을 찾지 못했습니다. 번호 범위를 다시 확인해 주세요.",
            parsedQuestionNos: questions.map((item) => item.no),
          },
          { status: 400 },
        );
      }
    }
    if (smokeFast && workingQuestions.length > 8) {
      workingQuestions = workingQuestions.slice(0, 8);
      selected.notes.push("smokeFast 모드: 처리 문항 수를 8개로 제한");
    }
    const generated: GeneratedItem[] = [];
    let verifiedCount = 0;
    let filledCount = 0;
    let mismatchCount = 0;
    let openAiFallbackCount = 0;
    let noisyQuestionCount = 0;
    const hasAllQuickAnswers = workingQuestions.every((item) => quickAnswerMap.has(item.no));

    for (const question of workingQuestions) {
      const expected = quickAnswerMap.get(question.no);
      const quality = evaluateQuestionTextQuality(question.text);
      const profile: GenerationProfile = quality.noisy ? "noisy" : "normal";
      if (quality.noisy) noisyQuestionCount += 1;
      let result: { text: string; model: string };
      try {
        result = await generateSolutionForQuestion(
          client,
          question.no,
          question.text,
          expected,
          profile,
        );
      } catch (geminiError) {
        try {
          result = await generateSolutionWithOpenAiFallback(
            question.no,
            question.text,
            expected,
            profile,
          );
          openAiFallbackCount += 1;
          console.warn("Gemini 실패 후 GPT 백업 사용:", question.no, geminiError);
        } catch (openAiError) {
          const fallbackAnswer = normalizeAnswerToken(expected ?? "") || "?";
          generated.push({
            no: question.no,
            solution: `[정답] ${fallbackAnswer}\n[해설]\n모델 호출 실패로 자동 생성이 완료되지 않았습니다. 이 문항은 수동 검토가 필요합니다.`,
            generatedAnswer: fallbackAnswer,
            expectedAnswer: expected ? normalizeAnswerToken(expected) : null,
            status: expected ? "mismatch" : "filled",
          });
          if (expected) mismatchCount += 1;
          else filledCount += 1;
          selected.notes.push(
            `${question.no}번 문항: Gemini/GPT 백업 모두 실패하여 수동검토 표시로 대체`,
          );
          console.warn("Gemini/GPT 모두 실패:", question.no, geminiError, openAiError);
          continue;
        }
      }
      let parsed = parseAnswerFromSolution(result.text);

      if (expected && parsed !== normalizeAnswerToken(expected)) {
        try {
          result = await generateSolutionForQuestion(
            client,
            question.no,
            question.text,
            expected,
            profile,
          );
        } catch (retryGeminiError) {
          try {
            result = await generateSolutionWithOpenAiFallback(
              question.no,
              question.text,
              expected,
              profile,
            );
            openAiFallbackCount += 1;
            console.warn("정답 불일치 재시도에서 Gemini 실패 후 GPT 백업 사용:", question.no, retryGeminiError);
          } catch (openAiRetryError) {
            console.warn(
              "정답 불일치 재시도에서 Gemini/GPT 모두 실패, 기존 결과 유지:",
              question.no,
              retryGeminiError,
              openAiRetryError,
            );
          }
        }
        parsed = parseAnswerFromSolution(result.text);
      }

      if (expected && parsed === normalizeAnswerToken(expected)) {
        verifiedCount += 1;
        generated.push({
          no: question.no,
          solution: result.text,
          generatedAnswer: parsed,
          expectedAnswer: normalizeAnswerToken(expected),
          status: "verified",
        });
        continue;
      }

      if (expected && parsed !== normalizeAnswerToken(expected)) {
        mismatchCount += 1;
        generated.push({
          no: question.no,
          solution: result.text,
          generatedAnswer: parsed,
          expectedAnswer: normalizeAnswerToken(expected),
          status: "mismatch",
        });
        continue;
      }

      const filledAnswer = parsed || "?";
      quickAnswerMap.set(question.no, filledAnswer);
      filledCount += 1;
      generated.push({
        no: question.no,
        solution: result.text,
        generatedAnswer: filledAnswer,
        expectedAnswer: null,
        status: "filled",
      });
    }

    const title = safeName(path.parse(file.name).name);
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate(),
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
      now.getMinutes(),
    ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const outputName = `${title}_원본추가해설_${stamp}.docx`;

    const doc = buildDocx(title, generated);
    const buffer = await Packer.toBuffer(doc);
    const parsingQuality = evaluateParsingQuality({
      questions: workingQuestions,
      quickAnswerCount: smokeFast
        ? Math.min(quickAnswerMap.size, Math.max(workingQuestions.length, 1))
        : quickAnswerMap.size,
      mismatchCount,
    });
    const assistGuidance =
      mode === "auto_assist" &&
      (!parsingQuality.pass || mismatchCount > 0 || selected.notes.some((note) => note.includes("수동검토")))
        ? "자동 보조 경로 품질 이슈가 감지되었습니다. 수동 영역지정 모드로 재실행해 결과를 확정하세요."
        : null;
    const requiresManualReview = Boolean(assistGuidance);
    if (smokeFast) {
      return NextResponse.json({
        message: "smokeFast 점검 완료",
        smokeFast: true,
        mode,
        requiresManualReview,
        assistGuidance,
        questionCount: workingQuestions.length,
        quickAnswerMode: hasAllQuickAnswers ? "all_provided_verify" : "partial_fill_and_verify",
        quickAnswerStats: { verifiedCount, filledCount, mismatchCount },
        manualSelectionApplied: manualSelection.length > 0 ? manualSelection : null,
        parsingDiagnostics: {
          strategy: paragraphQuestions.length > 0 ? "paragraph-priority" : "plain-text-fallback",
          paragraphQuestionCount: paragraphQuestions.length,
          autonumBlockQuestionCount: autonumBlockQuestions.length,
          bodyFallbackQuestionCount: bodyFallbackQuestions.length,
          fallbackQuestionCount: fallbackQuestions.length,
          quickAnswerSource: quickAnswerMapFromRaw.size > 0 ? "hml-endnote" : "plain-text",
          sourceProfile,
          aiExtractedQuestionCount,
          openAiFallbackCount,
          noisyQuestionCount,
          notes: selected.notes.slice(0, 10),
        },
        parsingQuality,
      });
    }

    if (isGoogleDriveConfigured()) {
      await uploadCompletedDocx(buffer, outputName);
      return NextResponse.json({
        message: "원본 기반 해설 문서를 Drive 작업완료 폴더에 업로드했습니다.",
        mode,
        requiresManualReview,
        assistGuidance,
        fileName: outputName,
        questionCount: workingQuestions.length,
        quickAnswerMode: hasAllQuickAnswers ? "all_provided_verify" : "partial_fill_and_verify",
        quickAnswerStats: { verifiedCount, filledCount, mismatchCount },
        manualSelectionApplied: manualSelection.length > 0 ? manualSelection : null,
        parsingDiagnostics: {
          strategy: paragraphQuestions.length > 0 ? "paragraph-priority" : "plain-text-fallback",
          paragraphQuestionCount: paragraphQuestions.length,
          autonumBlockQuestionCount: autonumBlockQuestions.length,
          bodyFallbackQuestionCount: bodyFallbackQuestions.length,
          fallbackQuestionCount: fallbackQuestions.length,
          quickAnswerSource: quickAnswerMapFromRaw.size > 0 ? "hml-endnote" : "plain-text",
          sourceProfile,
          aiExtractedQuestionCount,
          openAiFallbackCount,
          noisyQuestionCount,
          notes: selected.notes.slice(0, 10),
        },
        parsingQuality,
      });
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const docxPath = path.join(OUTPUT_DIR, outputName);
    await fs.writeFile(docxPath, buffer);
    return NextResponse.json({
      message: "원본 기반 해설 문서를 작업 완료 폴더에 저장했습니다.",
      mode,
      requiresManualReview,
      assistGuidance,
      fileName: outputName,
      docxPath,
      questionCount: workingQuestions.length,
      quickAnswerMode: hasAllQuickAnswers ? "all_provided_verify" : "partial_fill_and_verify",
      quickAnswerStats: { verifiedCount, filledCount, mismatchCount },
      manualSelectionApplied: manualSelection.length > 0 ? manualSelection : null,
      parsingDiagnostics: {
        strategy: paragraphQuestions.length > 0 ? "paragraph-priority" : "plain-text-fallback",
        paragraphQuestionCount: paragraphQuestions.length,
        autonumBlockQuestionCount: autonumBlockQuestions.length,
        bodyFallbackQuestionCount: bodyFallbackQuestions.length,
        fallbackQuestionCount: fallbackQuestions.length,
        quickAnswerSource: quickAnswerMapFromRaw.size > 0 ? "hml-endnote" : "plain-text",
        sourceProfile,
        aiExtractedQuestionCount,
        openAiFallbackCount,
        noisyQuestionCount,
        notes: selected.notes.slice(0, 10),
      },
      parsingQuality,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: `원본 기반 해설 문서 생성 중 오류: ${message}` },
      { status: 500 },
    );
  }
}

