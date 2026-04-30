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
  TextRun,
} from "docx";
import { isGoogleDriveConfigured, uploadCompletedDocx } from "@/lib/googleDrive";

const OUTPUT_DIR = path.join(process.cwd(), "작업 완료");
const MODEL_CANDIDATES = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"] as const;

type QuestionItem = {
  no: number;
  text: string;
};

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

function extractHmlPlainText(hml: string) {
  const normalized = hml
    .replace(/<LINEBREAK\s*\/>/gi, "\n")
    .replace(/<\/P>/gi, "\n")
    .replace(/<\/(TABLE|ROW|CELL|SECTION)>/gi, "\n")
    .replace(/<TAB\s*\/>/gi, " ");

  const rawChars = [...normalized.matchAll(/<CHAR[^>]*>([\s\S]*?)<\/CHAR>/gi)].map((item) =>
    stripTags(item[1] ?? ""),
  );
  const rawScripts = [...normalized.matchAll(/<SCRIPT[^>]*>([\s\S]*?)<\/SCRIPT>/gi)].map((item) =>
    stripTags(item[1] ?? ""),
  );

  return [...rawChars, ...rawScripts]
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function splitQuestions(plainText: string): QuestionItem[] {
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
    .filter((item) => item.no > 0 && item.text.length > 8);
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

async function generateSolutionForQuestion(
  client: GoogleGenerativeAI,
  questionNo: number,
  questionText: string,
) {
  const prompt = [
    "중고등 수학 문제를 해설하라.",
    "출력은 반드시 아래 형식:",
    "[정답] ...",
    "[해설]",
    "...",
    `문항 번호: ${questionNo}`,
    `[문제] ${questionText}`,
  ].join("\n");

  const failures: string[] = [];
  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
      });
      const first = await model.generateContent([{ text: prompt }]);
      const text = first.response.text()?.trim() ?? "";
      if (text && validateExplanationFormat(text)) {
        return { text, model: modelName };
      }
      const retry = await model.generateContent([
        { text: prompt },
        {
          text: "형식이 맞지 않았습니다. 반드시 [정답] 한 줄, [해설] 본문 형식으로만 다시 출력하세요.",
        },
      ]);
      const retryText = retry.response.text()?.trim() ?? "";
      if (retryText && validateExplanationFormat(retryText)) {
        return { text: retryText, model: modelName };
      }
      failures.push(`${modelName}: 형식 불일치`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "알 수 없는 모델 호출 오류";
      failures.push(`${modelName}: ${message}`);
    }
  }
  throw new Error(`문항 ${questionNo} 해설 생성 실패: ${failures.join(" | ")}`);
}

function buildDocx(
  originalTitle: string,
  originalTextPreview: string,
  items: Array<{ no: number; solution: string }>,
) {
  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: `${originalTitle}(원본+해설)`, bold: true })],
      spacing: { after: 220 },
    }),
    new Paragraph({
      children: [new TextRun({ text: "[원본 문제(추출 미리보기)]", bold: true })],
      spacing: { after: 100 },
    }),
    new Paragraph({
      children: [new TextRun({ text: originalTextPreview })],
      spacing: { after: 280 },
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: "[해설]", bold: true })],
      spacing: { after: 180 },
    }),
  ];

  items.forEach((item) => {
    const lines = item.solution.split("\n").map((line) => line.trim()).filter(Boolean);
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [new TextRun({ text: `${item.no})`, bold: true })],
        spacing: { before: 160, after: 80 },
      }),
    );
    lines.forEach((line) => {
      const isKey = /^\[정답\]|\[해설\]/.test(line);
      children.push(
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
        properties: {
          column: {
            count: 2,
            space: 708,
          },
        },
        children,
      },
    ],
  });
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "GEMINI_API_KEY가 설정되지 않았습니다." }, { status: 500 });
    }

    const formData = await request.formData();
    const file = formData.get("hmlFile");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "HML 파일이 필요합니다." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".hml")) {
      return NextResponse.json({ error: "확장자가 .hml 인 파일만 지원합니다." }, { status: 400 });
    }

    const text = await file.text();
    const plain = extractHmlPlainText(text);
    const questions = splitQuestions(plain).slice(0, 30);
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

    const client = new GoogleGenerativeAI(apiKey);
    const generated: Array<{ no: number; solution: string }> = [];
    for (const question of questions) {
      const result = await generateSolutionForQuestion(client, question.no, question.text);
      generated.push({ no: question.no, solution: result.text });
    }

    const title = safeName(path.parse(file.name).name);
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate(),
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
      now.getMinutes(),
    ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    const outputName = `${title}_원본추가해설_${stamp}.docx`;

    const preview = questions
      .slice(0, 6)
      .map((item) => `${item.no}) ${item.text}`)
      .join("\n");
    const doc = buildDocx(title, preview, generated);
    const buffer = await Packer.toBuffer(doc);

    if (isGoogleDriveConfigured()) {
      await uploadCompletedDocx(buffer, outputName);
      return NextResponse.json({
        message: "원본 기반 해설 문서를 Drive 작업완료 폴더에 업로드했습니다.",
        fileName: outputName,
        questionCount: questions.length,
      });
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const docxPath = path.join(OUTPUT_DIR, outputName);
    await fs.writeFile(docxPath, buffer);
    return NextResponse.json({
      message: "원본 기반 해설 문서를 작업 완료 폴더에 저장했습니다.",
      fileName: outputName,
      docxPath,
      questionCount: questions.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: `원본 기반 해설 문서 생성 중 오류: ${message}` },
      { status: 500 },
    );
  }
}

