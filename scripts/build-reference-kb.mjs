/**
 * build-reference-kb.mjs
 * ────────────────────────────────────────────────────────────────────────────
 *  수학비서 HML 파일들을 파싱해서 "참고용 지식베이스(JSONL)"로 변환합니다.
 *  - 각 문항을 { answer, explanation, problem, equations[], hash } 로 추출
 *  - LLM이 새 문제를 풀 때 few-shot 예시로 사용 (논리·아이디어 참고용)
 *
 *  사용법:
 *    node scripts/build-reference-kb.mjs <hml_dir_or_file> [out.jsonl]
 *
 *  예:
 *    node scripts/build-reference-kb.mjs ./수학비서_자료 ./reference/kb.jsonl
 * ────────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── HML 파싱: 본문을 읽기 순서대로 [TEXT|EQUATION|PICTURE] 시퀀스로 평탄화 ──
function flattenHml(content) {
  const re =
    /<CHAR[^>]*>([^<]+)<\/CHAR>|<EQUATION[^>]*>[\s\S]*?<SCRIPT>([\s\S]*?)<\/SCRIPT>[\s\S]*?<\/EQUATION>|<PICTURE[^>]*>/g;
  const items = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) items.push({ t: 'T', v: decodeXml(m[1]) });
    else if (m[2] !== undefined) items.push({ t: 'E', v: m[2].trim() });
    else items.push({ t: 'P', v: '[FIGURE]' });
  }
  return items;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ── 시퀀스를 "[정답]/[해설]+문제본문" 단위로 분할 ──
//    수학비서 패턴: 한 문항이 "[정답] X [해설] ... <문제설명>" 으로 끝남.
//    본문/해설을 완벽히 분리하기보다, 한 문항을 하나의 "참고 예시"로 묶어 보관한다.
//    LLM 참고용으로는 이 형태가 더 풍부하다 (논리·아이디어·결론 흐름이 살아있음).
function splitProblems(items) {
  const stream = items
    .map((it) =>
      it.t === 'T' ? it.v : it.t === 'E' ? `\u0001${it.v}\u0001` : '\u0002IMG\u0002'
    )
    .join('');

  // [정답] 위치들로 청크 분리
  const chunks = [];
  const ANSWER_RE = /\[정답\]/g;
  const positions = [];
  let m;
  while ((m = ANSWER_RE.exec(stream)) !== null) positions.push(m.index);

  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : stream.length;
    chunks.push(stream.slice(start, end));
  }

  const problems = [];
  for (const c of chunks) {
    const mAns = c.match(/^\[정답\]\s*([\s\S]*?)\[해설\]/);
    if (!mAns) continue;

    const body = c.slice(mAns[0].length); // [해설] 이후의 본문 = "해설 + 문제설명"
    const answer = cleanText(mAns[1]);

    // 문제 본문(=마지막 1~3문장) 추출:
    //   "구하시오./값은?/것은?/구하여라." 위치를 끝점으로,
    //   거기서 거꾸로 ~300자 이내의 "문장 시작점"을 찾는다.
    const problemHint = extractProblemHint(body);

    problems.push({
      answer,
      content: cleanText(body),         // 해설+문제 통합 (LLM 참고용 풀 컨텍스트)
      problem_hint: problemHint,        // 문제 핵심 1~2 문장 (검색·매칭용)
      equations: extractEquations(c),
    });
  }
  return problems;
}

// 본문 끝의 "문제 부분"을 마지막 문장 단위로 잘라낸다.
// 완벽 분리는 어렵지만, 검색·매칭용으로는 마지막 ~250자가 충분히 유용하다.
function extractProblemHint(body) {
  const ENDERS = [/구하시오\s*\.?/g, /값은\?/g, /것은\?/g, /구하여라\s*\.?/g];
  let endPos = -1;
  for (const re of ENDERS) {
    let mm;
    while ((mm = re.exec(body)) !== null) {
      const e = mm.index + mm[0].length;
      if (e > endPos) endPos = e;
    }
  }
  if (endPos < 0) return cleanText(body.slice(-250));

  // 끝점에서 250자 이전 또는 직전 문장 종결("이다." / "있다." / "하자." / "한다.") 위치를 시작점으로
  const window = body.slice(Math.max(0, endPos - 350), endPos);
  const SENT_END = /(이다|있다|하자|한다|보자)\s*\.\s*/g;
  let lastBreak = -1;
  let mm;
  while ((mm = SENT_END.exec(window)) !== null) {
    lastBreak = mm.index + mm[0].length;
  }
  const sliceStart =
    lastBreak >= 0
      ? Math.max(0, endPos - 350) + lastBreak
      : Math.max(0, endPos - 250);
  return cleanText(body.slice(sliceStart, endPos));
}

function cleanText(s) {
  return s
    .replace(/\u0001([^\u0001]*)\u0001/g, ' $$$$$1$$$$ ') // \u0001..\u0001 -> $$..$$
    .replace(/\u0002IMG\u0002/g, ' [그림] ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEquations(c) {
  const eqs = [];
  const re = /\u0001([^\u0001]*)\u0001/g;
  let m;
  while ((m = re.exec(c)) !== null) eqs.push(m[1].trim());
  return eqs;
}

// ── 입력 처리 ──
function collectHmlFiles(p) {
  const stat = fs.statSync(p);
  if (stat.isFile()) return p.endsWith('.hml') ? [p] : [];
  const out = [];
  for (const name of fs.readdirSync(p)) {
    const full = path.join(p, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...collectHmlFiles(full));
    else if (name.endsWith('.hml')) out.push(full);
  }
  return out;
}

function hashStr(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

// ── 메인 ──
function main() {
  const inPath = process.argv[2];
  const outPath = process.argv[3] || './reference/kb.jsonl';
  if (!inPath) {
    console.error(
      'Usage: node scripts/build-reference-kb.mjs <hml_dir_or_file> [out.jsonl]'
    );
    process.exit(1);
  }

  const files = collectHmlFiles(inPath);
  if (!files.length) {
    console.error('No .hml files found at', inPath);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const outStream = fs.createWriteStream(outPath, { encoding: 'utf-8' });

  let total = 0;
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf-8');
    const items = flattenHml(content);
    const problems = splitProblems(items);
    for (const p of problems) {
      // 비어있거나 너무 짧은 항목 제외
      if (!p.content || p.content.length < 30) continue;
      const record = {
        id: hashStr(f + '|' + p.answer + '|' + p.content.slice(0, 100)),
        source: path.basename(f),
        answer: p.answer,
        problem_hint: p.problem_hint,
        content: p.content,
        equations: p.equations,
      };
      outStream.write(JSON.stringify(record) + '\n');
      total++;
    }
    console.log(
      `✓ ${path.basename(f)}: ${problems.length} problems detected`
    );
  }
  outStream.end();
  console.log(`\n📚 ${total} reference records written → ${outPath}`);
}

main();
