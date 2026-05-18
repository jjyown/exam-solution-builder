/**
 * scratch/verify-omml-capability.mts
 *
 * docx 패키지 v9.6.1 의 OMML 네이티브 클래스(Math/MathFraction/MathRun/MathRadical)
 * 출력 검증용 단순 더미 스크립트. 본 코드베이스 사용 이력 0건 (Grep 결과).
 *
 * PR-1 Commit 3 (latexToOmml.ts 변환기) 진입 전 viewer 호환 검증 게이트.
 * textbook-designer 학습 노트 룰 — "신규 capability 사용 이력 0건이면
 * 단순 검증 commit 1건 선행 의무".
 *
 * 실행:
 *   cd "c:\Users\mirun\Desktop\시험지 해설 제작\highroad-math-solution"
 *   npx tsx scratch/verify-omml-capability.mts
 *
 * 결과: scratch/verify-omml-output.docx 생성.
 *
 * viewer 게이트 (의뢰인 행위):
 *   - Word for Windows ★★★ (의뢰인 표준 viewer) — 통과 필수
 *   - Apple Pages ★★ — 권장 (Word 외 1개 이상 통과 필요)
 *   - LibreOffice 7.x ★ — 회귀 차이 발견 시 보고
 *   - 모바일 Word ★★ — 부수 확인
 *
 * 통과 시 Commit 3 진입. 실패 시 docx 라이브러리 버전 재확인 + 매핑 범위 축소 decision.
 */
import {
  Document,
  Math,
  MathFraction,
  MathRadical,
  MathRun,
  MathSuperScript,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 골든 패턴 3종 — 분수 / 루트 / 위첨자
const fractionExpr = new Math({
  children: [
    new MathRun("y = "),
    new MathFraction({
      numerator: [new MathRun("1")],
      denominator: [new MathRun("2")],
    }),
  ],
});

const radicalExpr = new Math({
  children: [
    new MathRun("z = "),
    new MathRadical({
      children: [new MathRun("x")],
    }),
  ],
});

const supExpr = new Math({
  children: [
    new MathRun("a = "),
    new MathSuperScript({
      children: [new MathRun("x")],
      superScript: [new MathRun("2")],
    }),
    new MathRun(" + 1"),
  ],
});

const doc = new Document({
  sections: [
    {
      children: [
        new Paragraph({
          children: [new TextRun({ text: "docx OMML capability 검증 (PR-1 Commit 2.5)", bold: true })],
        }),
        new Paragraph({
          children: [
            new TextRun(
              "아래 3종이 Word 의 네이티브 수식 (분수 / 루트 / 위첨자) 으로 깨끗하게 렌더되는지 시각 확인.",
            ),
          ],
        }),
        new Paragraph({ children: [new TextRun({ text: "1) 분수", bold: true })] }),
        new Paragraph({ children: [fractionExpr] }),
        new Paragraph({ children: [new TextRun({ text: "2) 루트", bold: true })] }),
        new Paragraph({ children: [radicalExpr] }),
        new Paragraph({ children: [new TextRun({ text: "3) 위첨자", bold: true })] }),
        new Paragraph({ children: [supExpr] }),
        new Paragraph({
          children: [
            new TextRun({
              text: "통과 기준: Word ★★★ + 비-Word 1개 이상 (Apple Pages / LibreOffice) 통과.",
              italics: true,
            }),
          ],
        }),
      ],
    },
  ],
});

const out = join(__dirname, "verify-omml-output.docx");
Packer.toBuffer(doc).then((buf) => {
  writeFileSync(out, buf);
  console.log(`[verify-omml] OK → ${out}`);
  console.log("[verify-omml] viewer 검증: Word + 비-Word 1개 이상 시각 확인 후 Commit 3 진입.");
});
