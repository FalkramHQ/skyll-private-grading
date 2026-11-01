import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useId, useState, useEffect } from 'react';
import {
  ArrowLeft, ChevronDown, CheckCircle2, Circle, CircleDot,
  AlertTriangle, Lightbulb, BookOpen, Star, Brain,
  ChevronRight, MessageSquarePlus,
} from 'lucide-react';
import MathText from '../components/MathText';
import { formatLongDate } from '../lib/formatDate';
import AnswerSheetGallery from '../components/AnswerSheetGallery';
import { Button } from '../components/ui/Button';
import { RangeBar } from '../components/ui/RangeBar';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Sticker } from '../components/ui/Sticker';
import { getCurrentExamData, loadStudentData } from '../data/studentData';
import { createStudentReportView } from '../lib/reportViewModel';
import { canRequestRecheckForReport, mergeRecheckResponse } from '../lib/recheckUi';
import { recheckStatusLabel } from '../../shared/workflowLifecycle.js';
import { getReportBackUrl, getSubjectReportUrl } from '../lib/reportNavigation';
import { track } from '../lib/analytics';
import { cn } from '../lib/utils';

/* ── Loud notebook surfaces (student volume) ── */
const LOUD_CARD = 'rounded-[20px] border-2 border-ink bg-card';
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const ICON_BUTTON = `inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-ink bg-card text-ink transition-colors hover:bg-paper ${FOCUS_RING}`;
const NAV_BUTTON = `inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border-2 border-ink bg-card px-3 text-sm font-semibold text-ink transition-colors hover:bg-paper sm:px-4 ${FOCUS_RING}`;

/* Question outcome: icon + words, colour only confirms it. */
const OUTCOME = {
  correct: { label: 'Full marks', Icon: CheckCircle2, icon: 'text-success', chip: 'bg-success-soft text-success-soft-foreground' },
  partial: { label: 'Part marks', Icon: CircleDot, icon: 'text-warning', chip: 'bg-card text-foreground' },
  wrong: { label: 'No marks yet', Icon: Circle, icon: 'text-muted-foreground', chip: 'bg-warning-soft text-warning-soft-foreground' },
};

const PRIORITY = {
  critical: { status: 'caution', label: 'Start here' },
  important: { status: 'info', label: 'Important' },
  quick_win: { status: 'positive', label: 'Quick win' },
};

/* ── Class standing: where the student sits, no labels about ability ── */
function ClassRank({ rank }) {
  const { percentile = 0, rank: r = 0, total = 0, top } = rank;
  const tier =
    top === 'top_10' ? { status: 'positive', label: 'Top 10%' } :
    top === 'top_25' ? { status: 'positive', label: 'Top 25%' } :
    top === 'top_half' ? { status: 'neutral', label: 'Top half' } : { status: 'neutral', label: 'Lower half' };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-display text-lg text-foreground">Class standing</h2>
        <StatusBadge status={tier.status} className="text-[13px]">{tier.label}</StatusBadge>
      </div>
      <RangeBar value={percentile} label={`${percentile}th percentile, rank ${r} of ${total}`} />
      <div className="mt-2 flex items-center justify-between text-sm">
        <span className="text-foreground-secondary">
          Rank <span className="font-bold tabular-nums text-foreground">{r}</span> of <span className="tabular-nums">{total}</span>
        </span>
        <span className="font-semibold tabular-nums text-foreground">{percentile}th percentile</span>
      </div>
    </div>
  );
}

export function RecheckControl({ request, onSubmit, disabled, requesterRole }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const fieldId = useId();

  if (request) {
    const status = request.status === 'resolved' ? 'positive' : request.status === 'declined' || request.status === 'cancelled' ? 'neutral' : 'info';
    return (
      <div className="rounded-2xl border-[1.5px] border-ink bg-paper-soft p-3.5">
        <StatusBadge status={status} className="text-[13px]">{recheckStatusLabel(request.status)}</StatusBadge>
        <p className="mt-2 text-[13px] font-medium text-muted-foreground">Raised by {request.requestedByRole === 'student' ? 'student' : 'school admin'}</p>
        <p className="mt-1 text-sm leading-relaxed text-foreground-secondary">{request.reason}</p>
        {request.resolutionNote && <p className="mt-2 text-sm font-semibold leading-relaxed text-foreground">{request.resolutionNote}</p>}
      </div>
    );
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)} className="h-11 gap-1.5 rounded-xl border-2 px-3.5 text-sm">
        <MessageSquarePlus className="h-4 w-4" aria-hidden="true" /> Request a recheck
      </Button>
    );
  }

  async function submit() {
    const clean = reason.trim();
    if (clean.length < 12) { setError('Briefly explain what you would like checked (at least 12 characters).'); return; }
    setError('');
    const result = await onSubmit(clean);
    if (result?.error) { setError(result.error); return; }
    setReason(''); setOpen(false);
  }

  return (
    <div className="rounded-2xl border-[1.5px] border-ink bg-paper-soft p-3.5">
      <label htmlFor={fieldId} className="block text-sm font-bold text-foreground">Why should this be checked again?</label>
      <textarea id={fieldId} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={800} rows={3} placeholder={requesterRole === 'student' ? 'For example: I think the final answer on page 3 was missed after my correction.' : 'For example: The working shown on page 3 supports full credit for this step.'} className="mt-2 w-full resize-y rounded-[10px] border-[1.5px] border-ink bg-card px-3 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
      {error && <p className="mt-1 text-[13px] font-medium text-destructive">{error}</p>}
      <div className="mt-2 flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => { setOpen(false); setError(''); }} className="h-11 px-3 text-sm">Cancel</Button>
        <Button type="button" disabled={disabled} onClick={submit} className="h-11 px-4 text-sm">{disabled ? 'Sending...' : 'Send recheck request'}</Button>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────
   Main page
────────────────────────────────────────────── */
export default function SubjectDetail() {
  const { subjectId } = useParams();
  const navigate       = useNavigate();
  const [searchParams] = useSearchParams();
  const [expanded, setExpanded] = useState({});
  const [filterStatus, setFilterStatus] = useState('all');
  const [reloadVersion, setReloadVersion] = useState(0);
  const [isHydrating, setIsHydrating] = useState(() => !getCurrentExamData(searchParams.get('exam') || 'term1'));
  const [loadError, setLoadError] = useState('');
  const [rechecks, setRechecks] = useState([]);
  const [recheckLoading, setRecheckLoading] = useState(false);

  const examId  = searchParams.get('exam') || 'term1';
  const data    = createStudentReportView(getCurrentExamData(examId));
  const subject = data?.subjects?.find(s => s.id === subjectId);
  const subjectIndex = data?.subjects?.findIndex(s => s.id === subjectId) ?? -1;
  const reportStudentUsername = searchParams.get('student') || data?.username || '';
  const viewerRole = localStorage.getItem('userRole');
  const canRequestRecheck = canRequestRecheckForReport({
    viewerRole,
    viewerUsername: localStorage.getItem('username'),
    viewerSchool: localStorage.getItem('userSchool'),
    reportUsername: reportStudentUsername,
    reportSchool: data?.school || data?.student?.school,
  });

  useEffect(() => {
    if (!subject) return undefined;
    track('subject_viewed', {
      subjectId,
      examId,
      surface: 'web_subject',
    });
    return undefined;
  }, [subjectId, examId]);

  useEffect(() => {
    if (getCurrentExamData(examId)) {
      setIsHydrating(false);
      return undefined;
    }
    const username = reportStudentUsername || localStorage.getItem('username');
    if (!username) {
      setIsHydrating(false);
      return undefined;
    }
    let active = true;
    loadStudentData(username)
      .then(() => { if (active) { setLoadError(''); setReloadVersion((value) => value + 1); setIsHydrating(false); } })
      .catch((error) => { if (active) { setLoadError(error.message || 'Could not load this report.'); setIsHydrating(false); } });
    return () => { active = false; };
  }, [examId, reloadVersion, reportStudentUsername]);

  useEffect(() => {
    if (!canRequestRecheck || !subject?.name) { setRechecks([]); return undefined; }
    let active = true;
    fetch(`/api/rechecks?subject=${encodeURIComponent(subject.name)}&status=all`, { credentials: 'same-origin' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Could not load recheck requests');
        return body.requests || [];
      })
      .then((requests) => { if (active) setRechecks(requests); })
      .catch(() => { if (active) setRechecks([]); });
    return () => { active = false; };
  }, [canRequestRecheck, subject?.name]);

  if (isHydrating) {
    return <div className="notebook-grid flex min-h-screen items-center justify-center"><p className="rounded-full border-2 border-ink bg-card px-4 py-2 text-sm font-semibold text-foreground">Loading report...</p></div>;
  }

  if (!data || !subject) {
    return (
      <div className="notebook-grid flex min-h-screen items-center justify-center px-4">
        <div className={`${LOUD_CARD} max-w-sm space-y-4 px-6 py-8 text-center shadow-hard-lg`}>
          <p className="text-base font-semibold text-foreground">
            {!data ? (loadError || 'Could not load this report') : 'Subject not found'}
          </p>
          <Button variant="outline" onClick={() => navigate(getReportBackUrl(searchParams))} className="h-11 border-2 px-5">
            Back
          </Button>
        </div>
      </div>
    );
  }

  const toggle    = (q) => setExpanded(p => ({ ...p, [q]: !p[q] }));
  const allQuestions = subject.questions || [];
  const subjectPct = subject.pct || 0;
  const recheckByQuestion = new Map(rechecks.map((request) => [String(request.questionNumber || request.question_number), request]));

  const submitRecheck = async (question, reason) => {
    const submissionId = data?.submission_id;
    if (!submissionId) return { error: 'This assessment is not ready for rechecks yet.' };
    setRecheckLoading(true);
    try {
      const response = await fetch('/api/rechecks', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId, subject: subject.name, questionNumber: question.number, reason }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && body.request) setRechecks((current) => mergeRecheckResponse(current, body.request));
        return { error: body.error || 'Could not send recheck request' };
      }
      setRechecks((current) => mergeRecheckResponse(current, body.request));
      return { ok: true };
    } catch (error) {
      return { error: error.message || 'Could not send recheck request' };
    } finally { setRecheckLoading(false); }
  };

  const getQuestionStatus = (q) => {
    const mTotal = Number(q.marks_total) || 0;
    // Keep signed marks (negative marking). `|| 0` would incorrectly turn -1 into issues elsewhere.
    const mGot = Number(q.marks_obtained);
    const got = Number.isFinite(mGot) ? mGot : 0;
    if (mTotal > 0 && got >= mTotal) return 'correct';
    // Zero and negative marks are both unsuccessful attempts (incl. MCQ −1).
    if (got <= 0) return 'wrong';
    return 'partial';
  };

  const filteredQuestions = allQuestions.filter((q) => {
    if (filterStatus === 'all') return true;
    return getQuestionStatus(q) === filterStatus;
  });

  const allExpanded = filteredQuestions.length > 0 && filteredQuestions.every((q) => expanded[q.number]);
  const toggleAll = () => {
    if (allExpanded) {
      setExpanded({});
    } else {
      const next = {};
      filteredQuestions.forEach((q) => { next[q.number] = true; });
      setExpanded(next);
    }
  };

  const prevSubject = subjectIndex > 0 ? data.subjects[subjectIndex - 1] : null;
  const nextSubject = subjectIndex >= 0 && subjectIndex < data.subjects.length - 1 ? data.subjects[subjectIndex + 1] : null;

  const counts = allQuestions.reduce((acc, q) => { acc[getQuestionStatus(q)] += 1; return acc; }, { correct: 0, partial: 0, wrong: 0 });
  const examName = data?.examInfo?.name || subject.name;

  // Earned stickers only: the data has to say so.
  const earnedSticker = Number(subject.total) > 0 && Number(subject.score) >= Number(subject.total)
    ? 'Full marks'
    : subject.classRank?.top === 'top_10' ? 'Top 10% of class' : null;

  // Topic view, built from this paper's own marks. Lowest first: what to practise leads.
  const topics = [...allQuestions.reduce((map, q) => {
    const name = String(q.topic || '').trim();
    const total = Number(q.marks_total);
    if (!name || !(total > 0)) return map;
    const got = Math.max(0, Number(q.marks_obtained) || 0);
    const row = map.get(name) || { name, got: 0, total: 0 };
    row.got += got; row.total += total;
    map.set(name, row);
    return map;
  }, new Map()).values()]
    .map((row) => ({ ...row, pct: Math.round((Math.min(row.got, row.total) / row.total) * 100) }))
    .sort((a, b) => a.pct - b.pct);

  return (
    <div className="notebook-grid min-h-screen text-foreground">

      {/* ── Sticky header ── */}
      <header className="sticky top-0 z-50 border-b-2 border-ink bg-paper">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <button
            type="button"
            onClick={() => navigate(getReportBackUrl(searchParams))}
            aria-label="Back to all subjects"
            className={ICON_BUTTON}
          >
            <ArrowLeft className="h-5 w-5" strokeWidth={2.4} />
          </button>
          <div className="min-w-0 flex-1">
            {data?.name && (
              <button
                type="button"
                onClick={() => navigate(getReportBackUrl(searchParams))}
                className={`hidden max-w-full items-center gap-1 truncate rounded text-[13px] font-medium text-muted-foreground hover:text-foreground hover:underline sm:inline-flex ${FOCUS_RING}`}
              >
                {data.name}{data?.class ? ` · ${data.class}` : ''}
                <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              </button>
            )}
            <h1 className="truncate font-display text-[19px] font-extrabold leading-tight text-foreground">
              {examName}
            </h1>
            {data?.examInfo?.name && data.examInfo.name !== subject.name && (
              <p className="truncate text-[13px] font-medium text-foreground-secondary">{subject.name}</p>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-6 px-4 pb-20 pt-7 sm:px-6 sm:pt-9">

        {/* ── Score: the tilted sticker card ── */}
        <section aria-label="Your score" className="px-1 pt-2">
          <div className={`${LOUD_CARD} relative -rotate-2 p-5 shadow-hard-lg sm:p-6`}>
            <span aria-hidden="true" className="absolute -top-3 left-1/2 h-6 w-24 -translate-x-1/2 rotate-3 border-[1.5px] border-ink bg-lime" />
            {earnedSticker && (
              <Sticker tone="lime" tilt={6} className="absolute -right-2 -top-4 px-3 py-2 font-display text-[15px] font-extrabold">{earnedSticker}</Sticker>
            )}
            <p className={cn('text-[15px] font-semibold text-foreground', earnedSticker && 'pr-24')}>
              {[formatLongDate(data?.examInfo?.date), subject.name].filter(Boolean).join(' · ')}
            </p>
            <p className="mt-1 font-display font-extrabold leading-[0.9] tracking-[-0.05em] tabular-nums text-foreground">
              <span className="text-[84px] sm:text-[96px]">{subject.score}</span>
              <span className="text-[30px] text-foreground-secondary sm:text-[34px]">/{subject.total}</span>
            </p>
            <p className="mt-2 text-base font-semibold text-foreground-secondary">{subjectPct}% of marks</p>

            {allQuestions.length > 0 && (
              <ul aria-label="Questions at a glance" className="mt-4 flex flex-wrap gap-2">
                {[
                  { key: 'correct', n: counts.correct, label: 'full marks', className: 'bg-success-soft text-success-soft-foreground' },
                  { key: 'partial', n: counts.partial, label: 'part marks', className: 'bg-warning-soft text-warning-soft-foreground' },
                  { key: 'wrong', n: counts.wrong, label: 'no marks yet', className: 'bg-sunken text-foreground-secondary' },
                ].filter((item) => item.n > 0).map(({ key, n, label, className }) => {
                  const { Icon } = OUTCOME[key];
                  return (
                    <li key={key} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold ${className}`}>
                      <Icon className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden="true" />
                      <span className="tabular-nums">{n}</span> {label}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* ── Next best move ── */}
        {subject.nextAction && (
          <section aria-label="Your next step" className={`${LOUD_CARD} flex flex-col gap-3 p-5`}>
            <Sticker tone="coral" tilt={-2} className="self-start">Your next step</Sticker>
            <div className="font-display text-[24px] font-extrabold leading-tight tracking-[-0.02em] text-foreground"><MathText text={subject.nextAction.topic} /></div>
            <div className="text-base leading-relaxed text-foreground-secondary"><MathText text={subject.nextAction.action} block /></div>
          </section>
        )}

        {/* ── By topic ── */}
        {topics.length > 1 && (
          <section className={`${LOUD_CARD} p-5`}>
            <h2 className="font-display text-[21px] text-foreground">By topic</h2>
            <p className="mt-1 text-sm text-foreground-secondary">From this paper. The one to practise comes first.</p>
            <ul className="mt-4 space-y-5">
              {topics.map((topic) => {
                const tone = topic.pct >= 75 ? { status: 'positive', label: 'Secure' } : topic.pct >= 40 ? { status: 'info', label: 'Getting there' } : { status: 'caution', label: 'Practise this' };
                return (
                  <li key={topic.name}>
                    <div className="mb-2 flex items-baseline justify-between gap-3">
                      <span className="min-w-0 text-base font-semibold text-foreground"><MathText text={topic.name} /></span>
                      <span className="shrink-0 font-display text-lg font-extrabold tabular-nums text-foreground">{topic.pct}%</span>
                    </div>
                    <RangeBar value={topic.pct} label={`${topic.name}: ${topic.got} of ${topic.total} marks`} />
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <span className="text-sm tabular-nums text-foreground-secondary">{topic.got} of {topic.total} marks</span>
                      <StatusBadge status={tone.status}>{tone.label}</StatusBadge>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* ── Class rank ── */}
        {subject.classRank && (
          <section className={`${LOUD_CARD} p-5`}>
            <ClassRank rank={subject.classRank} subjectPct={subjectPct} />
          </section>
        )}

        {['student', 'teacher', 'admin', 'skyll_admin'].includes(localStorage.getItem('userRole')) && (
          <AnswerSheetGallery subjects={[subject]} studentUsername={reportStudentUsername} testId={data?.workflow?.test_id || data?.examInfo?.id} />
        )}

        {/* ── Question by question ── */}
        {allQuestions.length > 0 && (
          <section className={`${LOUD_CARD} overflow-hidden`}>
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-5">
              <h2 className="font-display text-[21px] text-foreground">
                Question-by-question
              </h2>
              <div className="flex items-center gap-2">
                {/* Filter pills */}
                <div role="group" aria-label="Filter questions" className="flex items-center gap-0.5 rounded-xl border-[1.5px] border-ink bg-card p-0.5">
                  {[
                    { key: 'all', label: 'All', title: 'All questions' },
                    { key: 'correct', label: '✓', title: 'Full marks' },
                    { key: 'partial', label: '◑', title: 'Part marks' },
                    { key: 'wrong', label: '✗', title: 'No marks yet' },
                  ].map(({ key, label, title }) => (
                    <button
                      key={key}
                      type="button"
                      title={title}
                      aria-pressed={filterStatus === key}
                      onClick={() => setFilterStatus(key)}
                      className={`h-11 min-w-11 rounded-[10px] px-2.5 text-sm transition-colors ${FOCUS_RING} ${filterStatus === key ? 'bg-ink text-lime' : 'text-foreground-secondary hover:bg-sunken'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {/* Expand/Collapse all */}
                <button
                  type="button"
                  onClick={toggleAll}
                  className={`h-11 rounded-[10px] px-2 text-sm text-foreground underline-offset-4 hover:underline ${FOCUS_RING}`}
                >
                  {allExpanded ? 'Collapse all' : 'Expand all'}
                </button>
              </div>
            </div>
            <div>
              {filteredQuestions.length === 0 && (
                <p className="border-t-[1.5px] border-ink px-5 py-8 text-center text-sm text-foreground-secondary">No questions match this filter.</p>
              )}
              {filteredQuestions.map((q, index) => {
                const open  = expanded[q.number];
                const outcome = OUTCOME[getQuestionStatus(q)];
                const ok    = q.status === 'correct';
                const OutcomeIcon = outcome.Icon;

                return (
                  <div
                    id={`q-${q.number}`}
                    key={q.number}
                    className={`${index === 0 ? 'border-t-[1.5px] border-ink' : 'border-t border-border'} ${open ? 'bg-paper-soft' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(q.number)}
                      aria-expanded={Boolean(open)}
                      className={`flex min-h-14 w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
                    >
                      <OutcomeIcon className={`h-[18px] w-[18px] shrink-0 ${outcome.icon}`} strokeWidth={2.4} aria-hidden="true" />
                      <span className="sr-only">{outcome.label}.</span>
                      <span className="w-9 shrink-0 text-sm font-bold text-foreground">
                        {q.number}
                      </span>
                      {/* Full question text must remain readable; mathematical notation is rendered. */}
                      <div className="min-w-0 flex-1 text-[15px] leading-snug text-foreground">
                        {open ? <MathText text={q.summary} stripJargon={false} /> : <span>{q.summary}</span>}
                      </div>
                      <span className={`shrink-0 rounded-full border-2 border-ink px-2.5 py-0.5 text-sm font-bold tabular-nums ${outcome.chip}`}>
                        {q.marks_obtained}/{q.marks_total}
                      </span>
                      <ChevronDown className={`h-4 w-4 shrink-0 text-foreground-secondary transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </button>

                    {open && (
                      <div className="space-y-3 px-5 pb-5 pt-1">
                        {/* Question Text */}
                        {(q.question || q.question_text) && (
                          <DetailBlock label="Question">
                            <div className="space-y-2 text-sm leading-relaxed text-foreground">
                              <MathText text={q.question || q.question_text} stripJargon={false} block />
                              {q.mcq_option_map && Object.keys(q.mcq_option_map).length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1.5">
                                  {Object.entries(q.mcq_option_map).map(([letter, text]) => (
                                    <span key={letter} className="rounded-lg border border-border bg-paper px-2 py-0.5 text-[13px] text-foreground-secondary">
                                      <span className="font-semibold text-foreground">({letter})</span> {text}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </DetailBlock>
                        )}

                        {/* Answer Key Evidence */}
                        {q.answer_key_evidence && !(q.question || q.question_text) && (
                          <DetailBlock label="Answer Key">
                            <div className="text-sm leading-relaxed text-foreground">
                              <MathText text={q.answer_key_evidence} stripJargon={false} block />
                            </div>
                          </DetailBlock>
                        )}
                        <DetailBlock label="Your answer" className={q.student_answer && ok ? 'border-success/40 bg-success-soft' : ''}>
                          {q.student_answer ? (
                            <div className="text-sm leading-relaxed text-foreground">
                              <MathText text={q.student_answer} stripJargon={false} block />
                            </div>
                          ) : (
                            <p className="text-sm italic text-foreground-secondary">Not attempted</p>
                          )}
                        </DetailBlock>
                        {!ok && q.correct_answer && q.correct_answer !== '-' && (
                          <DetailBlock label="Correct answer" labelClassName="text-success" className="border-success/40 bg-success-soft">
                            <div className="text-sm leading-relaxed text-foreground">
                              <MathText text={q.correct_answer} block />
                            </div>
                          </DetailBlock>
                        )}
                        {q.grading_reason && (
                          <DetailBlock label="Grading reason">
                            <div className="text-sm leading-relaxed text-foreground-secondary"><MathText text={q.grading_reason} block /></div>
                          </DetailBlock>
                        )}
                        {canRequestRecheck && (
                          <RecheckControl
                            request={recheckByQuestion.get(String(q.number))}
                            disabled={recheckLoading}
                            requesterRole={viewerRole}
                            onSubmit={(reason) => submitRecheck(q, reason)}
                          />
                        )}
                        {q.gap && (
                          <div className="flex items-start gap-2.5 rounded-xl bg-warning-soft p-3">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                            <div className="text-sm font-medium leading-relaxed text-warning-soft-foreground">
                              <MathText text={`Gap: ${q.gap}`} block />
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Core Strength ── */}
        {subject.learning_profile?.core_strength && (
          <section className={`${LOUD_CARD} p-5`}>
            <SectionTitle icon={<Star className="h-5 w-5 text-success" strokeWidth={2.4} aria-hidden="true" />}>
              Core strength
            </SectionTitle>
            <div className="text-base leading-relaxed text-foreground">
              <MathText text={subject.learning_profile.core_strength} block />
            </div>
          </section>
        )}

        {/* ── Pattern we noticed ── */}
        {(subject.root_cause || subject.learning_profile?.pattern_recognition) && (
          <section className={`${LOUD_CARD} p-5`}>
            <SectionTitle icon={<Brain className="h-5 w-5 text-ink" strokeWidth={2.2} aria-hidden="true" />}>
              Pattern we noticed
            </SectionTitle>
            <div className="text-base leading-relaxed text-foreground-secondary">
              <MathText text={subject.learning_profile?.pattern_recognition || subject.root_cause} block />
            </div>
          </section>
        )}

        {/* ── Needs attention ── */}
        {(subject.misconceptions || []).length > 0 && (
          <section className={`${LOUD_CARD} p-5`}>
            <SectionTitle icon={<AlertTriangle className="h-5 w-5 text-warning" strokeWidth={2.2} aria-hidden="true" />}>
              Needs attention
            </SectionTitle>
            <div className="space-y-4">
              {(subject.misconceptions || []).map((m, i) => (
                <div key={i} className={`space-y-3 ${i > 0 ? 'border-t border-border pt-4' : ''}`}>
                  <div className="text-base font-semibold text-foreground"><MathText text={m.issue} /></div>
                  <MiniBlock label="What you did" text={m.what_student_did} />
                  <MiniBlock label="What this means" text={m.what_this_means} />
                  {m.impact && (
                    <MiniBlock label="Why it matters" text={m.impact} className="bg-warning-soft" />
                  )}
                  {(m.questions || []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {(m.questions || []).map(q => (
                        <span
                          key={q}
                          className="rounded-full border-[1.5px] border-ink bg-card px-2.5 py-0.5 text-[13px] font-semibold text-foreground"
                        >
                          {q}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── What to do next ── */}
        {((subject.recommendations || []).length > 0 || (subject.learning_profile?.strategies || []).length > 0) && (
          <section className={`${LOUD_CARD} p-5`}>
            <SectionTitle icon={<Lightbulb className="h-5 w-5 text-ink" strokeWidth={2.2} aria-hidden="true" />}>
              What to do next
            </SectionTitle>
            <div className="space-y-3">
              {(subject.learning_profile?.strategies || []).length > 0
                ? (subject.learning_profile.strategies).map((strat, i) => (
                    <div key={`strat-${i}`} className="rounded-2xl border border-border bg-paper-soft p-4">
                      <div className="mb-1 text-base font-semibold text-foreground"><MathText text={strat.topic || strat.title} /></div>
                      {strat.challenge && <div className="mb-2 text-sm leading-relaxed text-foreground-secondary"><MathText text={strat.challenge} block /></div>}
                      {(strat.strategy || strat.action) && <div className="text-sm leading-relaxed text-foreground-secondary"><MathText text={strat.strategy || strat.action} block /></div>}
                    </div>
                  ))
                : (subject.recommendations || []).map((rec, i) => {
                    const priority = PRIORITY[rec.priority] || PRIORITY.important;
                    return (
                      <div key={i} className="rounded-2xl border border-border bg-paper-soft p-4">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <span className="text-base font-semibold text-foreground"><MathText text={rec.topic} /></span>
                          <StatusBadge status={priority.status}>{priority.label}</StatusBadge>
                        </div>
                        <div className="text-sm leading-relaxed text-foreground-secondary">
                          <MathText text={rec.action} block />
                        </div>
                        {rec.tip && (
                          <div className="mt-3 rounded-xl bg-info-soft p-3">
                            <p className="mb-1 flex items-center gap-1.5 text-[13px] font-bold text-info">
                              <Lightbulb className="h-4 w-4 shrink-0" aria-hidden="true" /> Tip
                            </p>
                            <div className="text-sm leading-relaxed text-foreground">
                              <MathText text={rec.tip} block />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
              }
            </div>
          </section>
        )}

        {/* ── Back + Next/Prev Subject ── */}
        <nav aria-label="Subjects" className="flex items-center justify-between gap-2 pt-2 sm:gap-3">
          {prevSubject ? (
            <button
              type="button"
              onClick={() => navigate(getSubjectReportUrl(prevSubject.id, searchParams))}
              aria-label={`Previous subject: ${prevSubject.name}`}
              className={NAV_BUTTON}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">{prevSubject.name}</span>
            </button>
          ) : <div />}
          <button
            type="button"
            onClick={() => navigate(getReportBackUrl(searchParams))}
            className={NAV_BUTTON}
          >
            <BookOpen className="h-4 w-4" aria-hidden="true" /> All Subjects
          </button>
          {nextSubject ? (
            <button
              type="button"
              onClick={() => navigate(getSubjectReportUrl(nextSubject.id, searchParams))}
              aria-label={`Next subject: ${nextSubject.name}`}
              className={NAV_BUTTON}
            >
              <span className="hidden sm:inline">{nextSubject.name}</span> <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : <div />}
        </nav>

      </main>
    </div>
  );
}

/* ── Shared primitives ── */
function SectionTitle({ icon, children }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      {icon}
      <h2 className="font-display text-[21px] text-foreground">
        {children}
      </h2>
    </div>
  );
}

function DetailBlock({ label, labelClassName = 'text-foreground-secondary', className = '', children }) {
  return (
    <div>
      <p className={cn('mb-1.5 text-[13px] font-bold', labelClassName)}>
        {label}
      </p>
      <div className={cn('rounded-xl border border-border bg-card p-3', className)}>{children}</div>
    </div>
  );
}

function MiniBlock({ label, text, className = 'bg-paper-soft' }) {
  return (
    <div className={cn('rounded-xl p-3', className)}>
      <p className="mb-1 text-[13px] font-bold text-foreground-secondary">
        {label}
      </p>
      <div className="text-sm leading-relaxed text-foreground">
        <MathText text={text} block />
      </div>
    </div>
  );
}
