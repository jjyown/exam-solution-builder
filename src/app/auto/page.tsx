'use client';

/**
 * src/app/auto/page.tsx
 * ────────────────────────────────────────────────────────────────────────────
 *  "Cursor 없이도 돌아가는" 자동 라인의 사용자 UI.
 *  - 문제 텍스트 입력 → 한 번 누르면 retrieve→generate→validate→retry까지 처리
 *  - trace 패널로 어디서 막혔는지 즉시 확인 (Cursor 콘솔 의존 제거)
 *  - 결과 JSON은 그대로 다운로드 / 클립보드 복사 가능
 *  - DOCX 변환은 기존 examExplanationDocx.ts에 그대로 넘기면 됨
 * ────────────────────────────────────────────────────────────────────────────
 */
import { useState } from 'react';

interface PipelineResponse {
  ok: boolean;
  parsed: {
    answer: string;
    explanation_steps: { text: string; equation: string }[];
    summary?: string;
  } | null;
  attempts: number;
  errors: string[];
  trace: { stage: string; [k: string]: unknown }[];
}

export default function AutoPipelinePage() {
  const [questionText, setQuestionText] = useState('');
  const [model, setModel] = useState<'gemini' | 'openai'>('gemini');
  const [topK, setTopK] = useState(3);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PipelineResponse | null>(null);
  const [elapsed, setElapsed] = useState(0);

  async function run() {
    if (!questionText.trim()) return;
    setRunning(true);
    setResult(null);
    const t0 = performance.now();
    try {
      const res = await fetch('/api/auto-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionText, model, topK, maxRetries: 2 }),
      });
      const data = (await res.json()) as PipelineResponse;
      setResult(data);
    } catch (e) {
      setResult({
        ok: false,
        parsed: null,
        attempts: 0,
        errors: [(e as Error).message],
        trace: [],
      });
    } finally {
      setElapsed(Math.round(performance.now() - t0));
      setRunning(false);
    }
  }

  function downloadJson() {
    if (!result?.parsed) return;
    const blob = new Blob([JSON.stringify(result.parsed, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'explanation.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ maxWidth: 960, margin: '32px auto', padding: 16 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>해설 자동 생성 (Auto Pipeline)</h1>
      <p style={{ color: '#666', fontSize: 13, marginBottom: 24 }}>
        문제를 붙여넣고 「실행」을 누르면 수학비서 참고 예시 → LLM 생성 → 검증 → 자동 재시도까지 한 번에 진행됩니다.
        Cursor 거치지 않습니다.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 13 }}>모델</label>
        <select value={model} onChange={(e) => setModel(e.target.value as 'gemini' | 'openai')}>
          <option value="gemini">Gemini</option>
          <option value="openai">OpenAI</option>
        </select>
        <label style={{ fontSize: 13, marginLeft: 16 }}>참고 예시 수</label>
        <input
          type="number"
          min={1}
          max={6}
          value={topK}
          onChange={(e) => setTopK(Number(e.target.value))}
          style={{ width: 60 }}
        />
      </div>

      <textarea
        value={questionText}
        onChange={(e) => setQuestionText(e.target.value)}
        placeholder="새 문제를 여기에 붙여넣으세요 (수식은 LaTeX 또는 평문으로 OK)"
        rows={8}
        style={{
          width: '100%',
          padding: 12,
          fontFamily: 'monospace',
          fontSize: 13,
          border: '1px solid #ccc',
          borderRadius: 6,
        }}
      />

      <button
        onClick={run}
        disabled={running || !questionText.trim()}
        style={{
          marginTop: 12,
          padding: '10px 20px',
          background: running ? '#999' : '#111',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          cursor: running ? 'wait' : 'pointer',
        }}
      >
        {running ? '처리 중...' : '실행'}
      </button>

      {result && (
        <div style={{ marginTop: 24, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <h2 style={{ fontSize: 16 }}>결과 ({elapsed}ms, 시도 {result.attempts}회)</h2>
            {result.ok && result.parsed ? (
              <>
                <div style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, fontSize: 13 }}>
                  <div><b>정답:</b> {result.parsed.answer}</div>
                  <div style={{ marginTop: 8 }}>
                    <b>풀이 단계 ({result.parsed.explanation_steps.length}):</b>
                    <ol>
                      {result.parsed.explanation_steps.map((s, i) => (
                        <li key={i} style={{ marginBottom: 6 }}>
                          {s.text}
                          {s.equation && (
                            <div style={{ fontFamily: 'monospace', color: '#0066cc', fontSize: 12 }}>
                              {s.equation}
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                  {result.parsed.summary && (
                    <div style={{ marginTop: 8 }}>
                      <b>요약:</b> {result.parsed.summary}
                    </div>
                  )}
                </div>
                <button onClick={downloadJson} style={{ marginTop: 8 }}>
                  JSON 다운로드
                </button>
              </>
            ) : (
              <div style={{ background: '#ffe6e6', padding: 12, borderRadius: 6, fontSize: 13 }}>
                <b>실패:</b>
                <ul>{result.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              </div>
            )}
          </div>

          <div>
            <h2 style={{ fontSize: 16 }}>실행 로그 (Trace)</h2>
            <div
              style={{
                background: '#0b1220',
                color: '#cfe7ff',
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                fontFamily: 'monospace',
                maxHeight: 400,
                overflowY: 'auto',
              }}
            >
              {result.trace.map((t, i) => (
                <div key={i}>{JSON.stringify(t)}</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
