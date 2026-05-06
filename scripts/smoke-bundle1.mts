/**
 * scripts/smoke-bundle1.mts
 * ────────────────────────────────────────────────────────────────────────────
 *  묶음 1(파일 처리) 스모크 테스트.
 *  외부 API 키 없이도 단위·정합성 검증을 끝까지 진행한다.
 *
 *  사용:
 *    npx tsx scripts/smoke-bundle1.mts
 *
 *  검사:
 *   1) extractQuestionsFromText — 합성 한국 시험지 텍스트
 *   2) splitChoices — 보기 분리
 *   3) extractTextFromUploadedFile — 잘못된 입력 → 에러 경로
 *   4) (선택) PDF buffer 입력 — public 또는 첨부 PDF가 있으면
 *   5) 실패하지 않고 종료 시 exit 0
 * ────────────────────────────────────────────────────────────────────────────
 */
// tsx + bundler 모듈 해석 이슈 회피: dynamic import
const { extractQuestionsFromText, splitChoices } = await import("../src/lib/questionSplit.ts");
const { extractTextFromUploadedFile } = await import("../src/lib/fileExtraction.ts");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: unknown, label: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

// ─── 1. extractQuestionsFromText: 표준 패턴 ────────────────────────────────
console.log("\n[1] extractQuestionsFromText — 표준 패턴");
{
  const text = `
1. 다음 부등식의 해를 구하시오.
   x^2 - 5x + 6 < 0

2. 함수 f(x) = 2x + 3 에 대하여 f(5)의 값은?
   ① 11  ② 13  ③ 15  ④ 17  ⑤ 19

3. [3점] 다음 식을 인수분해하시오.
   x^3 - 8

4번  log_2 8 의 값은?

(5) 등비수열 {a_n} 에서 a_1 = 2, 공비 r = 3 일 때 a_4 = ?
`;
  const out = extractQuestionsFromText(text);
  assert(out.length === 5, `5개 문항 인식 (실제 ${out.length})`);
  assert(out[0]?.number === 1, "첫 문항 번호 1");
  assert(out[1]?.number === 2 && out[1]?.content.includes("①"), "2번 본문에 보기 ①");
  assert(out[2]?.number === 3 && out[2]?.points === 3, "3번 [3점] 인식");
  assert(out[3]?.number === 4, "4번 인식 (`4번`)");
  assert(out[4]?.number === 5, "5번 인식 (`(5)`)");
}

// ─── 2. extractQuestionsFromText: 노이즈 제거 ─────────────────────────────
console.log("\n[2] extractQuestionsFromText — 노이즈/단조 증가 필터");
{
  const text = `
1. 첫 번째 문제 본문. 이전 풀이에서 3번을 시도했다고 가정.
2. 두 번째 문제 본문.
이전에 7번 정답이 4였다.
3. 세 번째 문제.
`;
  const out = extractQuestionsFromText(text);
  assert(out.length === 3, `3개 문항만 인식 (실제 ${out.length}, 본문 안 "3번 시도"·"7번 정답" 무시)`);
  assert(
    out.every((q, i) => q.number === i + 1),
    "번호 1, 2, 3 순차",
  );
}

// ─── 3. extractQuestionsFromText: 빈 입력 ─────────────────────────────────
console.log("\n[3] extractQuestionsFromText — 빈/짧은 입력");
{
  assert(extractQuestionsFromText("").length === 0, "빈 문자열 → []");
  assert(extractQuestionsFromText("   ").length === 0, "공백만 → []");
  assert(extractQuestionsFromText("이건 그냥 텍스트입니다.").length === 0, "번호 없는 텍스트 → []");
}

// ─── 4. splitChoices ───────────────────────────────────────────────────────
console.log("\n[4] splitChoices — 보기 분리");
{
  const content = "다음 중 옳은 것은? ① 첫째 ② 둘째 ③ 셋째 ④ 넷째 ⑤ 다섯째";
  const r = splitChoices(content);
  assert(r.choices.length === 5, `5개 보기 (실제 ${r.choices.length})`);
  assert(r.stem.includes("옳은 것은"), "stem에 본문 포함");
  assert(r.choices[0] === "첫째", "보기 1 = '첫째'");
  assert(r.choices[4] === "다섯째", "보기 5 = '다섯째'");
}

{
  const r = splitChoices("보기 없는 단답형 문제");
  assert(r.choices.length === 0 && r.stem === "보기 없는 단답형 문제", "보기 없으면 choices=[]");
}

// ─── 5. extractTextFromUploadedFile — 에러 경로 ───────────────────────────
console.log("\n[5] extractTextFromUploadedFile — 입력 검증");
{
  const r = await extractTextFromUploadedFile({
    fileData: "deadbeef",
    fileName: "test.txt",
    fileType: "text/plain",
  });
  assert(r.ok === false, "지원하지 않는 형식 → ok=false");
  if (!r.ok) assert(r.error.includes("지원하지 않는"), `에러 메시지: ${r.error}`);
}

// ─── 6. extractTextFromUploadedFile — 이미지 (Mathpix 키 없는 환경) ───────
console.log("\n[6] extractTextFromUploadedFile — 이미지 OCR 키 누락 안내");
{
  // 작은 1x1 PNG의 base64
  const tinyPng =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
  const r = await extractTextFromUploadedFile({
    fileData: tinyPng,
    fileName: "tiny.png",
    fileType: "image/png",
  });
  if (!process.env.MATHPIX_APP_ID || !process.env.MATHPIX_APP_KEY) {
    assert(r.ok === false, "Mathpix 키 없으면 ok=false");
    if (!r.ok) assert(r.error.includes("MATHPIX"), `안내 메시지: ${r.error}`);
  } else {
    console.log("  (Mathpix 키 있음 — 실제 호출 결과:", r.ok ? `text len ${r.text.length}` : r.error, ")");
  }
}

// ─── 7. extractTextFromUploadedFile — PDF (잘못된 base64) ─────────────────
console.log("\n[7] extractTextFromUploadedFile — 잘못된 PDF 파싱 실패 경로");
{
  const r = await extractTextFromUploadedFile({
    fileData: "bm90IGEgcGRm", // "not a pdf"
    fileName: "fake.pdf",
    fileType: "application/pdf",
  });
  assert(r.ok === false, "잘못된 PDF → ok=false");
  if (!r.ok) console.log(`  (실패 메시지: ${r.error.slice(0, 100)}…)`);
}

// ─── 8. extractTextFromUploadedFile — 진짜 작은 PDF ───────────────────────
console.log("\n[8] extractTextFromUploadedFile — 최소 PDF (텍스트 레이어)");
{
  // 진짜 간단한 PDF 1.4 문서 (1페이지, 텍스트 "Hello 1. 첫문제 2. 둘째문제")
  // 동적으로 생성하기보다 미리 만들어진 base64를 박아둠 (바이너리는 jspdf 등 필요)
  // 여기서는 jspdf 동적 import로 PDF 생성
  try {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF();
    doc.setFont("courier"); // 한글은 jspdf 기본 폰트로 안 되므로 영문/숫자만
    doc.text("Sample Exam", 20, 20);
    doc.text("1. First problem body here.", 20, 40);
    doc.text("2. Second problem body here.", 20, 60);
    doc.text("3. Third problem body here.", 20, 80);
    const arrayBuf = doc.output("arraybuffer");
    const base64 = Buffer.from(arrayBuf).toString("base64");

    const r = await extractTextFromUploadedFile({
      fileData: base64,
      fileName: "sample.pdf",
      fileType: "application/pdf",
    });
    assert(r.ok === true, "최소 PDF 추출 성공");
    if (r.ok) {
      assert(r.source === "pdf-text", `source = pdf-text (실제 ${r.source})`);
      assert(r.text.includes("First problem"), "본문에 'First problem' 포함");
      const split = extractQuestionsFromText(r.text);
      assert(split.length === 3, `문항 분리 3개 (실제 ${split.length})`);
    } else {
      console.log(`  (PDF 추출 실패: ${r.error})`);
    }
  } catch (e) {
    console.log(`  ⚠ jspdf 임포트 실패 — 이 단계 건너뜀: ${(e as Error).message}`);
  }
}

// ─── 결과 ──────────────────────────────────────────────────────────────────
console.log("\n────────────────────────────────────────");
console.log(`결과: ${passed} 통과 / ${failed} 실패`);
if (failed > 0) {
  console.log("\n실패한 항목:");
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
process.exit(0);
