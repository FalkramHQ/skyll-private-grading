// ReportViewPanel — the shared report view used both from the hub score table
// and from the student profile ProgressCard expansion. It renders the published
// report payload verbatim (the pipeline already redacts sensitive fields), and
// lazy-loads the heavy MathText / AnswerSheetGallery renderers only when the
// payload contains content that needs them, per the frontend code-splitting
// rule. katex ships in its own manual chunk in vite.config.js.

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/Card';
import { Alert, AlertDescription } from '../../ui/Alert';
import { Skeleton } from '../../ui/Skeleton';
import { ReportCard } from './ReportCard';
import { formatReportText } from '../../../lib/textFormat';
import { toStudentFacingText } from '../../../lib/studentFacingText';

// Heavy renderers are lazy-loaded on demand. MathText brings katex + react-markdown;
// AnswerSheetGallery loads page images. Both already have manual Vite chunks.
const MathText = lazy(() => import('../../../components/MathText'));
const AnswerSheetGallery = lazy(() => import('../../../components/AnswerSheetGallery'));

const SUBSECTION_HEIGHT = 24;

function pctOf(score, max) {
  if (score === null || max === null || max === 0) return null;
  return Math.round((score / max) * 100);
}

function gradeFor(pct) {
  if (pct === null) return null;
  if (pct >= 90) return { letter: 'A', bg: 'bg-success-soft', text: 'text-success-soft-foreground' };
  if (pct >= 80) return { letter: 'B', bg: 'bg-success-soft', text: 'text-success-soft-foreground' };
  if (pct >= 70) return { letter: 'C', bg: 'bg-info', text: 'text-info' };
  if (pct >= 50) return { letter: 'D', bg: 'bg-warning-soft', text: 'text-warning-soft-foreground' };
  return { letter: 'E', bg: 'bg-warning-soft', text: 'text-warning-soft-foreground' };
}

function clean(text) {
  return formatReportText(toStudentFacingText(String(text || '')));
}

function QuestionRow({ question, expanded, onToggle, subject }) {
  const got = question.marksObtained ?? 0;
  const total = question.marksTotal ?? 0;
  const outcome =
    total > 0 && got >= total
      ? { label: 'Full marks', bg: 'bg-success-soft', text: 'text-success-soft-foreground', mark: '✓' }
      : got > 0
      ? { label: 'Part marks', bg: 'bg-warning-soft', text: 'text-warning-soft-foreground', mark: '◐' }
      : { label: 'Not attempted', bg: 'bg-sunken', text: 'text-foreground-secondary', mark: '○' };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div
        className="flex items-center gap-2 p-3"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span
          className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold', outcome.bg, outcome.text)}
          aria-hidden="true"
        >
          {outcome.mark}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {subject ? `Question ${question.number}` : question.number}
        </span>
        <span className="tabular-nums text-sm font-semibold text-ink">
          {got}/{total}
        </span>
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
      </div>
      {expanded && (
        <div className="border-t border-border bg-paper-soft px-3 pb-3">
          {question.question && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-semibold text-muted-foreground">Question</p>
              <Suspense fallback={<Skeleton className="h-20 w-full rounded bg-sunken" />}>
                <div className="prose prose-sm max-w-none">
                  <MathText text={clean(question.question)} stripJargon={false} block />
                </div>
              </Suspense>
            </div>
          )}
          {question.student_answer && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-semibold text-muted-foreground">Your answer</p>
              <Suspense fallback={<Skeleton className="h-20 w-full rounded bg-sunken" />}>
                <div className="prose prose-sm max-w-none">
                  <MathText text={clean(question.student_answer)} stripJargon={false} block />
                </div>
              </Suspense>
            </div>
          )}
          {question.correct_answer && question.correct_answer !== '-' && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-semibold text-success-soft-foreground">Correct answer</p>
              <Suspense fallback={<Skeleton className="h-20 w-full rounded bg-sunken" />}>
                <div className="prose prose-sm max-w-none">
                  <MathText text={clean(question.correct_answer)} stripJargon={false} block />
                </div>
              </Suspense>
            </div>
          )}
          {question.reasoning && (
            <div className="mb-3">
              <p className="mb-1 text-xs font-semibold text-muted-foreground">Grading reason</p>
              <Suspense fallback={<Skeleton className="h-20 w-full rounded bg-sunken" />}>
                <div className="prose prose-sm max-w-none">
                  <MathText text={clean(question.reasoning)} stripJargon={false} block />
                </div>
              </Suspense>
            </div>
          )}
          {question.parts && question.parts.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold text-muted-foreground">Sub-parts</p>
              <div className="space-y-2">
                {question.parts.map((part, i) => (
                  <div key={i} className="rounded bg-card border border-border p-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-ink">{part.label || `Part ${i + 1}`}</span>
                      <span className="tabular-nums text-sm font-semibold text-ink">
                        {part.marksObtained}/{part.marksTotal}
                      </span>
                    </div>
                    {(part.prompt || part.response) && (
                      <div className="mt-2 text-sm">
                        {part.prompt && (
                          <>
                            <span className="text-xs text-muted-foreground">Prompt:</span>{' '}
                            <span className="text-ink">{clean(part.prompt)}</span>
                          </>
                        )}
                        {part.response && (
                          <>
                            {'\n'}
                            <span className="text-xs text-muted-foreground">Your answer:</span>{' '}
                            <span className="text-ink">{clean(part.response)}</span>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionCard({ name, score, maxMarks, pct, children }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <CardTitle className="text-base">{name}</CardTitle>
        {score !== null && maxMarks !== null && (
          <>
            <span className="tabular-nums font-semibold text-ink">
              {score}/{maxMarks}
            </span>
            {pct !== null && <span className="text-xs text-muted-foreground">({pct}%)</span>}
          </>
        )}
      </div>
      {children}
    </div>
  );
}

function SubjectSection({ subject, expanded, onToggle }) {
  return (
    <div className="rounded-xl border border-border bg-card">
      <div
        className="flex cursor-pointer items-center justify-between p-4"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="min-w-0">
          <CardTitle className="text-base">{subject.name}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {subject.score !== null && subject.maxMarks !== null
              ? `${subject.score}/${subject.maxMarks}`
              : '—'}
          </p>
        </div>
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
      </div>
      {expanded && (
        <div className="border-t border-border px-4 pb-4">
          {(subject.sections || []).length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">Section breakdown</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {(subject.sections || []).map((sec, i) => (
                  <div key={i} className="rounded-lg border border-border bg-paper-soft p-3">
                    <p className="truncate text-xs font-semibold text-ink">{sec.name}</p>
                    <p className="mt-1 text-sm tabular-nums font-semibold text-ink">
                      {sec.score !== null && sec.maxMarks !== null ? `${sec.score}/${sec.maxMarks}` : '—'}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(subject.strengths || []).length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">Strengths</p>
              <ul className="space-y-2">
                {(subject.strengths || []).map((s, i) => (
                  <li key={i} className="rounded bg-success-soft/30 border border-success/20 p-2 text-sm">
                    <span className="font-semibold text-success-soft-foreground">{s.concept}</span>
                    <p className="mt-1 text-ink">{clean(s.evidence)}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(subject.misconceptions || []).length > 0 && (
            <div className="mb-4">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">Needs attention</p>
              <ul className="space-y-2">
                {(subject.misconceptions || []).map((m, i) => (
                  <li key={i} className="rounded bg-warning-soft/30 border border-warning/20 p-2 text-sm">
                    <span className="font-semibold text-warning-soft-foreground">{m.issue}</span>
                    <div className="mt-1 space-y-1 text-ink">
                      {m.what_student_did && <p><span className="text-xs text-muted-foreground">What happened: </span>{clean(m.what_student_did)}</p>}
                      {m.what_this_means && <p><span className="text-xs text-muted-foreground">What it means: </span>{clean(m.what_this_means)}</p>}
                      {m.impact && <p><span className="text-xs text-muted-foreground">Impact: </span>{clean(m.impact)}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(subject.questions || []).length > 0 && (
            <div>
              <p className="mb-2 text-xs font-semibold text-muted-foreground">Question-by-question</p>
              <div className="space-y-2">
                {(subject.questions || []).map((q, i) => (
                  <QuestionRow
                    key={i}
                    question={q}
                    subject={true}
                    expanded={false}
                    onToggle={() => {}}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ReportViewPanel({ report, onClose }) {
  const [expandedSubjects, setExpandedSubjects] = useState(new Set());
  const [showGallery, setShowGallery] = useState(false);

  const { summary = {}, subjects = [], dna = {}, payload, reviewPending, exam } = report || {};

  const p = pctOf(summary.overallScore, summary.overallMax);
  const g = gradeFor(p);

  const hasAnswerSheets = useMemo(() => {
    if (!payload || !report?.exam?.id) return false;
    return Boolean(payload.answer_sheets) || Boolean(payload.tests?.[0]?.test_id);
  }, [payload, report?.exam?.id]);

  const toggleSubject = useCallback((name) => {
    setExpandedSubjects((s) => {
      const n = new Set(s);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });
  }, []);

  // Close on Escape; keep panel focus trap-free so the shell stays usable.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!report) {
    return (
      <Alert variant="destructive">
        <AlertDescription>No report data available</AlertDescription>
      </Alert>
    );
  }

  const showDraft = summary.status === 'draft';

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-end justify-center sm:items-center',
        'bg-black/50 backdrop-blur-sm transition-opacity',
        'animate-in fade-in duration-200'
      )}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Report for ${summary.studentName || 'student'}`}
    >
      <div
        className={cn(
          'mt-0 h-full w-full bg-paper-2 sm:mt-8 sm:h-auto sm:max-h-[85vh] sm:w-full sm:max-w-5xl sm:rounded-2xl',
          'overflow-y-auto overflow-x-hidden',
          'animate-in slide-in-from-bottom-4 sm:slide-in-from-bottom-8 duration-300'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-border bg-paper-2 px-4 py-3 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate font-headline text-xl font-bold text-ink">
                {exam?.name || summary.examTitle}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {exam?.date && <span>{new Date(exam.date).toLocaleDateString()}</span>}
                {exam?.subject && <span>• {exam.subject}</span>}
                {reviewPending && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning-soft-foreground">
                    Review pending
                  </span>
                )}
                {showDraft && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2 py-0.5 text-xs font-semibold text-foreground-secondary">
                    Draft
                  </span>
                )}
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close report">
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <div className="p-4 sm:p-6">
          {/* Summary strip */}
          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
            {g && (
              <span
                className={cn(
                  'flex h-12 w-12 items-center justify-center rounded-full text-xl font-bold shadow-sm',
                  g.bg,
                  g.text
                )}
                aria-label={`Score ${p}%`}
              >
                {g.letter}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="font-headline text-lg font-bold text-ink">
                {summary.studentName}
              </p>
              <p className="text-sm text-muted-foreground">
                {exam?.name || summary.examTitle} · {exam?.date ? new Date(exam.date).toLocaleDateString() : ''}
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="text-2xl font-bold text-ink tabular-nums">
                {summary.overallScore !== null ? summary.overallScore : '—'}
                <span className="text-base text-muted-foreground">/{summary.overallMax}</span>
              </div>
              {p !== null && <div className="text-xs text-muted-foreground">{p}%</div>}
            </div>
          </div>

          {/* Learner DNA / learning pattern */}
          {dna?.learningStyle && (
            <div className="mb-6">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">Learning pattern</p>
              <Suspense fallback={<Skeleton className="h-20 w-full rounded bg-sunken" />}>
                <div className="prose prose-sm max-w-none rounded-lg border border-border bg-card p-4">
                  <MathText text={clean(dna.learningStyle)} stripJargon={false} block />
                </div>
              </Suspense>
            </div>
          )}

          {dna?.patterns?.length > 0 && (
            <div className="mb-6">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">Patterns noticed</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
                {dna.patterns.map((p, i) => (
                  <li key={i}>{clean(p)}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Caveat (inherited verbatim from the payload; never invented) */}
          {summary.caveat && (
            <Alert variant="info" className="mb-6">
              <AlertDescription className="prose prose-sm max-w-none">
                <MathText text={clean(summary.caveat)} stripJargon={false} block />
              </AlertDescription>
            </Alert>
          )}

          {/* Subject sections */}
          <div className="mb-6 space-y-4">
            <p className="text-sm font-semibold text-ink">Subject performance</p>
            {(subjects || []).map((subject, si) => (
              <SubjectSection
                key={si}
                subject={subject}
                expanded={expandedSubjects.has(subject.name)}
                onToggle={() => toggleSubject(subject.name)}
              />
            ))}
          </div>

          {/* Answer sheets */}
          {hasAnswerSheets && (
            <>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-semibold text-ink">Answer sheets</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowGallery(!showGallery)}
                >
                  {showGallery ? 'Hide' : 'View'}
                </Button>
              </div>
              {showGallery && (
                <Suspense fallback={<Skeleton className="h-64 w-full rounded-lg bg-sunken" />}>
                  <AnswerSheetGallery
                    subjects={subjects}
                    studentUsername={report.student?.reportUsername}
                    testId={report.exam?.id}
                    className="border border-border rounded-lg"
                  />
                </Suspense>
              )}
            </>
          )}

          {hasAnswerSheets && !showGallery && (
            <p className="text-xs text-muted-foreground">
              Answer sheet images are available for this assessment.
            </p>
          )}

          {/* Question-by-question (flat list when subjects carry questions) */}
          {subjects.length === 0 && (
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">Question-by-question</p>
              <p className="text-sm text-muted-foreground">
                Question-level detail is included per subject above.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

ReportViewPanel.Skeleton = function ReportViewPanelSkeleton() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-3xl space-y-4 rounded-2xl bg-paper-2 p-6">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  );
};
