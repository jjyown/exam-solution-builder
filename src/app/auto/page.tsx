'use client';

/**
 * src/app/auto/page.tsx
 * ────────────────────────────────────────────────────────────────────────────
 *  자동 해설 파이프라인 메인 UI (Railway 배포 진입점).
 *
 *  Cursor 채팅이 하던 일을 모두 화면 안에서:
 *    - 입력(문제/이미지) → 자동 검색·생성·검증·재시도
 *    - Trace 패널: 어디서 막혔는지 즉시 표시
 *    - 수동 검수 체크리스트: 사람이 봐야 할 부분만 골라 노출
 *    - 재시도 버튼 / 모델 토글 / 별점 + 피드백 영속화
 *    - 최근 실행 이력 (Supabase 영속화 시)
 * ────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useState } from 'react';

type ParsedExplanation = {
  answer: string;
  explanation_steps: { text: string; equation: string }[];
  summary?: string;
};

type TraceEvent = { stage: string; [k: string]: unknown };

type PipelineResponse = {
  ok: boolean;
  parsed: ParsedExplanation | null;
  attempts: number;
  errors: string[];
  trace: TraceEvent[];
  manualReviewChecklist: string[];
  runId: string | null;
};

type RunHistoryRow = {
  id: string;
  created_at: string;
  exam_name: string | null;
  question_no: string | null;
  question_text: string;
  model: string;
  ok: boolean;
  attempts: number;
  user_rating: number | null;
  reviewed_at: string | null;
};

export default function AutoPipelinePage() {
  const [questionText, setQuestionText] = useState('');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [explanationMode, setExplanationMode] = useState<'full' | 'partial'>('full');
  const [selectedQuestions, setSelectedQuestions] = useState<number[]>([]);
  const [model, setModel] = useState<'gemini' | 'openai'>('gemini');
  const [topK, setTopK] = useState(3);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PipelineResponse | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [examName, setExamName] = useState('');
  const [questionNo, setQuestionNo] = useState('');
  const [model, setModel] = useState<'gemini' | 'openai'>('gemini');
  const [topK, setTopK] = useState(3);
  const [maxRetries, setMaxRetries] = useState(2);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PipelineResponse | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [showTrace, setShowTrace] = useState(false);

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && (file.type === 'application/pdf' || file.type.startsWith('image/'))) {
      setUploadedFile(file);
      setQuestionText(''); // 파일 업로드 시 텍스트 입력 초기화
    }
  }, []);

  const handleQuestionSelect = useCallback((questionIndex: number) => {
    setSelectedQuestions(prev =>
      prev.includes(questionIndex)
        ? prev.filter(i => i !== questionIndex)
        : [...prev, questionIndex]
    );
  }, []);

  const convertFileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // data:image/jpeg;base64, 부분 제거
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // 피드백
  const [rating, setRating] = useState<number | null>(null);
  const [feedbackNote, setFeedbackNote] = useState('');
  const [feedbackSaving, setFeedbackSaving] = useState(false);
  const [feedbackSaved, setFeedbackSaved] = useState(false);

  // 이력
  const [history, setHistory] = useState<RunHistoryRow[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-pipeline/feedback?limit=20');
      const data = await res.json();
      if (data.ok && Array.isArray(data.runs)) setHistory(data.runs);
    } catch {
      /* Supabase 미설정 시 그냥 비워둔다 */
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function run() {
    if (!questionText.trim() && !uploadedFile) return;
    setRunning(true);
    setResult(null);
    setRating(null);
    setFeedbackNote('');
    setFeedbackSaved(false);
    const t0 = performance.now();

    try {
      let requestBody: any = {
        examName: examName || undefined,
        questionNo: questionNo || undefined,
        model,
        topK,
        maxRetries,
      };

      if (uploadedFile) {
        // 파일 업로드 모드
        const fileData = await convertFileToBase64(uploadedFile);
        requestBody = {
          ...requestBody,
          fileData,
          fileName: uploadedFile.name,
          fileType: uploadedFile.type,
          explanationMode,
          selectedQuestions: explanationMode === 'partial' ? selectedQuestions : undefined,
        };
      } else {
        // 텍스트 입력 모드
        requestBody.questionText = questionText;
      }

      const res = await fetch('/api/auto-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
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
        manualReviewChecklist: [],
        runId: null,
      });
    } finally {
      setElapsed(Math.round(performance.now() - t0));
      setRunning(false);
      loadHistory();
    }
  }

  async function retry() {
    await run();
  }

  async function saveFeedback() {
    if (!result?.runId) return;
    setFeedbackSaving(true);
    try {
      const res = await fetch('/api/auto-pipeline/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: result.runId,
          userRating: rating ?? undefined,
          userFeedback: feedbackNote || undefined,
        }),
      });
      const data = await res.json();
      setFeedbackSaved(!!data.ok);
    } finally {
      setFeedbackSaving(false);
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
    a.download = `${examName || 'explanation'}_${questionNo || 'q'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyAsMarkdown() {
    if (!result?.parsed) return;
    const md = renderAsMarkdown(result.parsed, examName, questionNo);
    void navigator.clipboard.writeText(md);
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">하이로드 수학 해설 자동 생성</h1>
          <p className="mt-1 text-sm text-slate-600">
            문제 입력 → 검색 · 생성 · 검증 · 자동 재시도 → 검수 체크리스트.
            결과는 Supabase에 기록되며 사용자 피드백이 다음 호출에 반영됩니다.
          </p>
        </div>
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          최근 이력 {historyOpen ? '닫기' : '열기'} ({history.length})
        </button>
      </header>

      {historyOpen && (
        <HistoryPanel rows={history} onPick={(row) => { setQuestionText(row.question_text); setExamName(row.exam_name ?? ''); setQuestionNo(row.question_no ?? ''); }} />
      )}

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
        {/* 입력 */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 grid grid-cols-2 gap-3">
            <label className="block text-xs font-semibold text-slate-700">
              시험 이름
              <input
                type="text"
                value={examName}
                onChange={(e) => setExamName(e.target.value)}
                placeholder="예: 2026 모의고사 1회"
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal"
              />
            </label>
            <label className="block text-xs font-semibold text-slate-700">
              문항 번호
              <input
                type="text"
                value={questionNo}
                onChange={(e) => setQuestionNo(e.target.value)}
                placeholder="예: 17"
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm font-normal"
              />
            </label>
          </div>

          <label className="block text-xs font-semibold text-slate-700">
            문제 본문
            <textarea
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              placeholder="문제를 붙여넣으세요. 수식은 LaTeX 또는 평문 모두 허용."
              rows={9}
              className="mt-1 w-full rounded-md border border-slate-300 p-3 font-mono text-sm font-normal"
              disabled={!!uploadedFile}
            />
          </label>

          {/* 파일 업로드 */}
          <div className="mt-3">
            <label className="block text-xs font-semibold text-slate-700 mb-2">
              또는 PDF/이미지 파일 업로드
            </label>
            <input
              type="file"
              accept=".pdf,image/*"
              onChange={handleFileUpload}
              className="block w-full text-sm text-slate-500 file:mr-4 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
              disabled={!!questionText.trim()}
            />
            {uploadedFile && (
              <p className="mt-1 text-xs text-green-600">
                ✓ {uploadedFile.name} ({(uploadedFile.size / 1024 / 1024).toFixed(1)}MB)
              </p>
            )}
          </div>

          {/* 해설 모드 선택 */}
          {uploadedFile && (
            <div className="mt-3">
              <label className="block text-xs font-semibold text-slate-700 mb-2">
                해설 범위 선택
              </label>
              <div className="flex gap-4">
                <label className="flex items-center">
                  <input
                    type="radio"
                    value="full"
                    checked={explanationMode === 'full'}
                    onChange={(e) => setExplanationMode(e.target.value as 'full' | 'partial')}
                    className="mr-2"
                  />
                  <span className="text-sm">전체 해설</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    value="partial"
                    checked={explanationMode === 'partial'}
                    onChange={(e) => setExplanationMode(e.target.value as 'full' | 'partial')}
                    className="mr-2"
                  />
                  <span className="text-sm">부분 해설 (문제 선택)</span>
                </label>
              </div>
            </div>
          )}

          {/* 부분 해설 시 문제 선택 */}
          {uploadedFile && explanationMode === 'partial' && (
            <div className="mt-3">
              <label className="block text-xs font-semibold text-slate-700 mb-2">
                해설할 문제 선택
              </label>
              <div className="grid grid-cols-5 gap-2">
                {Array.from({ length: 20 }, (_, i) => i + 1).map((num) => (
                  <label key={num} className="flex items-center">
                    <input
                      type="checkbox"
                      checked={selectedQuestions.includes(num)}
                      onChange={() => handleQuestionSelect(num)}
                      className="mr-1"
                    />
                    <span className="text-xs">{num}번</span>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                선택된 문제: {selectedQuestions.length > 0 ? selectedQuestions.join(', ') : '없음'}
              </p>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-700">
            <label className="flex items-center gap-1.5">
              모델
              <select
                value={model}
                onChange={(e) => setModel(e.target.value as 'gemini' | 'openai')}
                className="rounded-md border border-slate-300 px-1.5 py-1 text-sm"
              >
                <option value="gemini">Gemini</option>
                <option value="openai">OpenAI</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              참고 예시
              <input
                type="number"
                min={1}
                max={6}
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value))}
                className="w-14 rounded-md border border-slate-300 px-1.5 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-1.5">
              자동 재시도
              <input
                type="number"
                min={0}
                max={5}
                value={maxRetries}
                onChange={(e) => setMaxRetries(Number(e.target.value))}
                className="w-14 rounded-md border border-slate-300 px-1.5 py-1 text-sm"
              />
            </label>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={run}
              disabled={running || (!questionText.trim() && !uploadedFile)}
              className="flex-1 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {running ? '처리 중...' : '실행'}
            </button>
            <button
              onClick={retry}
              disabled={running || (!questionText.trim() && !uploadedFile) || !result}
              className="rounded-md border border-indigo-600 bg-white px-3 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
              title="같은 입력으로 다시 호출 (LLM이 다른 결과를 줄 수 있음)"
            >
              재시도
            </button>
          </div>
        </div>

        {/* 우측: 안내 + 빠른 통계 */}
        <aside className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700">
          <h3 className="text-sm font-semibold text-slate-900">동선 요약</h3>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>문제 입력 후 「실행」</li>
            <li>좌측 결과 + 우측 Trace 확인</li>
            <li>체크리스트 항목이 있으면 「재시도」 또는 모델 변경</li>
            <li>품질 OK면 별점·코멘트 저장 → 다음 호출에 반영</li>
          </ol>
          <hr className="my-3 border-slate-200" />
          <h3 className="text-sm font-semibold text-slate-900">상태</h3>
          <dl className="mt-2 space-y-1">
            <div className="flex justify-between">
              <dt>최근 실행</dt>
              <dd>{history.length}건</dd>
            </div>
            {result && (
              <>
                <div className="flex justify-between">
                  <dt>이번 시도</dt>
                  <dd>{result.attempts}회 · {elapsed}ms</dd>
                </div>
                <div className="flex justify-between">
                  <dt>영속화</dt>
                  <dd>{result.runId ? `runId ${result.runId.slice(0, 8)}…` : '미설정'}</dd>
                </div>
              </>
            )}
          </dl>
        </aside>
      </section>

      {/* 결과 영역 */}
      {result && (
        <section className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">
                결과 {result.ok ? '✓' : '✗'}
              </h2>
              <div className="flex gap-1">
                <button
                  onClick={downloadJson}
                  disabled={!result.parsed}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  JSON
                </button>
                <button
                  onClick={copyAsMarkdown}
                  disabled={!result.parsed}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  MD 복사
                </button>
              </div>
            </div>

            {result.ok && result.parsed ? (
              <ResultView parsed={result.parsed} />
            ) : (
              <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
                <p className="font-semibold">실패 ({result.attempts}회 시도)</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                  {result.errors.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            {result.manualReviewChecklist.length > 0 && (
              <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                <p className="font-semibold">수동 검수 권장</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {result.manualReviewChecklist.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* 피드백 */}
            {result.runId && result.ok && (
              <FeedbackPanel
                rating={rating}
                onRating={setRating}
                note={feedbackNote}
                onNote={setFeedbackNote}
                saving={feedbackSaving}
                saved={feedbackSaved}
                onSave={saveFeedback}
              />
            )}
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-900 p-4 text-slate-100 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">실행 로그</h2>
              <button
                onClick={() => setShowTrace((v) => !v)}
                className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-700"
              >
                {showTrace ? '요약' : '전체 JSON'}
              </button>
            </div>
            <div className="max-h-[480px] overflow-auto font-mono text-[11px] leading-relaxed">
              {showTrace
                ? result.trace.map((t, i) => (
                    <div key={i} className="border-b border-slate-700 py-1">
                      {JSON.stringify(t)}
                    </div>
                  ))
                : result.trace.map((t, i) => <TraceLine key={i} event={t} />)}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function ResultView({ parsed }: { parsed: ParsedExplanation }) {
  return (
    <div className="space-y-3 text-sm text-slate-900">
      <div className="rounded-md bg-emerald-50 p-3">
        <span className="text-xs font-semibold text-emerald-900">정답</span>
        <div className="mt-0.5 text-base font-bold text-emerald-950">{parsed.answer}</div>
      </div>
      <div>
        <span className="text-xs font-semibold text-slate-700">
          풀이 단계 ({parsed.explanation_steps.length})
        </span>
        <ol className="mt-1 list-decimal space-y-2 pl-5">
          {parsed.explanation_steps.map((s, i) => (
            <li key={i}>
              <div>{s.text}</div>
              {s.equation && (
                <div className="mt-0.5 rounded bg-slate-50 px-2 py-1 font-mono text-[12px] text-indigo-800">
                  {s.equation}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
      {parsed.summary && (
        <div className="rounded-md bg-slate-50 p-3 text-xs">
          <span className="font-semibold text-slate-700">요약 </span>
          <span className="text-slate-800">{parsed.summary}</span>
        </div>
      )}
    </div>
  );
}

function TraceLine({ event }: { event: TraceEvent }) {
  const stage = String(event.stage);
  const tone =
    stage === 'success'
      ? 'text-emerald-300'
      : stage === 'give_up'
        ? 'text-rose-300'
        : stage === 'validate' && event.ok === false
          ? 'text-amber-300'
          : 'text-slate-300';
  const detail = formatTraceDetail(event);
  return (
    <div className={`border-b border-slate-700 py-1 ${tone}`}>
      <span className="font-bold">[{stage}]</span> {detail}
    </div>
  );
}

function formatTraceDetail(event: TraceEvent): string {
  const { stage, ...rest } = event;
  void stage;
  if ('attempt' in rest && 'ok' in rest) {
    return `시도 ${rest.attempt} · ${rest.ok ? '통과' : '실패'} ${
      Array.isArray(rest.errors) && rest.errors.length > 0 ? `(${rest.errors.join(', ')})` : ''
    }`;
  }
  if ('attempt' in rest && 'promptChars' in rest) {
    return `시도 ${rest.attempt} · 프롬프트 ${rest.promptChars}자`;
  }
  if ('refIds' in rest && Array.isArray(rest.refIds)) {
    return `참고 ${rest.refIds.length}개: ${rest.refIds.slice(0, 3).join(', ')}${
      rest.refIds.length > 3 ? '…' : ''
    }`;
  }
  if ('attempts' in rest) {
    return `${rest.attempts}회 시도`;
  }
  return JSON.stringify(rest);
}

function FeedbackPanel({
  rating,
  onRating,
  note,
  onNote,
  saving,
  saved,
  onSave,
}: {
  rating: number | null;
  onRating: (n: number) => void;
  note: string;
  onNote: (s: string) => void;
  saving: boolean;
  saved: boolean;
  onSave: () => void;
}) {
  return (
    <div className="mt-3 rounded-md border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-950">
      <p className="font-semibold">결과 피드백</p>
      <div className="mt-2 flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => onRating(n)}
            className={`h-7 w-7 rounded-full border text-sm font-bold ${
              rating === n
                ? 'border-indigo-700 bg-indigo-700 text-white'
                : 'border-indigo-300 bg-white text-indigo-800 hover:bg-indigo-100'
            }`}
            title={`${n}점`}
          >
            {n}
          </button>
        ))}
        <span className="ml-2 text-[11px] text-indigo-900">
          1=재생성 필요 · 5=그대로 사용 가능
        </span>
      </div>
      <textarea
        value={note}
        onChange={(e) => onNote(e.target.value)}
        placeholder="이 결과의 문제점·개선 메모 (선택)"
        rows={2}
        className="mt-2 w-full rounded border border-indigo-200 bg-white p-2 text-xs"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={saving || (rating === null && !note.trim())}
          className="rounded border border-indigo-700 bg-indigo-700 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? '저장 중…' : '저장'}
        </button>
        {saved && <span className="text-[11px] text-emerald-700">저장됨</span>}
      </div>
    </div>
  );
}

function HistoryPanel({
  rows,
  onPick,
}: {
  rows: RunHistoryRow[];
  onPick: (row: RunHistoryRow) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
        영속화된 이력이 없습니다. Supabase 환경변수를 설정하면 자동 기록됩니다.
      </div>
    );
  }
  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-white p-3">
      <table className="w-full text-xs">
        <thead className="text-slate-600">
          <tr>
            <th className="px-2 py-1 text-left">시각</th>
            <th className="px-2 py-1 text-left">시험·문항</th>
            <th className="px-2 py-1 text-left">모델</th>
            <th className="px-2 py-1 text-left">결과</th>
            <th className="px-2 py-1 text-left">평가</th>
            <th className="px-2 py-1 text-left">불러오기</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="px-2 py-1 text-slate-500">
                {new Date(r.created_at).toLocaleString('ko-KR', { hour12: false })}
              </td>
              <td className="px-2 py-1 text-slate-800">
                {r.exam_name ?? '-'} · {r.question_no ?? '-'}
              </td>
              <td className="px-2 py-1 text-slate-700">{r.model}</td>
              <td className="px-2 py-1">
                <span className={r.ok ? 'text-emerald-700' : 'text-rose-700'}>
                  {r.ok ? '✓' : '✗'} {r.attempts}회
                </span>
              </td>
              <td className="px-2 py-1 text-slate-700">
                {r.user_rating ? `★${r.user_rating}` : '-'}
              </td>
              <td className="px-2 py-1">
                <button
                  onClick={() => onPick(r)}
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                >
                  복원
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderAsMarkdown(parsed: ParsedExplanation, exam: string, no: string): string {
  const head = no ? `[문항 ${no}]\n` : '';
  const examLine = exam ? `# ${exam}\n\n` : '';
  const steps = parsed.explanation_steps
    .map((s, i) => {
      const eq = s.equation ? `\n\n  ${s.equation}` : '';
      return `${i + 1}. ${s.text}${eq}`;
    })
    .join('\n');
  return `${examLine}${head}[정답] ${parsed.answer}\n\n[해설]\n${steps}\n${
    parsed.summary ? `\n${parsed.summary}\n` : ''
  }`;
}
