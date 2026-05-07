/**
 * referenceRetriever.ts
 * ────────────────────────────────────────────────────────────────────────────
 *  새로 들어온 문제와 가장 비슷한 수학비서 참고 예시를 K개 찾는 모듈.
 *  - 임베딩/벡터DB 없이도 충분히 동작 (수학 키워드 + 한국어 토큰 가중치)
 *  - 53~수천 개 규모 KB에 적합 (인메모리, 첫 호출 1회 로드)
 *
 *  사용법:
 *    const retriever = await ReferenceRetriever.fromJsonl('./reference/kb.jsonl');
 *    const top = retriever.search(questionText, 3);
 * ────────────────────────────────────────────────────────────────────────────
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ReferenceRecord {
  id: string;
  source: string;
  answer: string;
  problem_hint: string;
  content: string;
  equations: string[];
}

interface IndexedRecord extends ReferenceRecord {
  tokens: Set<string>;
  tokenFreq: Map<string, number>;
}

// 수학 도메인 키워드 (가중치 높음). 새 문제와 같은 단원/주제를 매칭하는 데 결정적.
const DOMAIN_TERMS = new Set([
  '함수', '미분', '적분', '극한', '수열', '급수', '확률', '통계', '벡터', '행렬',
  '삼각함수', '지수', '로그', '집합', '명제', '부등식', '방정식', '도형', '원',
  '직선', '곡선', '포물선', '쌍곡선', '타원', '원뿔', '구', '평면', '공간',
  '경우의수', '순열', '조합', '이항', '정규분포', '표본', '신뢰구간', '귀납',
  '점화식', '등차', '등비', '시그마', '연속', '미분가능', '극값', '최댓값', '최솟값',
  '변곡점', '접선', '법선', '넓이', '부피', '거리', '둘레', '반지름', '중심',
  '사인', '코사인', '탄젠트', '라디안', '주기', '진폭', '이차', '일차', '다항식',
  'sin', 'cos', 'tan', 'log', 'theta', 'lim', 'sqrt', 'sum', 'int',
]);

// 한국어 명사 추출 휴리스틱: 2~4글자 한글 토큰
function tokenize(text: string): string[] {
  if (!text) return [];
  const tokens: string[] = [];

  // 영문/수식 식별자
  const enRe = /[A-Za-z]{2,}/g;
  let m;
  while ((m = enRe.exec(text)) !== null) tokens.push(m[0].toLowerCase());

  // 한글 2~4글자 청크
  const koRe = /[가-힣]{2,4}/g;
  while ((m = koRe.exec(text)) !== null) tokens.push(m[0]);

  return tokens;
}

function buildTokenFreq(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokenize(text)) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return freq;
}

function score(query: Map<string, number>, doc: IndexedRecord, idf: Map<string, number>): number {
  let s = 0;
  for (const [tok, qf] of query) {
    const df = doc.tokenFreq.get(tok);
    if (!df) continue;
    const w = idf.get(tok) || 1;
    const domainBoost = DOMAIN_TERMS.has(tok) ? 2.0 : 1.0;
    s += qf * df * w * domainBoost;
  }
  // 길이 정규화 (긴 문서에 과도한 점수가 가지 않도록)
  return s / Math.sqrt(doc.tokens.size + 1);
}

export class ReferenceRetriever {
  private records: IndexedRecord[] = [];
  private idf = new Map<string, number>();

  static async fromJsonl(filePath: string): Promise<ReferenceRetriever> {
    const r = new ReferenceRetriever();
    const abs = path.resolve(filePath);
    const raw = await fs.promises.readFile(abs, 'utf-8');
    const records: ReferenceRecord[] = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ReferenceRecord);
    r.index(records);
    return r;
  }

  static fromRecords(records: ReferenceRecord[]): ReferenceRetriever {
    const r = new ReferenceRetriever();
    r.index(records);
    return r;
  }

  private index(records: ReferenceRecord[]): void {
    // 각 문서 토큰화
    this.records = records.map((rec) => {
      const docText = `${rec.problem_hint} ${rec.content}`;
      const freq = buildTokenFreq(docText);
      return { ...rec, tokens: new Set(freq.keys()), tokenFreq: freq };
    });

    // IDF 계산
    const N = this.records.length;
    const df = new Map<string, number>();
    for (const r of this.records) {
      for (const t of r.tokens) df.set(t, (df.get(t) || 0) + 1);
    }
    for (const [t, d] of df) {
      this.idf.set(t, Math.log((N + 1) / (d + 1)) + 1);
    }
  }

  /** 인덱스에 추가 학습 자료 합치기 (Drive 분석용 자료 폴더에서 가져온 자료 등) */
  addRecords(extra: ReferenceRecord[]): number {
    if (extra.length === 0) return 0;
    const merged: ReferenceRecord[] = [
      ...this.records.map(({ tokens, tokenFreq, ...clean }) => {
        void tokens;
        void tokenFreq;
        return clean;
      }),
      ...extra,
    ];
    this.index(merged);
    return extra.length;
  }

  search(queryText: string, k: number = 3): ReferenceRecord[] {
    const q = buildTokenFreq(queryText);
    const scored = this.records
      .map((r) => ({ r, s: score(q, r, this.idf) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k);
    // tokens, tokenFreq 제거 후 반환
    return scored.map(({ r }) => {
      const { tokens, tokenFreq, ...clean } = r;
      void tokens; void tokenFreq;
      return clean;
    });
  }

  size(): number {
    return this.records.length;
  }
}
