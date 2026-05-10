'use client';

/**
 * src/app/auto/page.tsx
 * ────────────────────────────────────────────────────────────────────────────
 *  자동 해설 파이프라인 메인 UI (Railway 배포 진입점).
 *
 *  화면 안에서 한 번에:
 *    - 입력(문제/이미지/PDF/Drive 시험지) → 자동 검색·생성·검증·재시도
 *    - Trace 패널: 어디서 막혔는지 즉시 표시
 *    - 수동 검수 체크리스트: 사람이 봐야 할 부분만 골라 노출
 *    - 재시도 버튼 / 모델 토글 / 난이도 라우팅 / 별점 + 피드백 영속화
 *    - 최근 실행 이력 (Supabase 영속화 시) · DOCX 즉시 다운로드 +
 *      Drive 작업완료 자동 저장 · 분석용 자료 KB 학습
 * ────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useState } from 'react';
import { InlineMath, BlockMath } from 'react-katex';
import 'katex/dist/katex.min.css';
import { AnalysisStatusPanel } from '@/components/AnalysisStatusPanel';

type ParsedExplanation = {
  answer: string;
  explanation_steps: { text: string; equation: string }[];
  summary?: string;
};

type TraceEvent = { stage: string; [k: string]: unknown };

type SimilarReference = {
  id: string;
  source: string;
  problem_hint: string;
  snippet: string;
  problem_no?: number;
  pair_series?: string;
  hasSolution: boolean;
};

type RunRow = {
  questionNo: string;
  questionText: string;
  parsed: ParsedExplanation | null;
  attempts: number;
  errors: string[];
  trace: TraceEvent[];
  manualReviewChecklist: string[];
  runId: string | null;
  persistError?: string;
  profile?: 'easy' | 'balanced' | 'killer';
  profileReason?: string;
  usedModel?: string;
  usedVendor?: 'gemini' | 'openai';
  approxCostCents?: number;
  similarReferences?: SimilarReference[];
};

type ExtractedMeta = {
  totalQuestions: number;
  selectedNumbers: number[];
  source: string;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  size: number | null;
};

type PipelineResponse = {
  ok: boolean;
  // 단일 문항 모드 (텍스트 입력 또는 1문항만 추출): top-level 필드 채워짐
  parsed?: ParsedExplanation | null;
  attempts?: number;
  errors?: string[];
  trace?: TraceEvent[];
  manualReviewChecklist?: string[];
  runId?: string | null;
  persistError?: string;
  // 항상 채워짐: runs[0] = 단일 모드 결과, runs[N] = 다중 모드
  runs: RunRow[];
  partialFailures?: number;
  extracted?: ExtractedMeta;
  error?: string;
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
  // 새로고침 후 「복원」 클릭 시 결과 패널까지 되살리기 위한 컬럼
  parsed?: ParsedExplanation | null;
  trace?: TraceEvent[] | null;
  errors?: string[] | null;
  manual_review_checklist?: string[] | null;
};

type ExtractedQuestionPreview = {
  number: number;
  points?: number;
  preview: string;
};

type ExtractState =
  | { status: 'idle' }
  | { status: 'extracting' }
  | { status: 'ready'; source: string; pages?: number; questions: ExtractedQuestionPreview[]; rawTextLength: number }
  | { status: 'error'; error: string };

export default function AutoPipelinePage() {
  const [questionText, setQuestionText] = useState('');
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [explanationMode, setExplanationMode] = useState<'full' | 'partial'>('full');
  const [selectedQuestions, setSelectedQuestions] = useState<number[]>([]);
  const [model, setModel] = useState<'gemini' | 'openai'>('gemini');
  const [profile, setProfile] = useState<'auto' | 'easy' | 'balanced' | 'killer'>('auto');
  const [topK, setTopK] = useState(3);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PipelineResponse | null>(null);
  const [elapsed, setElapsed] = useState(0);
  /** 실행 중 라이브 경과 시간(ms) — 1초마다 갱신 */
  const [liveElapsed, setLiveElapsed] = useState(0);
  /** 서버에서 폴링한 진행 상황 — 어느 문항·어느 단계인지 */
  const [progress, setProgress] = useState<{
    stage: 'idle' | 'preparing' | 'processing' | 'completed' | 'failed';
    currentIdx: number;
    total: number;
    currentNo: string | null;
    subStage:
      | null
      | 'searching'
      | 'generating'
      | 'validating'
      | 'retrying'
      | 'persisting';
    completedCount: number;
  } | null>(null);
  const [examName, setExamName] = useState('');
  const [questionNo, setQuestionNo] = useState('');
  const [maxRetries, setMaxRetries] = useState(2);
  const [showTrace, setShowTrace] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [extractState, setExtractState] = useState<ExtractState>({ status: 'idle' });

  // Google Drive 시험지 폴더 연동
  const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
  const [driveStatus, setDriveStatus] = useState<'idle' | 'loading' | 'ready' | 'no-config' | 'error'>('idle');
  const [driveError, setDriveError] = useState<string | null>(null);
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [drivePicking, setDrivePicking] = useState(false);
  const [driveUploadInfo, setDriveUploadInfo] = useState<
    { link: string | null; fileName: string; error: string | null } | null
  >(null);
  const [analysisSyncing, setAnalysisSyncing] = useState(false);
  const [syncElapsedMs, setSyncElapsedMs] = useState<number>(0);
  const [analysisSyncResult, setAnalysisSyncResult] = useState<
    | {
        ok: true;
        totalFiles: number;
        records: number;
        errors: string[];
        bySubfolder: Record<string, number>;
      }
    | { ok: false; error: string }
    | null
  >(null);

  // 자동 파이프라인 헬스 + 감독관 스냅샷 (백그라운드 자동 동기화 / retrospective)
  // GET /api/auto-pipeline 으로 30초마다 갱신. 마지막 동기화 시각·HIGH 제안 수를
  // 노출해 사용자가 「분석자료 새로 학습」 버튼을 눌러야 할지 판단할 수 있게 한다.
  type HealthSnapshot = {
    kb_size: number;
    drive_sync: {
      lastRunAt: number | null;
      lastOk: boolean;
      lastNewOrChanged: number;
      lastTotalFiles: number;
      lastErrors: string[];
      intervalMs: number;
      lastByRootFolder?: Record<
        string,
        { filesFound: number; sizeSkipped: number; ocrFailed: number; cacheHit: number; newOrChanged: number }
      >;
    } | null;
    supervisor: {
      ranAt: number | null;
      ok: boolean;
      totalRuns: number;
      successRate: number;
      avgUserRating: number | null;
      highPrioritySuggestions: Array<{ priority: string; area: string; finding: string }>;
      suggestionsCount: number;
      pairingRate: number | null;
      integrityIssues?: { missing: number; duplicate: number; unpaired: number };
      error: string | null;
    } | null;
    /**
     * 감독관이 retrospective 결과에서 자동 추출한 「검토 메모」.
     * 다음 풀이 호출의 cautionNotes 에 자동 주입됨 — 이 패널로 가시화.
     */
    supervisor_cautions: string[];
  };
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [cautionsOpen, setCautionsOpen] = useState(false);
  const [supervisorRunning, setSupervisorRunning] = useState(false);

  // 분석 현황 탭 (시중교재/시험지 원안 진행 상태)
  const [analysisStatusOpen, setAnalysisStatusOpen] = useState(false);

  // 분석자료 검색
  const [analysisSearchOpen, setAnalysisSearchOpen] = useState(false);
  const [analysisSearchQ, setAnalysisSearchQ] = useState('');
  const [analysisSearchBusy, setAnalysisSearchBusy] = useState(false);
  const [analysisSearchResults, setAnalysisSearchResults] = useState<
    Array<{
      id: string;
      source: string;
      problem_hint?: string;
      snippet: string;
      matchedIn?: 'problem' | 'solution' | 'hint';
      problem_no?: number;
      solution_text?: string;
      pair_series?: string;
    }>
  >([]);

  const runAnalysisSearch = useCallback(async () => {
    const q = analysisSearchQ.trim();
    if (!q) return;
    setAnalysisSearchBusy(true);
    try {
      const res = await fetch(`/api/drive/analysis/search?q=${encodeURIComponent(q)}&limit=20`);
      const data = await res.json();
      setAnalysisSearchResults(Array.isArray(data.results) ? data.results : []);
    } catch {
      setAnalysisSearchResults([]);
    } finally {
      setAnalysisSearchBusy(false);
    }
  }, [analysisSearchQ]);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-pipeline');
      const data = await res.json();
      if (data?.ok) {
        setHealth({
          kb_size: data.kb_size ?? 0,
          drive_sync: data.drive_sync ?? null,
          supervisor: data.supervisor ?? null,
          supervisor_cautions: Array.isArray(data.supervisor_cautions)
            ? data.supervisor_cautions
            : [],
        });
      }
    } catch {
      // best-effort — 헬스체크 실패해도 본 동선은 영향 없음
    }
  }, []);

  // 마운트 시 1회 + 30초마다 자동 갱신
  useEffect(() => {
    void fetchHealth();
    const t = setInterval(() => void fetchHealth(), 30_000);
    return () => clearInterval(t);
  }, [fetchHealth]);

  /** 감독관 즉시 실행 — 6시간 주기 안 기다리고 바로 자동 메모 갱신 */
  const runSupervisorNow = useCallback(async () => {
    setSupervisorRunning(true);
    try {
      const res = await fetch('/api/retrospective', { method: 'POST' });
      const data = await res.json();
      if (data?.ok) {
        setHealth((prev) =>
          prev
            ? {
                ...prev,
                supervisor: data.snapshot ?? prev.supervisor,
                supervisor_cautions: Array.isArray(data.autoCautions)
                  ? data.autoCautions
                  : prev.supervisor_cautions,
              }
            : prev,
        );
        setCautionsOpen(true);
      }
    } catch {
      /* 무시 — 다음 fetchHealth tick 에 결과 반영 */
    } finally {
      setSupervisorRunning(false);
    }
  }, []);

  const syncDriveAnalysis = useCallback(async () => {
    setAnalysisSyncing(true);
    setAnalysisSyncResult(null);
    try {
      // 1) 백그라운드 작업 시작 — POST 즉시 반환 (502 방지)
      const startRes = await fetch('/api/drive/analysis/sync', { method: 'POST' });
      const startData = await startRes.json();
      if (!startData.ok) {
        setAnalysisSyncResult({
          ok: false,
          error: startData.error ?? '시작 실패',
        });
        return;
      }
      // 2) 상태 폴링 — 3초 간격으로 GET, 최대 30분.
      //    참고: timeout 후에도 백그라운드 작업은 서버에서 계속 진행됨.
      //    fire-and-forget 패턴이라 사용자가 닫아도 OK.
      const startedAt = Date.now();
      const TIMEOUT_MS = 30 * 60 * 1000;
      // 약간의 정착 시간(첫 번째 GET 이 still running 잡도록)
      await new Promise((r) => setTimeout(r, 500));
      while (Date.now() - startedAt < TIMEOUT_MS) {
        const pollRes = await fetch('/api/drive/analysis/sync');
        const pollData = await pollRes.json();
        const job = pollData.job;
        if (!job) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        // 진행 중이면 elapsed 시간을 UI 에 노출 (버튼 라벨)
        if (typeof job.elapsedMs === 'number') {
          setSyncElapsedMs(job.elapsedMs);
        }
        if (job.status === 'completed') {
          const s = job.summary ?? {};
          setAnalysisSyncResult({
            ok: true,
            totalFiles: s.totalFiles ?? 0,
            records: s.records ?? 0,
            errors: Array.isArray(s.errors) ? s.errors : [],
            bySubfolder: s.bySubfolder ?? {},
          });
          // 헬스 스냅샷도 즉시 갱신 — 라벨이 「방금」 으로 바뀜
          void fetchHealth();
          // 분석 현황 패널이 열려 있으면 즉시 갱신 (이벤트 브로드캐스트)
          window.dispatchEvent(new Event('analysis-sync-completed'));
          return;
        }
        if (job.status === 'failed') {
          setAnalysisSyncResult({
            ok: false,
            error: job.error ?? '동기화 실패',
          });
          return;
        }
        // running — 계속 폴링
        await new Promise((r) => setTimeout(r, 3000));
      }
      // ⚠️ timeout 도달 — 학습이 「실패」 한 게 아니라 클라이언트 폴링만 끊김.
      // 서버 백그라운드는 계속 처리 중. 사용자에게 진행 중임을 명시.
      setAnalysisSyncResult({
        ok: false,
        error:
          '폴링 시간 초과 (30분) — 그러나 서버 백그라운드 작업은 계속 진행 중입니다. ' +
          '큰 시중교재 PDF 처리는 30분 이상 걸릴 수 있습니다. ' +
          '잠시 후 「분석 현황」 패널에서 record 수가 늘어나는지 확인하세요.',
      });
    } catch (e) {
      setAnalysisSyncResult({ ok: false, error: (e as Error).message });
    } finally {
      setAnalysisSyncing(false);
      setSyncElapsedMs(0);
    }
  }, []);

  const loadDriveFiles = useCallback(async () => {
    setDriveStatus('loading');
    setDriveError(null);
    try {
      const res = await fetch('/api/drive/exams');
      const data = await res.json();
      if (data.configured === false) {
        setDriveStatus('no-config');
        setDriveError(data.reason ?? null);
        return;
      }
      if (!data.ok) {
        setDriveStatus('error');
        setDriveError(data.error ?? 'Drive 목록 조회 실패');
        return;
      }
      setDriveFiles(Array.isArray(data.files) ? data.files : []);
      setDriveStatus('ready');
    } catch (e) {
      setDriveStatus('error');
      setDriveError((e as Error).message);
    }
  }, []);

  const pickDriveFile = useCallback(async (fileId: string) => {
    setDrivePicking(true);
    setExtractState({ status: 'idle' });
    try {
      const res = await fetch('/api/drive/exams/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? 'Drive 파일 다운로드 실패');
      const bin = atob(data.fileData);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], data.fileName, { type: data.mimeType });
      setUploadedFile(file);
      if (!examName.trim()) {
        // 파일명 끝의 확장자만 떼서 시험지명 자동 채움
        const baseName = data.fileName.replace(/\.[^.]+$/, '');
        setExamName(baseName);
      }
      setDrivePickerOpen(false);
    } catch (e) {
      setExtractState({ status: 'error', error: `Drive 가져오기 실패: ${(e as Error).message}` });
    } finally {
      setDrivePicking(false);
    }
  }, [examName]);

  // base64 인코딩 후 JSON으로 보내므로 4MB 정도가 안전한 한계 (1MB body * ~1.37 인코딩 오버헤드 + JSON 래핑)
  // Next 16 기본은 1MB body. 큰 PDF는 multipart 또는 페이지 분할 필요.
  const FILE_SIZE_WARN_MB = 3;
  const FILE_SIZE_LIMIT_MB = 4.5;

  const acceptUploadedFile = useCallback((file: File) => {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isImg = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
    if (!isPdf && !isImg) {
      setExtractState({ status: 'error', error: `지원하지 않는 파일 형식: ${file.type || file.name}` });
      return;
    }
    const sizeMB = file.size / 1024 / 1024;
    if (sizeMB > FILE_SIZE_LIMIT_MB) {
      setExtractState({
        status: 'error',
        error: `파일 크기 ${sizeMB.toFixed(1)}MB 가 ${FILE_SIZE_LIMIT_MB}MB 한도를 초과합니다. PDF는 페이지를 나누거나, 이미지로 캡처해 업로드하세요.`,
      });
      return;
    }
    setUploadedFile(file);
    setQuestionText('');
    setSelectedQuestions([]);
    setExtractState({ status: 'idle' });
  }, []);

  const handleFileUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      acceptUploadedFile(file);
    },
    [acceptUploadedFile],
  );

  const [isDragOver, setIsDragOver] = useState(false);
  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setIsDragOver(false);
      if (questionText.trim()) return; // 텍스트 입력 모드면 무시
      const file = event.dataTransfer?.files?.[0];
      if (file) acceptUploadedFile(file);
    },
    [acceptUploadedFile, questionText],
  );
  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, []);
  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // 자식 요소로 이동할 때도 leave 가 발생하므로 currentTarget 검사
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDragOver(false);
  }, []);

  const handleQuestionSelect = useCallback((questionNumber: number) => {
    setSelectedQuestions((prev) =>
      prev.includes(questionNumber) ? prev.filter((i) => i !== questionNumber) : [...prev, questionNumber],
    );
  }, []);

  async function runExtraction() {
    if (!uploadedFile) return;
    setExtractState({ status: 'extracting' });
    try {
      const fileData = await convertFileToBase64(uploadedFile);
      const res = await fetch('/api/auto-pipeline/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileData,
          fileName: uploadedFile.name,
          fileType: uploadedFile.type,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setExtractState({ status: 'error', error: data.error ?? '추출 실패' });
        return;
      }
      setExtractState({
        status: 'ready',
        source: data.source,
        pages: data.pages,
        questions: data.questions ?? [],
        rawTextLength: data.rawTextLength ?? 0,
      });
      // 인식된 문항이 있으면 부분 모드 초기 선택을 비워둔다
      setSelectedQuestions([]);
    } catch (e) {
      setExtractState({ status: 'error', error: (e as Error).message });
    }
  }

  function selectAllExtracted() {
    if (extractState.status !== 'ready') return;
    setSelectedQuestions(extractState.questions.map((q) => q.number));
  }

  function clearSelection() {
    setSelectedQuestions([]);
  }

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
  // Supabase 상태 — 'unknown' | 'ok' | 'no-env' | 'no-table'
  const [supabaseStatus, setSupabaseStatus] = useState<'unknown' | 'ok' | 'no-env' | 'no-table'>('unknown');

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-pipeline/feedback?limit=20');
      const data = await res.json();
      if (Array.isArray(data.runs)) setHistory(data.runs);
      const sb: string = data.supabase ?? 'unknown';
      if (sb === 'ok' || sb === 'no-env' || sb === 'no-table') {
        setSupabaseStatus(sb);
      } else {
        setSupabaseStatus('unknown');
      }
    } catch {
      /* 무시 */
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // 탭 전환 시 피드백 상태 리셋 (각 문항은 별개)
  useEffect(() => {
    setRating(null);
    setFeedbackNote('');
    setFeedbackSaved(false);
  }, [activeIdx]);

  // 실행 중 라이브 경과 시간 (1초마다 갱신) + 진행 상황 폴링 (1.5초)
  useEffect(() => {
    if (!running) {
      setLiveElapsed(0);
      setProgress(null);
      return;
    }
    const t0 = performance.now();
    const tick = setInterval(() => {
      setLiveElapsed(Math.round(performance.now() - t0));
    }, 1000);
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/auto-pipeline/progress', { cache: 'no-store' });
        if (!res.ok) return;
        const d = await res.json();
        setProgress({
          stage: d.stage,
          currentIdx: d.currentIdx,
          total: d.total,
          currentNo: d.currentNo,
          subStage: d.subStage,
          completedCount: d.completedCount,
        });
      } catch {
        // silent — 다음 tick 에 다시 시도
      }
    }, 1500);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [running]);

  async function run() {
    if (!questionText.trim() && !uploadedFile) return;
    setRunning(true);
    setResult(null);
    setRating(null);
    setFeedbackNote('');
    setFeedbackSaved(false);
    setActiveIdx(0);
    const t0 = performance.now();

    try {
      let requestBody: any = {
        examName: examName || undefined,
        questionNo: questionNo || undefined,
        model,
        profile,
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
      const msg = (e as Error).message;
      setResult({
        ok: false,
        parsed: null,
        attempts: 0,
        errors: [msg],
        trace: [],
        manualReviewChecklist: [],
        runId: null,
        runs: [
          {
            questionNo: questionNo || '?',
            questionText: questionText || '(파일)',
            parsed: null,
            attempts: 0,
            errors: [msg],
            trace: [],
            manualReviewChecklist: [`[네트워크/클라이언트 오류] ${msg}`],
            runId: null,
          },
        ],
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

  /**
   * 「다음 N개 처리」 — 25문항 중 앞 10개를 처리하고 나서, 사용자가 결과를 검토한 뒤
   * 11~20 / 21~25 같은 다음 배치를 이어서 처리할 때 호출.
   * 서버 MAX_QUESTIONS_PER_REQUEST(=10) 는 그대로 두고, UI 가 batch 를 누적한다.
   */
  async function runNextBatch(nextNumbers: number[]) {
    if (!uploadedFile) return; // 텍스트 입력 모드에는 배치 개념 없음
    if (nextNumbers.length === 0) return;
    setRunning(true);
    const t0 = performance.now();
    const previousRuns = result?.runs ?? [];
    const previousExtracted = result?.extracted;

    try {
      const fileData = await convertFileToBase64(uploadedFile);
      const requestBody = {
        examName: examName || undefined,
        questionNo: questionNo || undefined,
        model,
        profile,
        topK,
        maxRetries,
        fileData,
        fileName: uploadedFile.name,
        fileType: uploadedFile.type,
        explanationMode: 'partial' as const,
        selectedQuestions: nextNumbers,
      };
      const res = await fetch('/api/auto-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const data = (await res.json()) as PipelineResponse;
      // 이전 batch + 새 batch 결과 합산
      const mergedRuns = [...previousRuns, ...(data.runs ?? [])];
      const mergedSelected = [
        ...(previousExtracted?.selectedNumbers ?? []),
        ...(data.extracted?.selectedNumbers ?? []),
      ];
      setResult({
        ...data,
        runs: mergedRuns,
        partialFailures: mergedRuns.filter((r) => !r.parsed).length,
        extracted: data.extracted
          ? {
              totalQuestions: data.extracted.totalQuestions,
              selectedNumbers: mergedSelected,
              source: data.extracted.source,
            }
          : previousExtracted,
        ok: mergedRuns.every((r) => !!r.parsed),
      });
      setActiveIdx(previousRuns.length); // 새 batch 첫 문항으로 점프
    } catch (e) {
      const msg = (e as Error).message;
      // 실패해도 이전 batch 보존
      setResult((prev) =>
        prev
          ? {
              ...prev,
              runs: [
                ...prev.runs,
                {
                  questionNo: '?',
                  questionText: `(다음 batch 호출 실패: ${nextNumbers.join(', ')})`,
                  parsed: null,
                  attempts: 0,
                  errors: [msg],
                  trace: [],
                  manualReviewChecklist: [`[batch 호출 오류] ${msg}`],
                  runId: null,
                },
              ],
            }
          : prev,
      );
    } finally {
      setElapsed(Math.round(performance.now() - t0));
      setRunning(false);
      loadHistory();
    }
  }

  // 활성 문항 (다중 모드일 땐 탭 선택, 단일 모드는 runs[0])
  const activeRun = result?.runs?.[activeIdx] ?? null;

  async function saveFeedback() {
    const runId = activeRun?.runId;
    if (!runId) return;
    setFeedbackSaving(true);
    try {
      const res = await fetch('/api/auto-pipeline/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId,
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
    if (!activeRun?.parsed) return;
    const blob = new Blob([JSON.stringify(activeRun.parsed, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${examName || 'explanation'}_${activeRun.questionNo || 'q'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyAsMarkdown() {
    if (!activeRun?.parsed) return;
    const md = renderAsMarkdown(activeRun.parsed, examName, activeRun.questionNo);
    void navigator.clipboard.writeText(md);
  }

  /** 실행 결과(성공·실패 무관)를 CSV로 — 실패 분석용 */
  function downloadRunsCsv() {
    if (!result) return;
    const runs = result.runs ?? [];
    if (runs.length === 0) return;
    const csvEscape = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      '문항번호',
      '성공',
      '시도횟수',
      '정답',
      '풀이단계수',
      '오류',
      '검수체크리스트',
      'runId',
      '영속화실패',
      '문제본문(앞 200자)',
    ];
    const rows = runs.map((r) => [
      r.questionNo,
      r.parsed ? 'O' : 'X',
      r.attempts,
      r.parsed?.answer ?? '',
      r.parsed?.explanation_steps.length ?? 0,
      (r.errors ?? []).join(' | '),
      (r.manualReviewChecklist ?? []).join(' | '),
      r.runId ?? '',
      r.persistError ?? '',
      (r.questionText ?? '').slice(0, 200).replace(/\s+/g, ' '),
    ]);
    const csv = '﻿' + [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${examName || '해설지'}_실행분석_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 실행 결과 + trace 전부를 JSON으로 — 깊은 디버깅용 */
  function downloadRunsJson() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${examName || '해설지'}_실행로그_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadHml(scope: 'active' | 'all') {
    if (!result) return;
    const runs =
      scope === 'all'
        ? (result.runs ?? []).filter((r) => r.parsed)
        : activeRun?.parsed
          ? [activeRun]
          : [];
    if (runs.length === 0) return;
    const res = await fetch('/api/auto-pipeline/hml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        examName: examName || '해설지',
        runs: runs.map((r) => ({
          questionNo: r.questionNo,
          questionText: r.questionText,
          parsed: r.parsed,
        })),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`HWP/HML 생성 실패: ${err.error ?? res.statusText}`);
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const filenameMatch = cd.match(/filename="?([^";]+)"?/);
    const fallback = `${examName || 'explanation'}_${runs.length}q.hml`;
    const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : fallback;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Drive 작업완료 폴더에도 자동 업로드된 결과를 페이지에 노출 — DOCX 와 동등
    const driveLink = res.headers.get('x-drive-web-view-link');
    const driveErr = res.headers.get('x-drive-upload-error');
    if (driveLink) {
      setDriveUploadInfo({ link: driveLink, fileName: filename, error: null });
    } else if (driveErr) {
      setDriveUploadInfo({ link: null, fileName: filename, error: decodeURIComponent(driveErr) });
    }
  }

  async function downloadDocx(scope: 'active' | 'all') {
    if (!result) return;
    const runs =
      scope === 'all'
        ? (result.runs ?? []).filter((r) => r.parsed)
        : activeRun?.parsed
          ? [activeRun]
          : [];
    if (runs.length === 0) return;
    const res = await fetch('/api/auto-pipeline/docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        examName: examName || `해설지`,
        runs: runs.map((r) => ({
          questionNo: r.questionNo,
          questionText: r.questionText,
          parsed: r.parsed,
        })),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`DOCX 생성 실패: ${err.error ?? res.statusText}`);
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') ?? '';
    const filenameMatch = cd.match(/filename="?([^";]+)"?/);
    const fallback = `${examName || 'explanation'}_${runs.length}q.docx`;
    const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : fallback;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    // Drive 작업완료 폴더에도 자동 업로드된 결과를 페이지에 노출
    const driveLink = res.headers.get('x-drive-web-view-link');
    const driveErr = res.headers.get('x-drive-upload-error');
    if (driveLink) {
      setDriveUploadInfo({ link: driveLink, fileName: filename, error: null });
    } else if (driveErr) {
      setDriveUploadInfo({ link: null, fileName: filename, error: decodeURIComponent(driveErr) });
    } else {
      setDriveUploadInfo(null);
    }
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
          <HealthBadges health={health} />
          {/*
            감독관 자동 메모 — 6시간마다 retrospective 결과에서 추출되며 다음 풀이 호출의
            cautionNotes 에 자동 주입된다. 사용자가 별점 안 남겨도 자동 학습.
            아래 「최신 메모 N건」 칩 클릭 시 패널 열고, 「지금 갱신」 버튼으로 즉시 갱신.
          */}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <button
              type="button"
              onClick={() => setCautionsOpen((v) => !v)}
              className={`rounded border px-1.5 py-0.5 ${
                (health?.supervisor_cautions?.length ?? 0) > 0
                  ? 'border-indigo-400 bg-indigo-50 text-indigo-900 hover:bg-indigo-100'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
              }`}
              title="감독관이 retrospective 결과에서 자동 추출한 「검토 메모」. 다음 풀이 호출의 프롬프트에 자동 주입돼 같은 실수를 반복하지 않게 함."
            >
              📋 감독관 메모 {health?.supervisor_cautions?.length ?? 0}건 {cautionsOpen ? '닫기' : '열기'}
            </button>
            <button
              type="button"
              onClick={runSupervisorNow}
              disabled={supervisorRunning}
              className="rounded border border-indigo-700 bg-indigo-700 px-1.5 py-0.5 font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
              title="6시간 주기를 기다리지 않고 지금 감독관을 한 번 돌려 자동 메모를 갱신. V6 같은 변경 직후 효과 확인용."
            >
              {supervisorRunning ? '갱신 중…' : '지금 갱신'}
            </button>
          </div>
          {cautionsOpen && (
            <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50 p-2 text-[11px] text-indigo-950">
              {(health?.supervisor_cautions?.length ?? 0) === 0 ? (
                <p className="text-slate-700">
                  자동 메모 없음 — 최근 30일에 임계치(같은 사유 ≥3건) 도달한 실패 패턴이 없거나, 감독관이
                  아직 한 번도 안 돌았습니다. 「지금 갱신」 클릭 시 즉시 1회 실행.
                </p>
              ) : (
                <ul className="list-disc space-y-1 pl-4">
                  {(health?.supervisor_cautions ?? []).map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAnalysisStatusOpen((v) => !v)}
            className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-800 hover:bg-indigo-50"
            title="시중교재/시험지 원안 폴더별 학습 진행 상태, DB record 통계, 무결성 이슈, 자동 추천 액션을 한눈에"
          >
            분석 현황 {analysisStatusOpen ? '닫기' : '열기'}
          </button>
          <button
            type="button"
            onClick={() => setAnalysisSearchOpen((v) => !v)}
            className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-50"
            title="분석용 자료 (Supabase 영구 저장된 OCR 결과) 안에서 키워드 검색"
          >
            분석자료 검색 {analysisSearchOpen ? '닫기' : '열기'}
          </button>
          <button
            type="button"
            onClick={syncDriveAnalysis}
            disabled={analysisSyncing}
            className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
            title="Drive 「분석용 자료」(시중교재/개인자료 포함) 폴더를 다시 읽어 KB 에 합칩니다. 자동 감지도 동작 — 새 PDF 올린 후 ~1분 안 첫 풀이 호출에서 자동 반영됩니다."
          >
            {analysisSyncing
              ? `분석자료 동기화 중… ${syncElapsedMs > 0 ? `(${Math.floor(syncElapsedMs / 60000)}분 ${Math.floor((syncElapsedMs % 60000) / 1000)}초)` : ''}`
              : '분석자료 새로 학습'}
          </button>
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            최근 이력 {historyOpen ? '닫기' : '열기'} ({history.length})
          </button>
        </div>
      </header>

      {analysisStatusOpen && (
        <div className="mb-4">
          <AnalysisStatusPanel />
        </div>
      )}

      {analysisSearchOpen && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={analysisSearchQ}
              onChange={(e) => setAnalysisSearchQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runAnalysisSearch(); }}
              placeholder="예: 조건부확률 / 원형 순열 / 함수의 극한"
              className="flex-1 rounded-md border border-emerald-300 px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={runAnalysisSearch}
              disabled={analysisSearchBusy}
              className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {analysisSearchBusy ? '검색 중…' : '검색'}
            </button>
          </div>
          {analysisSearchResults.length > 0 && (
            <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto">
              {analysisSearchResults.map((r) => (
                <li key={r.id} className="rounded border border-emerald-200 bg-white p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-800">
                      {r.problem_hint || r.source}
                      {typeof r.problem_no === 'number' && (
                        <span className="ml-1 rounded bg-slate-100 px-1 text-slate-600">
                          {r.problem_no}번
                        </span>
                      )}
                    </p>
                    <span
                      className={`shrink-0 rounded px-1 text-[10px] ${
                        r.matchedIn === 'solution'
                          ? 'bg-amber-100 text-amber-800'
                          : r.matchedIn === 'problem'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {r.matchedIn === 'solution'
                        ? '풀이 매치'
                        : r.matchedIn === 'problem'
                          ? '문제 매치'
                          : '제목 매치'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    {r.source}
                    {r.pair_series && ` · 시리즈: ${r.pair_series}`}
                    {r.solution_text && ' · 풀이 포함 ✓'}
                  </p>
                  <p className="mt-1 text-slate-700">{r.snippet}</p>
                </li>
              ))}
            </ul>
          )}
          {!analysisSearchBusy && analysisSearchResults.length === 0 && analysisSearchQ.trim() && (
            <p className="mt-2 text-xs text-slate-600">결과 없음 — Supabase 에 분석자료 저장 안 됐을 수 있습니다 (「분석자료 새로 학습」 한 번 눌러보세요).</p>
          )}
        </div>
      )}

      {analysisSyncResult && (
        <div className={`mb-4 rounded-lg border p-3 text-xs ${analysisSyncResult.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-950' : 'border-rose-300 bg-rose-50 text-rose-950'}`}>
          {analysisSyncResult.ok ? (
            <div>
              <p className="font-semibold">
                ✓ 분석용 자료 학습 완료 — 파일 {analysisSyncResult.totalFiles}개,
                chunk {analysisSyncResult.records}개 인덱싱
                {analysisSyncResult.errors.length > 0 && ` (경고 ${analysisSyncResult.errors.length}개)`}
              </p>
              {Object.keys(analysisSyncResult.bySubfolder).length > 0 && (
                <p className="mt-1 text-emerald-900">
                  폴더별:{' '}
                  {Object.entries(analysisSyncResult.bySubfolder)
                    .map(([k, v]) => `${k} ${v}건`)
                    .join(' · ')}
                </p>
              )}
            </div>
          ) : (
            <p>✗ 분석용 자료 학습 실패: {analysisSyncResult.error}</p>
          )}
        </div>
      )}

      {/* Supabase 셋업 안내 배너 */}
      {(supabaseStatus === 'no-env' || supabaseStatus === 'no-table') && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
          <p className="font-semibold">
            ⚠ 영속화 비활성 — {supabaseStatus === 'no-env' ? 'Supabase 환경변수 미설정' : 'auto_pipeline_runs 테이블 미생성'}
          </p>
          <p className="mt-1 leading-relaxed">
            지금도 해설은 정상 생성되지만 실행 이력·피드백은 저장되지 않습니다.
            {supabaseStatus === 'no-env' ? (
              <> Railway Variables 또는 <code className="rounded bg-amber-100 px-1">.env.local</code>에 <code className="rounded bg-amber-100 px-1">NEXT_PUBLIC_SUPABASE_URL</code>, <code className="rounded bg-amber-100 px-1">SUPABASE_SERVICE_ROLE_KEY</code> 추가 후 재배포.</>
            ) : (
              <> Supabase Dashboard → SQL Editor에서 <code className="rounded bg-amber-100 px-1">supabase/auto_pipeline_runs.sql</code> 실행.</>
            )}
          </p>
        </div>
      )}

      {historyOpen && (
        <HistoryPanel
          rows={history}
          onPick={(row) => {
            setQuestionText(row.question_text);
            setExamName(row.exam_name ?? '');
            setQuestionNo(row.question_no ?? '');
            // 결과 패널까지 복원 — Supabase에 저장된 parsed/trace/errors 를 그대로 재구성
            const restoredRun: RunRow = {
              questionNo: row.question_no ?? '?',
              questionText: row.question_text,
              parsed: row.parsed ?? null,
              attempts: row.attempts,
              errors: row.errors ?? [],
              trace: row.trace ?? [],
              manualReviewChecklist: row.manual_review_checklist ?? [],
              runId: row.id,
            };
            setResult({
              ok: row.ok,
              parsed: restoredRun.parsed,
              attempts: restoredRun.attempts,
              errors: restoredRun.errors,
              trace: restoredRun.trace,
              manualReviewChecklist: restoredRun.manualReviewChecklist,
              runId: restoredRun.runId,
              runs: [restoredRun],
            });
            setActiveIdx(0);
          }}
        />
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

          {/* Google Drive 시험지 폴더 — 파일 업로드 위에 노출 */}
          <div className="mt-3">
            <div className="flex items-center justify-between gap-2">
              <label className="block text-xs font-semibold text-slate-700">
                Google Drive 「시험지」 폴더에서 가져오기
              </label>
              <button
                type="button"
                onClick={() => {
                  if (!drivePickerOpen && driveStatus !== 'ready') loadDriveFiles();
                  setDrivePickerOpen((v) => !v);
                }}
                className="rounded-md border border-emerald-600 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                disabled={!!questionText.trim()}
              >
                {drivePickerOpen ? 'Drive 패널 닫기' : 'Drive에서 가져오기'}
              </button>
            </div>
            {drivePickerOpen && (
              <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs">
                {driveStatus === 'loading' && <p className="text-emerald-900">목록 불러오는 중…</p>}
                {driveStatus === 'no-config' && (
                  <p className="text-amber-900">
                    Drive 키 미설정 — Railway Variables 에 GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN 추가가 필요합니다.
                    {driveError ? ` (${driveError})` : ''}
                  </p>
                )}
                {driveStatus === 'error' && (
                  <p className="text-rose-900">✗ {driveError ?? 'Drive 오류'}</p>
                )}
                {driveStatus === 'ready' && driveFiles.length === 0 && (
                  <p className="text-slate-700">
                    「해설제작/시험지」 폴더가 비어 있습니다. PDF/이미지를 업로드하세요.
                  </p>
                )}
                {driveStatus === 'ready' && driveFiles.length > 0 && (
                  <div className="space-y-1">
                    <p className="mb-1 text-emerald-900">최신순 {driveFiles.length}개:</p>
                    <ul className="max-h-48 overflow-y-auto divide-y divide-emerald-100 rounded border border-emerald-200 bg-white">
                      {driveFiles.map((f) => (
                        <li key={f.id} className="flex items-center justify-between gap-2 px-2 py-1">
                          <div className="flex-1 truncate">
                            <span className="font-semibold text-slate-800">{f.name}</span>
                            {f.size !== null && (
                              <span className="ml-2 text-slate-500">
                                {(f.size / 1024 / 1024).toFixed(1)}MB
                              </span>
                            )}
                            {f.modifiedTime && (
                              <span className="ml-2 text-slate-400">
                                {new Date(f.modifiedTime).toLocaleDateString('ko-KR')}
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => pickDriveFile(f.id)}
                            disabled={drivePicking}
                            className="rounded border border-emerald-600 bg-white px-2 py-0.5 font-semibold text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
                          >
                            {drivePicking ? '가져오는 중…' : '가져오기'}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      onClick={loadDriveFiles}
                      className="mt-1 text-emerald-800 underline"
                    >
                      목록 새로고침
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 파일 업로드 (드래그 앤 드롭 지원) */}
          <div className="mt-3">
            <label className="block text-xs font-semibold text-slate-700 mb-2">
              또는 PDF/이미지 파일 업로드 — 끌어다 놓아도 됩니다
            </label>
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragEnter={handleDragOver}
              onDragLeave={handleDragLeave}
              className={`rounded-md border-2 border-dashed px-3 py-4 transition-colors ${
                questionText.trim()
                  ? 'border-slate-200 bg-slate-50 opacity-60'
                  : isDragOver
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-300 bg-slate-50 hover:border-blue-400 hover:bg-blue-50/40'
              }`}
            >
              <p className="mb-2 text-center text-xs text-slate-600">
                {isDragOver
                  ? '↓ 여기에 놓으세요'
                  : '파일을 이 영역에 끌어다 놓거나, 아래 「파일 선택」 버튼 사용'}
              </p>
              <input
                type="file"
                accept=".pdf,image/*"
                onChange={handleFileUpload}
                className="block w-full text-sm text-slate-500 file:mr-4 file:rounded-md file:border-0 file:bg-blue-100 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-800 hover:file:bg-blue-200 disabled:opacity-40"
                disabled={!!questionText.trim()}
              />
            </div>
            {uploadedFile && (() => {
              const sizeMB = uploadedFile.size / 1024 / 1024;
              const warn = sizeMB >= FILE_SIZE_WARN_MB;
              return (
                <p className={`mt-1 text-xs ${warn ? 'text-amber-700' : 'text-green-600'}`}>
                  {warn ? '⚠' : '✓'} {uploadedFile.name} ({sizeMB.toFixed(1)}MB)
                  {warn ? ' — 큰 파일은 추출/전송이 느릴 수 있습니다.' : ''}
                </p>
              );
            })()}
          </div>

          {/* 파일 업로드 시 — 문항 추출 단계 */}
          {uploadedFile && (
            <div className="mt-3">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-slate-700">
                  문항 추출
                </label>
                <button
                  type="button"
                  onClick={runExtraction}
                  disabled={extractState.status === 'extracting'}
                  className="rounded-md border border-blue-600 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-800 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {extractState.status === 'extracting'
                    ? '추출 중…'
                    : extractState.status === 'ready'
                      ? '다시 추출'
                      : '문항 추출'}
                </button>
              </div>

              {extractState.status === 'error' && (
                <p className="mt-2 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-xs text-rose-900">
                  ✗ {extractState.error}
                </p>
              )}

              {extractState.status === 'ready' && (
                <div className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-950">
                  <p className="font-semibold">
                    ✓ {extractState.questions.length}개 문항 인식 ·
                    {' '}소스 {extractState.source}
                    {extractState.pages ? ` · ${extractState.pages}페이지` : ''}
                    {' '}· 텍스트 {extractState.rawTextLength.toLocaleString()}자
                  </p>
                  {extractState.questions.length === 0 && (
                    <p className="mt-1 text-rose-800">
                      문항 번호를 인식하지 못했습니다. PDF 품질·OCR 결과를 확인하거나,
                      해설 범위 「전체 해설」로 두고 그냥 실행하면 본문 전체가 1문항으로 처리됩니다.
                    </p>
                  )}
                </div>
              )}

              {/* 해설 범위 — 추출 후에만 의미 있음 */}
              {extractState.status === 'ready' && extractState.questions.length > 0 && (
                <>
                  <div className="mt-3 flex gap-4">
                    <label className="flex items-center text-sm text-slate-800">
                      <input
                        type="radio"
                        value="full"
                        checked={explanationMode === 'full'}
                        onChange={(e) => setExplanationMode(e.target.value as 'full' | 'partial')}
                        className="mr-1.5"
                      />
                      전체 해설 ({extractState.questions.length}문항)
                    </label>
                    <label className="flex items-center text-sm text-slate-800">
                      <input
                        type="radio"
                        value="partial"
                        checked={explanationMode === 'partial'}
                        onChange={(e) => setExplanationMode(e.target.value as 'full' | 'partial')}
                        className="mr-1.5"
                      />
                      부분 해설
                    </label>
                  </div>

                  {explanationMode === 'partial' && (
                    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-slate-700">
                          인식된 문항 (체크해서 선택)
                        </span>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            onClick={selectAllExtracted}
                            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            모두
                          </button>
                          <button
                            type="button"
                            onClick={clearSelection}
                            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-100"
                          >
                            해제
                          </button>
                        </div>
                      </div>
                      <div className="grid max-h-48 grid-cols-1 gap-1 overflow-auto sm:grid-cols-2">
                        {extractState.questions.map((q) => {
                          const isOn = selectedQuestions.includes(q.number);
                          return (
                            <label
                              key={q.number}
                              className={`flex cursor-pointer items-start gap-1.5 rounded border p-1.5 text-[11px] ${
                                isOn ? 'border-indigo-400 bg-indigo-50' : 'border-slate-200 bg-white hover:bg-slate-50'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isOn}
                                onChange={() => handleQuestionSelect(q.number)}
                                className="mt-0.5"
                              />
                              <span>
                                <span className="font-bold text-slate-900">{q.number}번</span>
                                {q.points ? <span className="text-slate-500"> [{q.points}점]</span> : null}
                                <span className="ml-1 text-slate-600">{q.preview}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      <p className="mt-1 text-[11px] text-slate-600">
                        선택 {selectedQuestions.length}개
                        {selectedQuestions.length > 10
                          ? ' — 한 번에 최대 10문항만 처리됩니다 (앞에서부터)'
                          : ''}
                      </p>
                    </div>
                  )}
                </>
              )}
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
            <label className="flex items-center gap-1.5" title="문항 난이도별로 모델을 자동 선택해 비용을 줄입니다.">
              난이도
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value as typeof profile)}
                className="rounded-md border border-slate-300 px-1.5 py-1 text-sm"
              >
                <option value="auto">자동 (권장)</option>
                <option value="easy">easy (저렴)</option>
                <option value="balanced">balanced</option>
                <option value="killer">killer (고비용)</option>
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

          {/* 실행 가능 여부 */}
          {(() => {
            const noInput = !questionText.trim() && !uploadedFile;
            const partialNoneSelected =
              !!uploadedFile && explanationMode === 'partial' && selectedQuestions.length === 0;
            const fullWithoutExtractWarning =
              !!uploadedFile && extractState.status === 'idle';
            const disabled = running || noInput || partialNoneSelected;
            return (
              <>
                {(partialNoneSelected || fullWithoutExtractWarning) && (
                  <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
                    {partialNoneSelected
                      ? '부분 해설 모드입니다 — 위에서 처리할 문항을 1개 이상 선택하세요.'
                      : '파일을 업로드했습니다 — 「문항 추출」 버튼으로 인식 결과를 먼저 확인하면 정확합니다. 그냥 실행해도 서버가 자동으로 추출합니다.'}
                  </p>
                )}
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={run}
                    disabled={disabled}
                    className="flex-1 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {running ? '처리 중...' : '실행'}
                  </button>
                  <button
                    onClick={retry}
                    disabled={disabled || !result}
                    className="rounded-md border border-indigo-600 bg-white px-3 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
                    title="같은 입력으로 다시 호출 (LLM이 다른 결과를 줄 수 있음)"
                  >
                    재시도
                  </button>
                </div>
                {running && (
                  <LiveProgressPanel
                    elapsedMs={liveElapsed}
                    progress={progress}
                  />
                )}
              </>
            );
          })()}
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
        <ResultsSection
          result={result}
          examName={examName}
          activeIdx={activeIdx}
          onActiveIdx={setActiveIdx}
          showTrace={showTrace}
          onToggleTrace={() => setShowTrace((v) => !v)}
          rating={rating}
          onRating={setRating}
          feedbackNote={feedbackNote}
          onFeedbackNote={setFeedbackNote}
          feedbackSaving={feedbackSaving}
          feedbackSaved={feedbackSaved}
          onSaveFeedback={saveFeedback}
          onDownloadJson={downloadJson}
          onCopyMd={copyAsMarkdown}
          onDownloadDocx={downloadDocx}
          onDownloadHml={downloadHml}
          onDownloadRunsCsv={downloadRunsCsv}
          onDownloadRunsJson={downloadRunsJson}
          driveUploadInfo={driveUploadInfo}
          canRunNextBatch={!!uploadedFile}
          running={running}
          onRunNextBatch={runNextBatch}
        />
      )}
    </div>
  );
}

function ResultsSection(props: {
  result: PipelineResponse;
  examName: string;
  activeIdx: number;
  onActiveIdx: (idx: number) => void;
  showTrace: boolean;
  onToggleTrace: () => void;
  rating: number | null;
  onRating: (n: number) => void;
  feedbackNote: string;
  onFeedbackNote: (s: string) => void;
  feedbackSaving: boolean;
  feedbackSaved: boolean;
  onSaveFeedback: () => void;
  onDownloadJson: () => void;
  onCopyMd: () => void;
  onDownloadDocx: (scope: 'active' | 'all') => void;
  onDownloadHml: (scope: 'active' | 'all') => void;
  onDownloadRunsCsv: () => void;
  onDownloadRunsJson: () => void;
  driveUploadInfo: { link: string | null; fileName: string; error: string | null } | null;
  /** 파일 업로드 모드일 때만 다음 batch 호출 가능 */
  canRunNextBatch: boolean;
  running: boolean;
  onRunNextBatch: (numbers: number[]) => Promise<void>;
}) {
  const { result, activeIdx, onActiveIdx } = props;
  const runs = result.runs ?? [];
  const isMulti = runs.length > 1;
  const successCount = runs.filter((r) => r.parsed).length;
  const active = runs[activeIdx] ?? runs[0];
  const totalCostCents = runs.reduce((s, r) => s + (r.approxCostCents ?? 0), 0);
  const [docxBusy, setDocxBusy] = useState<null | 'active' | 'all'>(null);
  const [hmlBusy, setHmlBusy] = useState<null | 'active' | 'all'>(null);
  const [previewScope, setPreviewScope] = useState<null | 'active' | 'all'>(null);
  async function handleDocx(scope: 'active' | 'all') {
    setDocxBusy(scope);
    try {
      await props.onDownloadDocx(scope);
    } finally {
      setDocxBusy(null);
    }
  }
  async function handleHml(scope: 'active' | 'all') {
    setHmlBusy(scope);
    try {
      await props.onDownloadHml(scope);
    } finally {
      setHmlBusy(null);
    }
  }

  // 응답이 최상위 error만 있는 경우 (예: invalid body)
  if (!active && result.error) {
    return (
      <div className="mt-6 rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
        <p className="font-semibold">요청 거부</p>
        <p className="mt-1 text-xs">{result.error}</p>
      </div>
    );
  }

  if (!active) return null;

  return (
    <section className="mt-6 space-y-4">
      {/* Drive 작업완료 자동 업로드 배너 */}
      {props.driveUploadInfo && (
        <div className={`rounded-lg border p-3 text-sm ${props.driveUploadInfo.link ? 'border-emerald-300 bg-emerald-50 text-emerald-950' : 'border-amber-300 bg-amber-50 text-amber-950'}`}>
          {props.driveUploadInfo.link ? (
            <p>
              ✓ Drive 「작업완료」 폴더에 자동 저장됨 — {' '}
              <a
                href={props.driveUploadInfo.link}
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-semibold"
              >
                {props.driveUploadInfo.fileName} 열기
              </a>
            </p>
          ) : (
            <p>
              ⚠ Drive 자동 업로드 실패 — 다운로드는 정상.
              {props.driveUploadInfo.error ? ` (${props.driveUploadInfo.error})` : ''}
            </p>
          )}
        </div>
      )}

      {/* 다중 문항 헤더 */}
      {isMulti && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-indigo-950">
              다중 문항 결과 — {successCount}/{runs.length} 성공
              {result.partialFailures && result.partialFailures > 0
                ? ` · ${result.partialFailures}개 검수 필요`
                : ''}
              {totalCostCents > 0 && (
                <span className="ml-2 text-[11px] font-normal text-indigo-800">
                  · 추정 합산 비용 ≈ ${(totalCostCents / 100).toFixed(3)}
                </span>
              )}
            </p>
            <div className="flex items-center gap-2">
              {result.extracted && (
                <span className="text-[11px] text-indigo-800">
                  추출: 총 {result.extracted.totalQuestions}문항 ·
                  {' '}처리 {result.extracted.selectedNumbers.join(', ')} ·
                  {' '}소스 {result.extracted.source}
                </span>
              )}
              <button
                onClick={() => setPreviewScope('all')}
                disabled={successCount === 0}
                className="rounded-md border border-indigo-300 bg-white px-3 py-1 text-[11px] font-semibold text-indigo-800 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
                title="DOCX 다운로드 전에 결과물이 어떻게 나올지 화면에서 미리보기"
              >
                📄 전체 미리보기
              </button>
              <button
                onClick={() => handleHml('all')}
                disabled={successCount === 0 || hmlBusy !== null}
                className="rounded-md border border-indigo-700 bg-indigo-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
                title="성공한 문항을 한 HWP/HML 파일로 묶어서 다운로드 — 한컴 한글에서 바로 열림 (메인 포맷)"
              >
                {hmlBusy === 'all' ? 'HWP 생성 중…' : `📕 전체 HWP (${successCount}문항)`}
              </button>
              <button
                onClick={() => handleDocx('all')}
                disabled={successCount === 0 || docxBusy !== null}
                className="rounded-md border border-slate-400 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                title="외부 공유·Google Drive 미리보기용 (보조 포맷). 학원 내부 작업은 HWP 권장"
              >
                {docxBusy === 'all' ? 'DOCX 중…' : `DOCX (${successCount})`}
              </button>
              <button
                onClick={props.onDownloadRunsCsv}
                className="rounded-md border border-amber-600 bg-amber-50 px-3 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
                title="문항별 성공/실패·오류·검수 체크리스트를 CSV로 — 실패 원인 분석용"
              >
                실패 분석 CSV
              </button>
              <button
                onClick={props.onDownloadRunsJson}
                className="rounded-md border border-slate-400 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                title="실행 결과와 trace 전체 JSON 다운로드"
              >
                전체 JSON
              </button>
            </div>
          </div>
          {/* 문항 탭 */}
          <div className="mt-2 flex flex-wrap gap-1">
            {runs.map((r, i) => (
              <button
                key={r.runId || `${r.questionNo}-${i}`}
                onClick={() => onActiveIdx(i)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-semibold ${
                  i === activeIdx
                    ? 'bg-indigo-700 text-white'
                    : r.parsed
                      ? 'border border-emerald-400 bg-white text-emerald-900 hover:bg-emerald-50'
                      : 'border border-rose-400 bg-white text-rose-900 hover:bg-rose-50'
                }`}
              >
                {r.parsed ? '✓' : '✗'} {r.questionNo}번
              </button>
            ))}
          </div>
          {/*
            다음 batch 안내·버튼 — 추출된 totalQuestions > 처리된 selectedNumbers 일 때 노출.
            서버 MAX_QUESTIONS_PER_REQUEST=10 을 그대로 두고 UI 가 10개씩 누적 호출.
            사용자 답: 「10개 결과 확인 후, 좋으면 계속/이상하면 피드백 후 중단」.
          */}
          {result.extracted &&
            result.extracted.totalQuestions > (result.extracted.selectedNumbers?.length ?? 0) &&
            props.canRunNextBatch &&
            (() => {
              const total = result.extracted!.totalQuestions;
              const done = new Set(result.extracted!.selectedNumbers ?? []);
              const remaining = Array.from({ length: total }, (_, i) => i + 1).filter(
                (n) => !done.has(n),
              );
              const next = remaining.slice(0, 10);
              return (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
                  <span className="font-semibold">
                    📦 전체 {total}문항 중 {done.size}개 처리됨 · 남은 {remaining.length}개
                  </span>
                  <span className="text-amber-700">
                    결과를 검토 후, 좋으면 다음 {next.length}개를 이어서 처리하세요. 이상하면
                    별점·피드백을 남기고 멈추면 됩니다.
                  </span>
                  <button
                    onClick={() => props.onRunNextBatch(next)}
                    disabled={props.running || next.length === 0}
                    className="ml-auto rounded-md border border-amber-700 bg-amber-700 px-3 py-1 font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
                    title={`다음 ${next.length}개 (${next[0]}~${next[next.length - 1]}번) 이어서 처리`}
                  >
                    {props.running
                      ? '처리 중…'
                      : `▶ 다음 ${next.length}개 처리 (${next[0]}~${next[next.length - 1]}번)`}
                  </button>
                </div>
              );
            })()}
        </div>
      )}

      {/* 활성 문항 결과 + Trace */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {isMulti ? `[${active.questionNo}번] ` : ''}
                결과 {active.parsed ? '✓' : '✗'}
              </h2>
              {(active.profile || active.usedModel) && (
                <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px]">
                  {active.profile && (
                    <span
                      className={`rounded px-1.5 py-0.5 font-semibold ${
                        active.profile === 'killer'
                          ? 'bg-rose-100 text-rose-900'
                          : active.profile === 'easy'
                            ? 'bg-emerald-100 text-emerald-900'
                            : 'bg-slate-100 text-slate-800'
                      }`}
                      title={active.profileReason ?? ''}
                    >
                      {active.profile}
                    </span>
                  )}
                  {active.usedModel && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700">
                      {active.usedVendor === 'openai' ? '⊙' : '◇'} {active.usedModel}
                    </span>
                  )}
                  {typeof active.approxCostCents === 'number' && active.approxCostCents > 0 && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">
                      ≈ ${(active.approxCostCents / 100).toFixed(4)}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setPreviewScope('active')}
                disabled={!active.parsed}
                className="rounded border border-emerald-300 bg-white px-2 py-1 text-[11px] font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
                title="이 문항이 DOCX에서 어떻게 나올지 미리보기"
              >
                📄 미리보기
              </button>
              <button
                onClick={() => handleHml('active')}
                disabled={!active.parsed || hmlBusy !== null}
                className="rounded border border-indigo-700 bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                title="이 문항을 HWP/HML 로 다운로드 — 한컴 한글에서 바로 열림 (메인 포맷)"
              >
                {hmlBusy === 'active' ? 'HWP…' : '📕 HWP'}
              </button>
              <button
                onClick={() => handleDocx('active')}
                disabled={!active.parsed || docxBusy !== null}
                className="rounded border border-slate-400 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                title="외부 공유·Drive 미리보기 등 보조 용도"
              >
                {docxBusy === 'active' ? 'DOCX…' : 'DOCX'}
              </button>
              <button
                onClick={props.onDownloadJson}
                disabled={!active.parsed}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                JSON
              </button>
              <button
                onClick={props.onCopyMd}
                disabled={!active.parsed}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                MD 복사
              </button>
            </div>
          </div>

          {active.parsed ? (
            <ResultView parsed={active.parsed} />
          ) : (
            <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
              <p className="font-semibold">실패 ({active.attempts}회 시도)</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
                {active.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          {active.manualReviewChecklist.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
              <p className="font-semibold">수동 검수 권장</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {active.manualReviewChecklist.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          {/* 💡 유사 기출 — RAG 가 매칭한 비슷한 문제 추천 카드 */}
          {active.similarReferences && active.similarReferences.length > 0 && (
            <div className="mt-3 rounded-md border border-blue-200 bg-blue-50/50 p-3 text-xs">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-blue-900">
                  💡 비슷한 기출/예제 ({active.similarReferences.length}건)
                </p>
                <a
                  href={`/api/drive/analysis/search?q=${encodeURIComponent(active.questionText.slice(0, 80))}&limit=20`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-blue-700 hover:underline"
                >
                  더 보기 →
                </a>
              </div>
              <p className="mt-0.5 text-[10px] text-blue-700">
                이 문제와 가장 유사한 분석자료(KB·시중교재) 매칭. 학원 큐레이션·심화 학습용.
              </p>
              <ul className="mt-2 space-y-1.5">
                {active.similarReferences.map((r) => (
                  <li
                    key={r.id}
                    className="rounded border border-blue-200 bg-white p-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-slate-800">
                        {r.problem_hint || r.source}
                        {typeof r.problem_no === 'number' && (
                          <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-600">
                            {r.problem_no}번
                          </span>
                        )}
                        {r.hasSolution && (
                          <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] text-amber-800">풀이 ✓</span>
                        )}
                      </p>
                    </div>
                    <p className="mt-0.5 text-[10px] text-slate-500">{r.source}</p>
                    <p className="mt-1 text-slate-700">{r.snippet}{r.snippet.length >= 200 ? '…' : ''}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {active.persistError && (
            <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
              영속화 실패: {active.persistError}
            </div>
          )}

          {/* 피드백 — 활성 문항의 별점·메모. 탭 전환 시 자동 리셋. */}
          {active.runId && active.parsed && (
            <FeedbackPanel
              rating={props.rating}
              onRating={props.onRating}
              note={props.feedbackNote}
              onNote={props.onFeedbackNote}
              saving={props.feedbackSaving}
              saved={props.feedbackSaved}
              onSave={props.onSaveFeedback}
            />
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-slate-900 p-4 text-slate-100 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-100">
              실행 로그 {isMulti ? `· ${active.questionNo}번` : ''}
            </h2>
            <button
              onClick={props.onToggleTrace}
              className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-700"
            >
              {props.showTrace ? '요약' : '전체 JSON'}
            </button>
          </div>
          <div className="max-h-[480px] overflow-auto font-mono text-[11px] leading-relaxed">
            {props.showTrace
              ? active.trace.map((t, i) => (
                  <div key={i} className="border-b border-slate-700 py-1">
                    {JSON.stringify(t)}
                  </div>
                ))
              : active.trace.map((t, i) => <TraceLine key={i} event={t} />)}
          </div>
        </div>
      </div>

      {previewScope && (
        <DocxPreviewModal
          examName={props.examName}
          runs={previewScope === 'all' ? runs.filter((r) => r.parsed) : [active].filter((r) => r.parsed)}
          onClose={() => setPreviewScope(null)}
        />
      )}
    </section>
  );
}

/**
 * 실행 중 라이브 진행률 패널.
 * 백엔드 /api/auto-pipeline/progress 폴링 결과 + 클라이언트 1초 단위 경과시간을 결합해 표시.
 * 다중 문항이면 진행 바·현재 문항·세부 단계, 단일 문항이면 경과 시간 + 단계만.
 */
function LiveProgressPanel({
  elapsedMs,
  progress,
}: {
  elapsedMs: number;
  progress: {
    stage: 'idle' | 'preparing' | 'processing' | 'completed' | 'failed';
    currentIdx: number;
    total: number;
    currentNo: string | null;
    subStage:
      | null
      | 'searching'
      | 'generating'
      | 'validating'
      | 'retrying'
      | 'persisting';
    completedCount: number;
  } | null;
}) {
  const sec = Math.floor(elapsedMs / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');

  // 한 문항 평균 ≈ 25초 (RAG 검색 + LLM + 검증 + 영속화 합산 경험치). 실제 처리량으로 보정.
  const SEC_PER_QUESTION_DEFAULT = 25;
  const avgSecPerQ =
    progress && progress.completedCount > 0 && elapsedMs > 0
      ? Math.max(8, Math.round(elapsedMs / 1000 / progress.completedCount))
      : SEC_PER_QUESTION_DEFAULT;

  const total = progress?.total ?? 0;
  const done = progress?.completedCount ?? 0;
  const remaining = Math.max(total - done, 0);
  const etaSec = remaining * avgSecPerQ;
  const etaMm = String(Math.floor(etaSec / 60)).padStart(2, '0');
  const etaSs = String(etaSec % 60).padStart(2, '0');

  const subStageLabel: Record<string, string> = {
    searching: '참고 예시 검색',
    generating: 'LLM 풀이 생성',
    validating: '검증 단계',
    retrying: '재시도',
    persisting: '결과 저장',
  };

  const stageMsg = progress
    ? progress.stage === 'preparing'
      ? '입력 파싱·문항 추출 중'
      : progress.stage === 'processing'
        ? `${progress.currentNo ?? '?'}번 문항 ${
            progress.subStage ? `· ${subStageLabel[progress.subStage] ?? progress.subStage}` : ''
          }`
        : progress.stage === 'completed'
          ? '결과 정리 중'
          : progress.stage === 'failed'
            ? '에러 발생'
            : '준비 중'
    : '시작 중…';

  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;

  return (
    <div className="mt-3 rounded-md border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-950">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">⏳ 처리 중 — {stageMsg}</span>
        <span className="font-mono text-[11px] text-indigo-800">
          경과 {mm}:{ss}
          {total > 1 && remaining > 0 && (
            <> · 남은 시간 ≈ {etaMm}:{etaSs}</>
          )}
        </span>
      </div>
      {total > 1 && (
        <>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-indigo-100">
            <div
              className="h-full bg-indigo-600 transition-all duration-500"
              style={{ width: `${pct ?? 0}%` }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-indigo-800">
            <span>
              {done} / {total} 문항 완료
              {pct !== null && ` (${pct}%)`}
            </span>
            <span>한 문항 평균 ≈ {avgSecPerQ}초</span>
          </div>
        </>
      )}
      <p className="mt-2 text-[10px] text-indigo-700">
        💡 1문항 처리에는 RAG 검색 → LLM → 검증 → (필요시) 재시도가 포함되어 25~40초 정도 걸립니다.
        창을 닫지 마세요 — 화면 닫으면 결과가 표시되지 않습니다 (백엔드는 계속 작동).
      </p>
    </div>
  );
}

/**
 * DOCX 다운로드 전 결과물이 어떻게 나올지 보여주는 미리보기 모달.
 * 실제 DOCX 레이아웃(수학영역 헤더 → 시험명(해설) → 문항별 [정답]·[해설])을 흉내낸 A4 종이 스타일.
 * 화면에서 미리 검토하거나 브라우저 인쇄(Ctrl+P)로 PDF 저장도 가능.
 */
function DocxPreviewModal({
  examName,
  runs,
  onClose,
}: {
  examName: string;
  runs: RunRow[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const displayName = (examName || '미지정시험지').trim();
  const today = new Date();
  const dateStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;

  function handlePrint() {
    window.print();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-900/70 backdrop-blur-sm print:bg-white print:backdrop-blur-none"
      role="dialog"
      aria-modal="true"
    >
      {/* 헤더 (인쇄 시 숨김) */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 shadow-sm print:hidden">
        <div className="flex items-baseline gap-3">
          <h3 className="text-sm font-semibold text-slate-900">📄 DOCX 결과물 미리보기</h3>
          <span className="text-[11px] text-slate-500">
            {runs.length}문항 · 실제 DOCX 레이아웃과 거의 동일 · 인쇄(Ctrl+P)로 PDF 저장 가능
          </span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handlePrint}
            className="rounded border border-slate-700 bg-slate-700 px-3 py-1 text-[11px] font-semibold text-white hover:bg-slate-800"
            title="브라우저 인쇄 → PDF로 저장 가능 (Ctrl+P)"
          >
            🖨 인쇄·PDF
          </button>
          <button
            onClick={onClose}
            className="rounded border border-slate-300 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
            title="닫기 (Esc)"
          >
            ✕ 닫기
          </button>
        </div>
      </div>

      {/* 종이 영역 */}
      <div className="flex-1 overflow-auto bg-slate-200 p-6 print:overflow-visible print:bg-white print:p-0">
        <div className="mx-auto flex max-w-[820px] flex-col gap-6 print:max-w-none print:gap-0">
          {/* 표지 */}
          <article className="docx-page rounded bg-white p-12 shadow-lg print:rounded-none print:shadow-none">
            <h1 className="text-center text-xl font-bold text-slate-900">수학영역</h1>
            <h2 className="mt-1 text-center text-lg font-bold text-slate-900">
              {displayName}(해설)
            </h2>
            <p className="mt-3 text-center text-[11px] text-slate-500">{dateStr}</p>
          </article>

          {runs.length === 0 ? (
            <article className="docx-page rounded bg-white p-12 text-center text-sm text-slate-500 shadow-lg print:rounded-none print:shadow-none">
              미리보기에 표시할 성공한 문항이 없습니다.
            </article>
          ) : (
            runs.map((r, idx) => (
              <article
                key={r.runId || `${r.questionNo}-${idx}`}
                className="docx-page rounded bg-white p-12 shadow-lg print:rounded-none print:shadow-none"
              >
                <div className="border-b border-slate-300 pb-2">
                  <span className="text-base font-bold text-slate-900">
                    [문항 {r.questionNo || idx + 1}]
                  </span>
                </div>
                {r.parsed && (
                  <>
                    <div className="mt-3 flex items-baseline gap-2">
                      <span className="text-sm font-semibold text-slate-900">[정답]</span>
                      <span className="text-sm font-bold text-slate-900">
                        <MathText text={r.parsed.answer} />
                      </span>
                    </div>
                    <div className="mt-4">
                      <p className="text-sm font-semibold text-slate-900">[해설]</p>
                      <ol className="mt-2 list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-slate-900">
                        {r.parsed.explanation_steps.map((s, i) => (
                          <li key={i}>
                            <div>
                              <MathText text={s.text} />
                            </div>
                            {s.equation && (
                              <div className="mt-1">
                                <EquationBlock tex={s.equation} />
                              </div>
                            )}
                          </li>
                        ))}
                      </ol>
                      {r.parsed.summary && (
                        <p className="mt-3 text-[12px] text-slate-700">
                          <MathText text={r.parsed.summary} />
                        </p>
                      )}
                    </div>
                  </>
                )}
              </article>
            ))
          )}
        </div>
      </div>

      <style jsx global>{`
        .docx-page {
          width: 100%;
          min-height: 1100px;
          font-family: 'Malgun Gothic', '맑은 고딕', 'Noto Sans KR', sans-serif;
        }
        @media print {
          .docx-page {
            page-break-after: always;
            box-shadow: none;
            min-height: auto;
          }
          .docx-page:last-child {
            page-break-after: auto;
          }
          @page {
            size: A4;
            margin: 18mm 16mm;
          }
        }
      `}</style>
    </div>
  );
}

/**
 * `$...$` 인라인 수식이 섞인 텍스트를 KaTeX로 렌더한다.
 * 매칭 실패 시 평문으로 폴백 (LLM이 미완성 수식을 줘도 화면이 깨지지 않게).
 */
function MathText({ text }: { text: string }) {
  if (!text) return null;
  // LLM 이 가끔 \(..\) / \[..\] LaTeX 표기를 보내므로 $..$ / $$..$$ 로 정규화
  const normalized = text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, inner: string) => `$$${inner}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, inner: string) => `$${inner}$`);
  // $$...$$ (블록) 와 $...$ (인라인) 모두 지원
  const parts: Array<{ type: 'text' | 'inline' | 'block'; value: string }> = [];
  const re = /(\$\$[^$]+\$\$|\$[^$\n]+\$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized))) {
    if (m.index > last) parts.push({ type: 'text', value: normalized.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith('$$')) {
      parts.push({ type: 'block', value: token.slice(2, -2) });
    } else {
      parts.push({ type: 'inline', value: token.slice(1, -1) });
    }
    last = m.index + token.length;
  }
  if (last < normalized.length) parts.push({ type: 'text', value: normalized.slice(last) });

  return (
    <>
      {parts.map((p, i) => {
        if (p.type === 'text') return <span key={i}>{p.value}</span>;
        try {
          return p.type === 'block' ? (
            <BlockMath key={i} math={p.value} />
          ) : (
            <InlineMath key={i} math={p.value} />
          );
        } catch {
          return (
            <span key={i} className="rounded bg-rose-50 px-1 font-mono text-[11px] text-rose-800" title="수식 렌더 실패">
              {p.type === 'block' ? `$$${p.value}$$` : `$${p.value}$`}
            </span>
          );
        }
      })}
    </>
  );
}

/** equation 필드 단독 렌더 (BlockMath). 내부에 $ 없이 raw LaTeX 가정. */
function EquationBlock({ tex }: { tex: string }) {
  const cleaned = tex.replace(/^\$\$?|\$\$?$/g, '').trim();
  if (!cleaned) return null;
  try {
    return (
      <div className="overflow-x-auto rounded bg-slate-50 px-2 py-1 text-slate-900">
        <BlockMath math={cleaned} />
      </div>
    );
  } catch {
    return (
      <div className="mt-0.5 rounded bg-rose-50 px-2 py-1 font-mono text-[12px] text-rose-800" title="수식 렌더 실패 — 원본 표시">
        {tex}
      </div>
    );
  }
}

function ResultView({ parsed }: { parsed: ParsedExplanation }) {
  return (
    <div className="space-y-3 text-sm text-slate-900">
      <div className="rounded-md bg-emerald-50 p-3">
        <span className="text-xs font-semibold text-emerald-900">정답</span>
        <div className="mt-0.5 text-base font-bold text-emerald-950">
          <MathText text={parsed.answer} />
        </div>
      </div>
      <div>
        <span className="text-xs font-semibold text-slate-700">
          풀이 단계 ({parsed.explanation_steps.length})
        </span>
        <ol className="mt-1 list-decimal space-y-2 pl-5">
          {parsed.explanation_steps.map((s, i) => (
            <li key={i}>
              <div className="leading-relaxed">
                <MathText text={s.text} />
              </div>
              {s.equation && (
                <div className="mt-1">
                  <EquationBlock tex={s.equation} />
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
      {parsed.summary && (
        <div className="rounded-md bg-slate-50 p-3 text-xs">
          <span className="font-semibold text-slate-700">요약 </span>
          <span className="text-slate-800">
            <MathText text={parsed.summary} />
          </span>
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

// ── 운영 가시성 배지 ────────────────────────────────────────────────────────
// 자동 파이프라인 헬스체크 (`GET /api/auto-pipeline`) 결과를 압축해서 보여준다.
// - KB N건 + 마지막 동기화 시각 → 분석자료가 따라오고 있는지 즉시 확인
// - 화이트리스트 매칭 0건 등 lastErrors 가 있으면 빨간 배지로 강조
// - 감독관 HIGH 제안이 있으면 호박색 배지 + /api/retrospective 링크
type HealthBadgesProps = {
  health: {
    kb_size: number;
    drive_sync: {
      lastRunAt: number | null;
      lastOk: boolean;
      lastNewOrChanged: number;
      lastTotalFiles: number;
      lastErrors: string[];
      intervalMs: number;
      lastByRootFolder?: Record<
        string,
        { filesFound: number; sizeSkipped: number; ocrFailed: number; cacheHit: number; newOrChanged: number }
      >;
    } | null;
    supervisor: {
      ranAt: number | null;
      ok: boolean;
      totalRuns: number;
      successRate: number;
      avgUserRating: number | null;
      highPrioritySuggestions: Array<{ priority: string; area: string; finding: string }>;
      suggestionsCount: number;
      pairingRate: number | null;
      integrityIssues?: { missing: number; duplicate: number; unpaired: number };
      error: string | null;
    } | null;
  } | null;
};

function HealthBadges({ health }: HealthBadgesProps) {
  if (!health) return null;
  const sync = health.drive_sync;
  const sup = health.supervisor;
  const syncWarn = !!(sync?.lastErrors?.length);
  const highCount = sup?.highPrioritySuggestions?.length ?? 0;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span
        className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-slate-700"
        title="자동 파이프라인이 검색에 사용하는 참고 예시 KB 크기 (kb.jsonl + Drive 분석자료)"
      >
        KB {health.kb_size}건
      </span>
      {sync && (
        <a
          href="/api/drive/analysis/diagnose"
          target="_blank"
          rel="noopener noreferrer"
          className={`rounded border px-1.5 py-0.5 hover:underline underline-offset-2 ${
            sync.intervalMs === 0
              ? 'border-rose-400 bg-rose-100 text-rose-900 font-semibold'
              : syncWarn
                ? 'border-rose-300 bg-rose-50 text-rose-800'
                : 'border-emerald-300 bg-emerald-50 text-emerald-800'
          }`}
          title={(() => {
            const lines: string[] = [];
            if (sync.intervalMs === 0) {
              lines.push('🔴 자동 백그라운드 동기화 OFF');
              lines.push('Railway env: DRIVE_ANALYSIS_AUTO_SYNC_MS 를 삭제하거나 14400000(4h)로 설정');
              lines.push('현재 「분석자료 새로 학습」 수동 클릭 외엔 학습 안 됨');
            } else {
              if (syncWarn) lines.push(`경고: ${sync.lastErrors.slice(0, 2).join(' / ')}`);
              lines.push(`주기 ${Math.round(sync.intervalMs / 60000)}분, 마지막 새/변경 ${sync.lastNewOrChanged}건`);
            }
            const folders = sync.lastByRootFolder ?? {};
            for (const [name, stat] of Object.entries(folders)) {
              const flags: string[] = [];
              if (stat.sizeSkipped > 0) flags.push(`size-skip ${stat.sizeSkipped}`);
              if (stat.ocrFailed > 0) flags.push(`ocr-fail ${stat.ocrFailed}`);
              if (stat.filesFound > 0 && stat.newOrChanged === 0 && stat.cacheHit === 0) flags.push('처리 0건');
              const tag = flags.length > 0 ? ` ⚠ ${flags.join(', ')}` : '';
              lines.push(`· ${name}: ${stat.filesFound}개 (캐시 ${stat.cacheHit}, 신규 ${stat.newOrChanged})${tag}`);
            }
            lines.push('(클릭: /api/drive/analysis/diagnose 진단)');
            return lines.join('\n');
          })()}
        >
          {sync.intervalMs === 0
            ? '자동sync 🔴 OFF'
            : `분석자료 ${sync.lastRunAt ? `${formatRelative(sync.lastRunAt)} 동기화` : '미실행'}`}
          {syncWarn && sync.intervalMs !== 0 && ' ⚠'}
        </a>
      )}
      {sup && sup.ranAt && (
        <a
          href="/api/retrospective?format=md"
          target="_blank"
          rel="noopener noreferrer"
          className={`rounded border px-1.5 py-0.5 underline-offset-2 hover:underline ${
            highCount > 0
              ? 'border-amber-400 bg-amber-50 text-amber-900'
              : 'border-slate-300 bg-white text-slate-700'
          }`}
          title={
            highCount > 0
              ? `감독관: HIGH ${highCount}건 — ${sup.highPrioritySuggestions[0]?.area} 등`
              : `감독관 자동 분석: ${sup.totalRuns}건 / 성공률 ${(sup.successRate * 100).toFixed(0)}%${sup.avgUserRating !== null ? ` / 평균 ★${sup.avgUserRating.toFixed(1)}` : ''}`
          }
        >
          감독관 {highCount > 0 ? `🔴 HIGH ${highCount}` : '✓ 정상'}
        </a>
      )}
      {sup && sup.pairingRate !== null && (
        <span
          className={`rounded border px-1.5 py-0.5 ${
            sup.pairingRate < 0.4
              ? 'border-rose-300 bg-rose-50 text-rose-800'
              : sup.pairingRate < 0.7
                ? 'border-amber-300 bg-amber-50 text-amber-900'
                : 'border-emerald-300 bg-emerald-50 text-emerald-800'
          }`}
          title="시중교재 OCR 결과 중 [문제 ↔ 풀이] 1:1 페어 매핑 성공 비율. 낮으면 analysisTextNormalizer 패턴 보강 또는 이미지 보정 필요."
        >
          페어매핑 {(sup.pairingRate * 100).toFixed(0)}%
        </span>
      )}
      {sup?.integrityIssues && (sup.integrityIssues.missing + sup.integrityIssues.duplicate + sup.integrityIssues.unpaired > 0) && (
        <a
          href="/api/drive/analysis/diagnose"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded border border-amber-400 bg-amber-50 px-1.5 py-0.5 text-amber-900 underline-offset-2 hover:underline"
          title={`시리즈 누락 ${sup.integrityIssues.missing} / 중복 ${sup.integrityIssues.duplicate} / 페어 깨짐 ${sup.integrityIssues.unpaired}\n클릭: 진단 페이지에서 어떤 PDF·번호인지 확인 + 추천 액션`}
        >
          무결성 ⚠ {sup.integrityIssues.missing + sup.integrityIssues.duplicate + sup.integrityIssues.unpaired}
        </a>
      )}
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '방금';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}시간 전`;
  return `${Math.round(diff / 86_400_000)}일 전`;
}
