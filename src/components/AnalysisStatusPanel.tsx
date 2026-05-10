'use client';

/**
 * AnalysisStatusPanel
 * ────────────────────────────────────────────────────────────────────────────
 *  「분석 현황」 패널 — 시중교재 / 시험지 원안 / 기타 폴더가 얼마나 학습됐는지를
 *  한눈에 자세히 보여준다.
 *
 *  데이터 소스: GET /api/drive/analysis/diagnose
 *    - rootFolders: Drive 폴더 트리 + 사이즈 분포 + 처리 결과
 *    - integrity: 누락/중복/페어 깨짐 + series 별 record 통계
 *    - recommendations: 자동 추천 액션
 *
 *  비용: 진단 라우트는 Drive list API + Supabase select 만 호출 (다운로드/OCR X).
 *  사용자가 패널 펼칠 때만 fetch — 30초 캐시 + 새로고침 버튼.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

type RootFolderStat = {
  totalFiles: number;
  whitelisted: boolean;
  sizeBuckets: Record<string, number>;
  sizeSkipExpected: number;
  tooSmallExpected: number;
  sampleSkips: Array<{ name: string; sizeMB: string }>;
  sampleEligible: Array<{ name: string; sizeMB: string }>;
};

type IntegrityIssue =
  | { kind: 'missing'; series: string; missingNos: number[]; range: [number, number]; knownCount: number }
  | { kind: 'duplicate'; series: string; problemNo: number; sources: string[]; contentDigests: string[] }
  | { kind: 'unpaired'; series: string; problemNo: number; side: 'missing-solution' | 'missing-problem'; source: string; contentSnippet: string };

type SeriesStat = {
  series: string;
  rootFolder: string;
  sourceFile: string;
  totalRecords: number;
  withProblemNo: number;
  paired: number;
  pairingRate: number;
  problemNos: { min: number | null; max: number | null; count: number };
};

type DiagnoseResponse = {
  ok: boolean;
  driveAnalysisFolderId?: string;
  rootFolders?: Record<string, RootFolderStat>;
  noRootFilesCount?: number;
  sizeLimitMb?: number;
  pdfLimitMb?: number;
  minKb?: number;
  config?: { allowedRoots: string[]; sizeLimitMb: number; minKb: number };
  integrity?: {
    totalRecords: number;
    totalSeries: number;
    counts: { missing: number; duplicate: number; unpaired: number };
    issues: IntegrityIssue[];
    seriesStats: SeriesStat[];
    perRootRecordCounts: Record<string, number>;
  } | null;
  recommendations?: Array<{ priority: 'high' | 'medium' | 'low'; action: string; detail: string }>;
  error?: string;
};

export function AnalysisStatusPanel() {
  const [data, setData] = useState<DiagnoseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'whitelist' | 'unmatched'>('all');
  const [expandedFolder, setExpandedFolder] = useState<string | null>(null);
  const [issueKindFilter, setIssueKindFilter] = useState<'all' | 'missing' | 'duplicate' | 'unpaired'>('all');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/drive/analysis/diagnose');
      const json: DiagnoseResponse = await res.json();
      if (!json.ok) {
        setError(json.error || '진단 실패');
        setData(null);
      } else {
        setData(json);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const t = setInterval(() => void fetchData(), 60_000);  // 60초 자동 갱신
    return () => clearInterval(t);
  }, [fetchData]);

  const folders = useMemo(() => {
    if (!data?.rootFolders) return [];
    const entries = Object.entries(data.rootFolders);
    if (filter === 'whitelist') return entries.filter(([, s]) => s.whitelisted);
    if (filter === 'unmatched') return entries.filter(([, s]) => !s.whitelisted);
    return entries;
  }, [data, filter]);

  const filteredIssues = useMemo(() => {
    const issues = data?.integrity?.issues || [];
    if (issueKindFilter === 'all') return issues;
    return issues.filter((i) => i.kind === issueKindFilter);
  }, [data, issueKindFilter]);

  if (loading && !data) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        분석 현황 로딩 중…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
        진단 실패: {error}
      </div>
    );
  }
  if (!data) return null;

  const integrity = data.integrity;
  const recs = data.recommendations || [];
  const allowedRoots = data.config?.allowedRoots || [];

  // 전체 요약
  const totalFiles = Object.values(data.rootFolders || {}).reduce((s, f) => s + f.totalFiles, 0);
  const totalSizeSkipped = Object.values(data.rootFolders || {}).reduce((s, f) => s + f.sizeSkipExpected, 0);
  const totalRecords = integrity?.totalRecords ?? 0;
  const totalIssues = integrity ? integrity.counts.missing + integrity.counts.duplicate + integrity.counts.unpaired : 0;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
      {/* ─── 헤더 + 새로고침 ─────────────────────────────────────────── */}
      <div className="mb-4 flex items-center justify-between gap-2 border-b border-slate-200 pb-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">분석 현황</h2>
          <p className="mt-0.5 text-xs text-slate-600">
            Drive 「분석용 자료」 → Supabase analysis_records 학습 진행 상태
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {loading ? '갱신 중…' : '새로고침'}
        </button>
      </div>

      {/* ─── 4분할 KPI 카드 ─────────────────────────────────────────── */}
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        <KpiCard label="Drive 파일" value={totalFiles} hint={`${Object.keys(data.rootFolders || {}).length}개 폴더`} />
        <KpiCard label="DB record" value={totalRecords} hint={`${integrity?.totalSeries ?? 0}개 시리즈`} />
        <KpiCard
          label="사이즈 skip"
          value={totalSizeSkipped}
          hint={`이미지 ${data.sizeLimitMb}MB / PDF ${data.pdfLimitMb}MB 초과`}
          warn={totalSizeSkipped > 0}
        />
        <KpiCard
          label="무결성 이슈"
          value={totalIssues}
          hint={
            integrity
              ? `누락 ${integrity.counts.missing} · 중복 ${integrity.counts.duplicate} · 페어 ${integrity.counts.unpaired}`
              : 'DB 미연결'
          }
          warn={totalIssues > 0}
        />
      </div>

      {/* ─── 폴더별 카드 ───────────────────────────────────────────── */}
      <section className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold text-slate-800">폴더별 진행 상태</h3>
          <div className="flex gap-1 text-[11px]">
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
              전체 ({Object.keys(data.rootFolders || {}).length})
            </FilterChip>
            <FilterChip active={filter === 'whitelist'} onClick={() => setFilter('whitelist')}>
              화이트리스트 ({Object.values(data.rootFolders || {}).filter((s) => s.whitelisted).length})
            </FilterChip>
            <FilterChip active={filter === 'unmatched'} onClick={() => setFilter('unmatched')}>
              미매칭 ({Object.values(data.rootFolders || {}).filter((s) => !s.whitelisted).length})
            </FilterChip>
          </div>
        </div>
        {folders.length === 0 ? (
          <p className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            해당 조건의 폴더가 없습니다.
          </p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {folders.map(([name, stat]) => {
              const dbCount = integrity?.perRootRecordCounts?.[name] ?? 0;
              const opened = expandedFolder === name;
              return (
                <FolderCard
                  key={name}
                  name={name}
                  stat={stat}
                  dbRecordCount={dbCount}
                  expanded={opened}
                  onToggle={() => setExpandedFolder(opened ? null : name)}
                />
              );
            })}
          </div>
        )}
        {data.noRootFilesCount && data.noRootFilesCount > 0 ? (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">
            ⚠ 「분석용 자료」 루트 직속(서브폴더 X)에 {data.noRootFilesCount}개 파일이 있어 학습 대상이 아닙니다 — 시중교재/시험지 원안 폴더 안으로 옮기세요.
          </p>
        ) : null}
        {allowedRoots.length > 0 ? (
          <p className="mt-2 text-[11px] text-slate-500">
            화이트리스트(env DRIVE_ANALYSIS_ALLOWED_ROOT_FOLDERS): <code className="rounded bg-slate-100 px-1">{allowedRoots.join(', ')}</code>
          </p>
        ) : null}
      </section>

      {/* ─── 시리즈별 record 통계 표 ───────────────────────────────── */}
      {integrity && integrity.seriesStats.length > 0 && (
        <section className="mb-5">
          <h3 className="mb-2 font-semibold text-slate-800">시리즈별 record 통계 (상위 30)</h3>
          <div className="overflow-x-auto rounded border border-slate-200">
            <table className="w-full text-[11px]">
              <thead className="bg-slate-50 text-slate-700">
                <tr>
                  <th className="border-b border-slate-200 px-2 py-1.5 text-left">시리즈</th>
                  <th className="border-b border-slate-200 px-2 py-1.5 text-left">폴더</th>
                  <th className="border-b border-slate-200 px-2 py-1.5 text-right">record</th>
                  <th className="border-b border-slate-200 px-2 py-1.5 text-right">번호 보유</th>
                  <th className="border-b border-slate-200 px-2 py-1.5 text-right">페어링</th>
                  <th className="border-b border-slate-200 px-2 py-1.5 text-left">문항 범위</th>
                </tr>
              </thead>
              <tbody>
                {integrity.seriesStats.slice(0, 30).map((s) => {
                  const rate = (s.pairingRate * 100).toFixed(0);
                  const rateColor =
                    s.pairingRate >= 0.7
                      ? 'text-emerald-700'
                      : s.pairingRate >= 0.4
                        ? 'text-amber-700'
                        : 'text-rose-700';
                  return (
                    <tr key={s.series} className="hover:bg-slate-50">
                      <td className="border-b border-slate-100 px-2 py-1 font-mono text-slate-800">
                        {truncate(s.series, 40)}
                      </td>
                      <td className="border-b border-slate-100 px-2 py-1 text-slate-600">{s.rootFolder}</td>
                      <td className="border-b border-slate-100 px-2 py-1 text-right text-slate-800">{s.totalRecords}</td>
                      <td className="border-b border-slate-100 px-2 py-1 text-right text-slate-600">{s.withProblemNo}</td>
                      <td className={`border-b border-slate-100 px-2 py-1 text-right font-semibold ${rateColor}`}>
                        {s.withProblemNo > 0 ? `${s.paired}/${s.withProblemNo} (${rate}%)` : '—'}
                      </td>
                      <td className="border-b border-slate-100 px-2 py-1 text-slate-600">
                        {s.problemNos.min !== null && s.problemNos.max !== null
                          ? `${s.problemNos.min}~${s.problemNos.max} (${s.problemNos.count}개)`
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {integrity.seriesStats.length > 30 && (
            <p className="mt-1 text-[11px] text-slate-500">
              … 외 {integrity.seriesStats.length - 30}개 시리즈 (전체 보려면 <code>/api/drive/analysis/diagnose</code>)
            </p>
          )}
        </section>
      )}

      {/* ─── 무결성 이슈 표 ───────────────────────────────────────── */}
      {integrity && integrity.issues.length > 0 && (
        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold text-slate-800">무결성 이슈 ({integrity.issues.length}건)</h3>
            <div className="flex gap-1 text-[11px]">
              <FilterChip active={issueKindFilter === 'all'} onClick={() => setIssueKindFilter('all')}>전체</FilterChip>
              <FilterChip active={issueKindFilter === 'missing'} onClick={() => setIssueKindFilter('missing')}>
                누락 {integrity.counts.missing}
              </FilterChip>
              <FilterChip active={issueKindFilter === 'duplicate'} onClick={() => setIssueKindFilter('duplicate')}>
                중복 {integrity.counts.duplicate}
              </FilterChip>
              <FilterChip active={issueKindFilter === 'unpaired'} onClick={() => setIssueKindFilter('unpaired')}>
                페어깨짐 {integrity.counts.unpaired}
              </FilterChip>
            </div>
          </div>
          <div className="max-h-96 overflow-y-auto rounded border border-slate-200">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-slate-50 text-slate-700">
                <tr>
                  <th className="border-b border-slate-200 px-2 py-1.5 text-left">종류</th>
                  <th className="border-b border-slate-200 px-2 py-1.5 text-left">시리즈</th>
                  <th className="border-b border-slate-200 px-2 py-1.5 text-left">상세</th>
                </tr>
              </thead>
              <tbody>
                {filteredIssues.slice(0, 100).map((issue, i) => (
                  <tr key={`${issue.kind}-${i}`} className="hover:bg-slate-50">
                    <td className="border-b border-slate-100 px-2 py-1">
                      <KindBadge kind={issue.kind} />
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 font-mono text-slate-700">
                      {truncate(issue.series, 30)}
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-slate-700">
                      {renderIssueDetail(issue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ─── 자동 추천 액션 ───────────────────────────────────────── */}
      {recs.length > 0 && (
        <section>
          <h3 className="mb-2 font-semibold text-slate-800">자동 추천 액션 ({recs.length})</h3>
          <ul className="space-y-2">
            {recs.map((r, i) => {
              const color =
                r.priority === 'high'
                  ? 'border-rose-300 bg-rose-50'
                  : r.priority === 'medium'
                    ? 'border-amber-300 bg-amber-50'
                    : 'border-slate-300 bg-slate-50';
              const icon = r.priority === 'high' ? '🔴' : r.priority === 'medium' ? '🟡' : '🟢';
              return (
                <li key={i} className={`rounded border p-2.5 text-xs ${color}`}>
                  <div className="font-semibold text-slate-900">
                    {icon} [{r.priority.toUpperCase()}] {r.action}
                  </div>
                  <div className="mt-1 text-slate-700">{r.detail}</div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── 작은 UI 부속 ────────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: number;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div className={`rounded border p-2.5 ${warn ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 text-xl font-bold ${warn ? 'text-amber-900' : 'text-slate-900'}`}>{value.toLocaleString()}</div>
      {hint && <div className="mt-0.5 text-[10px] text-slate-600">{hint}</div>}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 transition ${
        active
          ? 'border-slate-700 bg-slate-700 text-white'
          : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

function FolderCard({
  name,
  stat,
  dbRecordCount,
  expanded,
  onToggle,
}: {
  name: string;
  stat: RootFolderStat;
  dbRecordCount: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const buckets = stat.sizeBuckets || {};
  const labels = ['0-30KB', '30KB-1MB', '1-35MB', '35MB+', 'size-unknown'];
  const max = Math.max(...labels.map((l) => buckets[l] ?? 0), 1);

  return (
    <div className={`rounded-lg border p-3 ${stat.whitelisted ? 'border-emerald-200 bg-emerald-50/30' : 'border-amber-300 bg-amber-50'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-slate-900">{name}</span>
            {stat.whitelisted ? (
              <span className="rounded bg-emerald-200 px-1 text-[9px] font-semibold text-emerald-900">화이트리스트 ✓</span>
            ) : (
              <span className="rounded bg-amber-300 px-1 text-[9px] font-semibold text-amber-900">미매칭 ⚠</span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-600">
            Drive 파일 {stat.totalFiles} · DB record {dbRecordCount}
          </div>
        </div>
        <button onClick={onToggle} className="text-[11px] text-slate-600 hover:text-slate-900">
          {expanded ? '접기' : '자세히 ▾'}
        </button>
      </div>

      {/* 사이즈 분포 미니 막대 */}
      <div className="mt-2 grid grid-cols-5 gap-1">
        {labels.map((l) => {
          const v = buckets[l] ?? 0;
          const h = (v / max) * 28;
          const isLarge = l === '35MB+';
          return (
            <div key={l} className="flex flex-col items-center" title={`${l}: ${v}건`}>
              <div className="flex h-7 items-end">
                <div
                  className={`w-3 rounded-t ${isLarge ? 'bg-amber-500' : 'bg-slate-400'}`}
                  style={{ height: `${Math.max(h, v > 0 ? 2 : 0)}px` }}
                />
              </div>
              <div className="mt-0.5 text-[9px] text-slate-500">{l.replace('size-', '')}</div>
              <div className="text-[10px] font-semibold text-slate-700">{v}</div>
            </div>
          );
        })}
      </div>

      {/* 처리 결과 요약 */}
      <div className="mt-2 grid grid-cols-3 gap-1 text-[10px]">
        <Stat label="OCR skip" value={stat.sizeSkipExpected} warn={stat.sizeSkipExpected > 0} />
        <Stat label="크기미달" value={stat.tooSmallExpected} />
        <Stat label="처리대상" value={Math.max(0, stat.totalFiles - stat.sizeSkipExpected - stat.tooSmallExpected)} />
      </div>

      {expanded && (
        <div className="mt-3 space-y-2 border-t border-slate-200 pt-2">
          {stat.sampleSkips.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-rose-700">사이즈 초과 sample (skip)</div>
              <ul className="mt-0.5 space-y-0.5 text-[10px] text-slate-600">
                {stat.sampleSkips.map((f, i) => (
                  <li key={i} className="font-mono">
                    · {f.name} <span className="text-rose-600">({f.sizeMB}MB)</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {stat.sampleEligible.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-emerald-700">처리 대상 sample</div>
              <ul className="mt-0.5 space-y-0.5 text-[10px] text-slate-600">
                {stat.sampleEligible.map((f, i) => (
                  <li key={i} className="font-mono">
                    · {f.name} <span className="text-emerald-600">({f.sizeMB}MB)</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div
      className={`rounded border px-1.5 py-0.5 text-center ${
        warn ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-slate-200 bg-white text-slate-700'
      }`}
    >
      <div className="text-[9px] text-slate-500">{label}</div>
      <div className="text-xs font-bold">{value}</div>
    </div>
  );
}

function KindBadge({ kind }: { kind: 'missing' | 'duplicate' | 'unpaired' }) {
  const map = {
    missing: { label: '누락', cls: 'bg-rose-100 text-rose-800' },
    duplicate: { label: '중복', cls: 'bg-amber-100 text-amber-900' },
    unpaired: { label: '페어깨짐', cls: 'bg-blue-100 text-blue-800' },
  };
  const m = map[kind];
  return <span className={`rounded px-1 py-0.5 text-[9px] font-semibold ${m.cls}`}>{m.label}</span>;
}

function renderIssueDetail(issue: IntegrityIssue): string {
  if (issue.kind === 'missing') {
    const list = issue.missingNos.slice(0, 8).join(', ');
    const more = issue.missingNos.length > 8 ? ` 외 ${issue.missingNos.length - 8}` : '';
    return `${issue.range[0]}~${issue.range[1]} 중 ${issue.missingNos.length}개 빠짐 (${list}${more})`;
  }
  if (issue.kind === 'duplicate') {
    return `${issue.problemNo}번 중복 — sources: ${issue.sources.length}, digests: ${issue.contentDigests.length}`;
  }
  return `${issue.problemNo}번 ${issue.side === 'missing-solution' ? '풀이 없음' : '문제 없음'} — ${truncate(issue.contentSnippet, 60)}`;
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
