import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Building2, ClipboardCheck, Contact, KeyRound, LogOut, PenSquare, ReceiptText, RefreshCw, RotateCcw, ScanText, Users, Wrench } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import SystemHealthPanel from '../components/SystemHealthPanel.jsx';
import ProductMetricsPanel from '../components/ProductMetricsPanel.jsx';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Alert } from '../components/ui/Alert';
import { track } from '../lib/analytics';
import { clearSession, invalidateSessionCache, useSession } from '../lib/auth';
import Loader from '../components/Loader';

function formatDate(value) {
  if (!value) return 'Not yet updated';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Recently updated' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function Stat({ label, value }) {
  return <div className="flex flex-col gap-0.5 rounded-xl border border-border bg-card p-3.5"><p className="font-headline text-[28px] font-extrabold leading-tight tabular-nums text-ink">{value}</p><p className="text-[13px] text-foreground-secondary">{label}</p></div>;
}

const toneStatus = {
  neutral: 'neutral',
  info: 'info',
  ready: 'positive',
  success: 'positive',
  warning: 'caution',
};

const ACTION_BUTTON = 'h-9 gap-1.5 px-3.5';

function LifecycleAction({ assessment, test, busy, onAction }) {
  const action = assessment?.action;
  if (!action) return null;
  if (action.id === 'open_review') return <Button asChild variant="outline" className={ACTION_BUTTON}><Link to="/review">{action.label}<ArrowRight size={15} /></Link></Button>;
  if (action.id === 'open_rubric_review') return <Button asChild variant="outline" className={ACTION_BUTTON}><Link to={`/review?mode=rubric&testId=${encodeURIComponent(test.id)}`}>{action.label}<ArrowRight size={15} /></Link></Button>;
  if (action.id === 'refresh') return <Button variant="outline" onClick={() => onAction(test, action.id)} className={ACTION_BUTTON}><RefreshCw size={15} aria-hidden="true" />{action.label}</Button>;
  if (action.id === 'start_ocr' || action.id === 'retry_ocr' || action.id === 'retry_rubric') return <Button variant="outline" onClick={() => onAction(test, action.id)} disabled={busy} className={ACTION_BUTTON}>{busy ? <Loader size="inline" /> : action.id === 'start_ocr' ? <ScanText size={15} /> : <RotateCcw size={15} />}{action.label}</Button>;
  if (action.id === 'retry_failed_jobs' || action.id === 'reconcile_status') return <Button variant="outline" onClick={() => onAction(test, action.id)} disabled={busy} className={ACTION_BUTTON}>{busy ? <Loader size="inline" /> : action.id === 'retry_failed_jobs' ? <RotateCcw size={15} /> : <Wrench size={15} />}{action.label}</Button>;
  if (action.id === 'continue_setup' || action.id === 'continue_upload') return <p className="text-sm text-muted-foreground">Use the Intake app to {action.id === 'continue_setup' ? 'complete setup' : 'finish uploads'}.</p>;
  if (action.id === 'escalate') return <p className="text-sm text-muted-foreground">Contact Skyll operations and include the safe error code shown above.</p>;
  return null;
}

function StageSummary({ label, stage }) {
  if (!stage) return null;
  const parts = [];
  if (stage.running) parts.push(`${stage.running} active`);
  if (stage.queued) parts.push(`${stage.queued} queued`);
  if (stage.succeeded) parts.push(`${stage.succeeded} complete`);
  if (stage.failed) parts.push(`${stage.failed} needs attention`);
  return <span><strong className="font-semibold text-foreground">{label}:</strong> {parts.join(' · ') || stage.status}</span>;
}

function ProcessingTimeline({ processing }) {
  const current = processing?.current;
  const stages = processing?.stages;
  if (!current && !Object.values(stages || {}).some(Boolean)) return null;
  return <div className="mt-4 border-t border-border pt-3"><div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Pipeline progress</p>{current && <p className="text-sm font-semibold text-ink">{current.label} · {current.status}</p>}</div>{current?.detail && <p className="mt-2 text-sm text-foreground-secondary">{current.detail}</p>}{current?.attemptCount > 1 && <p className="mt-1 text-[13px] font-semibold text-warning">Retry attempt {current.attemptCount}</p>}<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[13px] tabular-nums text-foreground-secondary"><StageSummary label="OCR" stage={stages?.ocr} /><StageSummary label="Rubric" stage={stages?.rubric} /><StageSummary label="Evidence" stage={stages?.evidence} /><StageSummary label="Visual" stage={stages?.visual} /><StageSummary label="Grading" stage={stages?.grading} /><StageSummary label="Reports" stage={stages?.reports} /></div></div>;
}

const REGRADE_STATUS_LABELS = { queued: 'queued', running: 'running', published: 'published', completed: 'completed', partial: 'partially complete', failed: 'failed' };

function RegradeSummary({ regrade, busy, onRetry }) {
  if (!regrade) return null;
  const items = regrade.items || {};
  const parts = [`${REGRADE_STATUS_LABELS[regrade.status] || regrade.status} ${items.completed || 0}/${regrade.total || 0}`];
  if (items.failed) parts.push(`${items.failed} failed`);
  if (items.processing) parts.push(`${items.processing} in progress`);
  return <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm tabular-nums text-foreground-secondary"><span><strong className="font-semibold text-foreground">Regrade:</strong> {parts.join(' · ')}{regrade.requestedAt ? ` · requested ${formatDate(regrade.requestedAt)}` : ''}</span>{regrade.retryable && <Button variant="outline" size="sm" onClick={onRetry} disabled={busy} className="h-9 gap-1.5 px-3">{busy ? <Loader size="inline" /> : <RotateCcw size={14} />}Retry failed regrade</Button>}{regrade.error && <p className="w-full font-data text-[12px] text-destructive">{regrade.error}</p>}</div>;
}

function AssessmentCard({ test, busy, onAction, onRegradeRetry }) {
  const assessment = test.assessment || { label: 'Status unavailable', explanation: 'Refresh this page to load the current assessment state.', tone: 'neutral' };
  const attention = assessment.attention;
  return <Card className="p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-headline text-lg font-extrabold leading-snug text-ink">{test.title}</h3><p className="mt-0.5 text-[13px] text-foreground-secondary">{test.school} · {test.subject} · {test.grade || 'Unspecified class'}</p></div><StatusBadge status={toneStatus[assessment.tone] || toneStatus.neutral}>{assessment.label}</StatusBadge></div><div className="mt-3 grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]"><div><p className="text-sm leading-relaxed text-foreground">{assessment.explanation}</p>{attention && <div className="mt-3 border-l-2 border-warning pl-3 text-sm text-foreground-secondary"><p>{attention.summary}</p>{attention.code && <p className="mt-1 font-data text-[12px]">Error code: {attention.code}</p>}</div>}<p className="mt-3 text-[12px] tabular-nums text-muted-foreground">Last activity: {formatDate(assessment.updatedAt || test.updatedAt)}</p></div><div className="flex flex-wrap content-start gap-2"><LifecycleAction assessment={assessment} test={test} busy={busy} onAction={onAction} /></div></div><ProcessingTimeline processing={assessment.processing} /><RegradeSummary regrade={test.regrade} busy={busy} onRetry={() => onRegradeRetry(test)} /><div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-3 text-[13px] tabular-nums text-foreground-secondary"><span className="inline-flex items-center gap-1"><Users size={14} aria-hidden="true" />{test.uploadedStudents}/{test.expectedStudents} students uploaded</span><span>{test.answerSheets} answer sheets</span>{assessment.publication?.submissionCount > 0 && <span>{assessment.publication.publishedReportCount}/{assessment.publication.submissionCount} reports published</span>}</div></Card>;
}

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user } = useSession();
  const role = user?.role || localStorage.getItem('userRole');
  const isPlatformAdmin = role === 'skyll_admin';
  const [tests, setTests] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [workers, setWorkers] = useState({ healthy: 0, active: 0, lastSeenAt: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [startingJob, setStartingJob] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/auth/operations', { credentials: 'same-origin' });
      if (response.status === 401 || response.status === 403) { navigate(`/review-login?from=${encodeURIComponent('/admin-dashboard')}`, { replace: true }); return; }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load operations data.');
      setTests(payload.tests || []);
      setNextCursor(payload.nextCursor || null);
      setWorkers(payload.workers || { healthy: 0, active: 0, lastSeenAt: null });
    } catch (requestError) { setError(requestError.message); } finally { setLoading(false); }
  }, [navigate]);

  // The operations endpoint pages 100 assessments at a time; older ones were
  // previously unreachable because nextCursor was ignored.
  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true); setError('');
    try {
      const response = await fetch(`/api/auth/operations?cursor=${encodeURIComponent(nextCursor)}`, { credentials: 'same-origin' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load older assessments.');
      setTests((current) => {
        const seen = new Set(current.map((test) => test.id));
        return [...current, ...(payload.tests || []).filter((test) => !seen.has(test.id))];
      });
      setNextCursor(payload.nextCursor || null);
    } catch (requestError) { setError(requestError.message); } finally { setLoadingMore(false); }
  }

  useEffect(() => { load(); track('operations_viewed', { surface: 'operations' }); }, [load]);
  const totalExpected = tests.reduce((sum, test) => sum + test.expectedStudents, 0);
  const totalUploaded = tests.reduce((sum, test) => sum + test.uploadedStudents, 0);
  const activeJobs = tests.filter((test) => test.assessment?.state === 'processing').length;
  const queuedJobs = tests.filter((test) => test.assessment?.state === 'queued').length;

  async function logout() {
    await fetch('/api/auth/session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    clearSession();
    invalidateSessionCache();
    navigate(isPlatformAdmin ? '/admin' : '/review-login');
  }

  // Recovery actions live on the operations route; pipeline starts and the
  // OCR / rubric retries go through the intake job route.
  const OPERATIONS_ACTIONS = ['retry_failed_jobs', 'reconcile_status'];

  async function runAction(test, action) {
    if (action === 'refresh') { await load(); return; }
    setStartingJob(test.id); setError('');
    try {
      const endpoint = OPERATIONS_ACTIONS.includes(action) ? '/api/auth/operations/jobs' : '/api/intake/jobs';
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ testId: test.id, action }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not start processing.');
      await load();
    } catch (requestError) { setError(requestError.message); } finally { setStartingJob(''); }
  }

  async function retryRegrade(test) {
    if (!test.regrade?.runId) return;
    setStartingJob(test.id); setError('');
    try {
      const response = await fetch('/api/vl-queue', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'retry-cohort-regrade', runId: test.regrade.runId }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Could not retry the regrade.');
      await load();
    } catch (requestError) { setError(requestError.message); } finally { setStartingJob(''); }
  }

  const navLink = 'h-9 gap-1.5 px-3 text-[13px]';
  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border bg-card"><div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-2 px-4 py-2.5 sm:px-8">
      <span className="mr-3 font-headline text-[22px] font-extrabold leading-none tracking-[-0.03em] text-ink" aria-hidden="true">skyll<span className="text-coral">.</span></span>
      <nav aria-label="Workspace" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        <Button asChild variant="ghost" className={navLink}><Link to="/review"><ClipboardCheck size={15} aria-hidden="true" />Review queue</Link></Button>
        <Button asChild variant="ghost" className={navLink}><Link to="/exam"><PenSquare size={15} aria-hidden="true" />Exam Studio</Link></Button>
        <Button asChild variant="ghost" className={navLink}><Link to="/crm"><Contact size={15} aria-hidden="true" />CRM</Link></Button>
        {isPlatformAdmin && <Button asChild variant="ghost" className={navLink}><Link to="/admin/provision"><Building2 size={15} aria-hidden="true" />Provision school</Link></Button>}
        {isPlatformAdmin && <Button asChild variant="ghost" className={navLink}><Link to="/admin/invoices"><ReceiptText size={15} aria-hidden="true" />Invoices</Link></Button>}
        <Button asChild variant="ghost" className={navLink}><Link to="/admin/access"><KeyRound size={15} aria-hidden="true" />Access</Link></Button>
      </nav>
      <Button variant="ghost" onClick={logout} className={`${navLink} text-foreground-secondary hover:text-foreground`}><LogOut size={15} aria-hidden="true" />Log out</Button>
    </div></header>
    <div className="mx-auto max-w-6xl px-4 pb-14 pt-8 sm:px-8 sm:pt-10">
      <div className="flex flex-col gap-1"><h1 className="font-headline text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[44px]">Operations</h1><p className="text-sm text-foreground-secondary">{isPlatformAdmin ? 'Platform-wide assessment lifecycle status across all schools.' : 'Actionable assessment lifecycle status for your school.'}</p></div>
      <div className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6"><Stat label="Assessments" value={tests.length} /><Stat label="Students uploaded" value={`${totalUploaded}/${totalExpected}`} /><Stat label="Processing" value={activeJobs} /><Stat label="Queued" value={queuedJobs} /><Stat label="Workers healthy" value={workers.healthy} /><Stat label="Workers active" value={workers.active} /></div>
      <div className="mt-8"><SystemHealthPanel /></div>
      <ProductMetricsPanel />
      <section className="mt-10"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-headline text-[26px] font-extrabold leading-tight text-ink">Assessments</h2><p className="mt-1 text-sm text-foreground-secondary">Each assessment shows its canonical lifecycle state, live pipeline progress, and next safe action.</p></div><Button variant="secondary" onClick={load} disabled={loading} className="gap-2">{loading ? <Loader size="inline" /> : <RefreshCw size={16} aria-hidden="true" />}Refresh</Button></div>{error && <Alert variant="destructive" className="mt-4">{error}</Alert>}{loading ? <div className="flex justify-center py-14 text-muted-foreground"><Loader size="inline" /></div> : tests.length === 0 ? <Card className="mt-4 border-dashed p-8 text-center text-sm text-muted-foreground">No assessments have been created for this account yet.</Card> : <div className="mt-4 grid gap-3">{tests.map((test) => <AssessmentCard key={test.id} test={test} busy={startingJob === test.id} onAction={runAction} onRegradeRetry={retryRegrade} />)}</div>}{nextCursor && !loading && <div className="mt-6 flex justify-center"><Button variant="secondary" onClick={loadMore} disabled={loadingMore} className="gap-2">{loadingMore ? <Loader size="inline" /> : <ArrowRight size={16} className="rotate-90" aria-hidden="true" />}Load older assessments</Button></div>}</section>
    </div>
  </main>;
}
