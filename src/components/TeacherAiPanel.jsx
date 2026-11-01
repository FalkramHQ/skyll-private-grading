import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Copy,
  Lightbulb,
  MessageSquare,
  RefreshCw,
  Users,
  Wand2,
} from 'lucide-react';
import {
  askTeacherCopilot,
  getCurriculumCoverage,
  getTeacherBriefing,
  listAiArtifacts,
  requestLessonPlan,
  requestParentReport,
  requestQuizGen,
  requestInterventions,
} from '../lib/db';
import { routeCopilotAction } from '../lib/copilotActions';
import Loader from '../components/Loader';
import { Button } from './ui/Button';
import { StatusBadge } from './ui/StatusBadge';

const LABEL = 'text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground';
const TOOL_BUTTON = 'h-9 gap-1.5 px-3 text-[13px]';
const FIELD = 'rounded-[10px] border border-input bg-card text-ink placeholder:text-muted-foreground hover:border-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export default function TeacherAiPanel({
  className = '',
  subject = '',
  examId = '',
  username = '',
  studentName = '',
}) {
  const navigate = useNavigate();
  const [briefing, setBriefing] = useState(null);
  const [loadingBriefing, setLoadingBriefing] = useState(true);
  const [coverage, setCoverage] = useState(null);
  const [loadingCoverage, setLoadingCoverage] = useState(true);
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [lesson, setLesson] = useState(null);
  const [quiz, setQuiz] = useState(null);
  const [interventions, setInterventions] = useState(null);
  const [parentDraft, setParentDraft] = useState(null);
  const [parentMessage, setParentMessage] = useState('');
  const [parentUsername, setParentUsername] = useState(username || '');
  const [artifacts, setArtifacts] = useState([]);
  const [locked, setLocked] = useState(null);
  const [copied, setCopied] = useState(false);

  const scope = useMemo(() => ({ className, subject, examId }), [className, subject, examId]);

  useEffect(() => {
    setParentUsername(username || '');
  }, [username]);

  // Evidence gate response ({ ok:false, reason:'insufficient_data' }) → lock card.
  const isLocked = (payload) => {
    if (payload?.ok === false && payload.reason === 'insufficient_data') {
      setLocked(payload.evidence || { reason: 'Not enough class evidence yet.' });
      return true;
    }
    return false;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingBriefing(true);
      setLoadingCoverage(true);
      setError('');
      try {
        const [briefingPayload, coveragePayload] = await Promise.all([
          getTeacherBriefing(scope),
          subject
            ? getCurriculumCoverage(scope).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (!cancelled) {
          if (briefingPayload?.ok !== false) {
            setBriefing(briefingPayload.briefing || briefingPayload);
          } else if (briefingPayload.reason === 'insufficient_data') {
            setBriefing(null);
            setLocked(briefingPayload.evidence || { reason: 'Not enough class evidence yet.' });
          }
          setCoverage(coveragePayload?.coverage || null);
          listAiArtifacts({ limit: 8 })
            .then((payload) => { if (!cancelled) setArtifacts(payload.artifacts || []); })
            .catch(() => { if (!cancelled) setArtifacts([]); });
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load teacher AI');
      } finally {
        if (!cancelled) {
          setLoadingBriefing(false);
          setLoadingCoverage(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [scope, subject]);

  const run = async (key, fn) => {
    setBusy(key);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message || 'Request failed');
    } finally {
      setBusy('');
    }
  };

  const fireAction = (action) => {
    const route = routeCopilotAction(action);
    if (route.kind === 'quiz-gen') {
      run('quiz', async () => {
        const payload = await requestQuizGen({ ...scope, topic: route.topic, count: 5 });
        if (isLocked(payload)) return;
        setQuiz(payload.quiz);
      });
    } else if (route.kind === 'lesson-plan') {
      run('lesson', async () => {
        const payload = await requestLessonPlan({ ...scope, topic: route.topic });
        if (isLocked(payload)) return;
        setLesson(payload.plan);
      });
    } else if (route.kind === 'intervention') {
      run('intervention', async () => {
        const payload = await requestInterventions(scope);
        if (isLocked(payload)) return;
        setInterventions(payload.interventions || []);
      });
    } else {
      setQuestion(route.topic);
    }
  };

  const warnings = briefing?.warnings || [];

  return (
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 shrink-0 rounded-full bg-ink px-2 py-0.5 text-[12px] font-bold leading-none text-lime">AI</span>
          <div className="min-w-0">
            <h3 className="font-headline text-[21px] font-extrabold leading-tight text-ink">Teacher AI</h3>
            <p className="mt-0.5 text-[13px] text-foreground-secondary">
              Briefing, early warnings, syllabus coverage - grounded in class evidence
              {className ? ` · Class ${className}` : ''}
              {subject ? ` · ${subject}` : ''}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 text-foreground-secondary hover:text-foreground"
          disabled={Boolean(busy)}
          onClick={() => run('briefing', async () => {
            const [briefingPayload, coveragePayload] = await Promise.all([
              getTeacherBriefing({ ...scope, refresh: true }),
              subject ? getCurriculumCoverage(scope) : Promise.resolve(null),
            ]);
            if (isLocked(briefingPayload)) return;
            setBriefing(briefingPayload.briefing || briefingPayload);
            setCoverage(coveragePayload?.coverage || null);
          })}
          aria-label="Refresh briefing"
        >
          {busy === 'briefing' ? <Loader size="inline" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-[10px] bg-destructive-soft px-3 py-2 text-[13px] text-destructive">{error}</p>
      ) : null}

      <div className="mt-4 rounded-xl bg-paper-soft p-4">
        <p className={LABEL}>Morning briefing</p>
        {loadingBriefing ? (
          <div className="mt-2 flex items-center gap-2 text-[13px] text-foreground-secondary">
            <Loader size="inline" /> Loading…
          </div>
        ) : briefing ? (
          <>
            <p className="mt-2 text-[15px] font-bold text-ink">{briefing.headline}</p>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 marker:text-faint">
              {(briefing.bullets || []).map((bullet) => (
                <li key={bullet} className="text-[13px] leading-relaxed text-foreground-secondary">{bullet}</li>
              ))}
            </ul>
            {briefing.watch_students_hint ? (
              <p className="mt-2 text-[13px] font-medium text-warning">{briefing.watch_students_hint}</p>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-[13px] text-muted-foreground">No briefing yet.</p>
        )}
      </div>

      {warnings.length ? (
        <div className="mt-4 rounded-xl border border-border p-4">
          <StatusBadge status="caution">Early warnings ({warnings.length})</StatusBadge>
          <div className="mt-2">
            {warnings.slice(0, 6).map((warning) => (
              <div key={warning.id} className="border-b border-border py-2.5 last:border-b-0">
                <p className="text-[13px] font-semibold text-ink">
                  {warning.studentName || warning.username}
                  <span className="ml-2 text-[12px] font-bold uppercase tracking-[0.06em] text-warning">
                    {warning.severity}
                  </span>
                  {warning.scorePct != null ? (
                    <span className="ml-2 font-normal tabular-nums text-muted-foreground">{warning.scorePct}%</span>
                  ) : null}
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 marker:text-faint">
                  {(warning.reasons || []).map((reason) => (
                    <li key={`${warning.id}-${reason.code}`} className="text-[12px] text-foreground-secondary">
                      {reason.detail}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-border p-4">
        <p className={LABEL}>Syllabus coverage</p>
        {loadingCoverage ? (
          <div className="mt-2 flex items-center gap-2 text-[13px] text-foreground-secondary">
            <Loader size="inline" /> Loading…
          </div>
        ) : !subject ? (
          <p className="mt-2 text-[13px] text-muted-foreground">Select a subject to see curriculum coverage.</p>
        ) : coverage ? (
          <>
            <p className="mt-2 text-[15px] font-bold tabular-nums text-ink">
              {coverage.pctCovered == null ? 'No standards matched' : `${coverage.pctCovered}% covered`}
              <span className="ml-2 text-[13px] font-normal text-muted-foreground">
                {coverage.totals?.tested || 0}/{coverage.totals?.standards || 0} topics
              </span>
            </p>
            {coverage.note ? <p className="mt-1 text-[13px] text-muted-foreground">{coverage.note}</p> : null}
            {coverage.missing?.length ? (
              <div className="mt-2">
                <p className={LABEL}>Still missing</p>
                <p className="mt-1 text-[13px] leading-relaxed text-foreground-secondary">
                  {coverage.missing.slice(0, 8).map((row) => row.topic).join(' · ')}
                  {coverage.missing.length > 8 ? ` · +${coverage.missing.length - 8} more` : ''}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-[13px] font-medium text-success">All matched syllabus topics have been tested.</p>
            )}
            {(coverage.totals?.pendingLinks || coverage.totals?.unmappedQuestions) ? (
              <p className="mt-2 text-[12px] text-muted-foreground">
                {coverage.totals.pendingLinks ? `${coverage.totals.pendingLinks} proposed link(s) awaiting review. ` : ''}
                {coverage.totals.unmappedQuestions ? `${coverage.totals.unmappedQuestions} question(s) still unmapped.` : ''}
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-2 text-[13px] text-muted-foreground">Coverage unavailable.</p>
        )}
      </div>

      <form
        className="mt-4 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!question.trim()) return;
          const asked = question.trim();
          setQuestion('');
          setChat((prev) => [...prev, { role: 'teacher', content: asked }]);
          run('copilot', async () => {
            const result = await askTeacherCopilot({
              question: asked,
              ...scope,
              history: chat.slice(-6),
            });
            if (isLocked(result)) return;
            setChat((prev) => [...prev, {
              role: 'copilot',
              content: result.reply,
              actions: result.actions || [],
            }]);
          });
        }}
      >
        <label className={LABEL} htmlFor="teacher-copilot">
          Ask copilot
        </label>
        <div className="flex gap-2">
          <input
            id="teacher-copilot"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="e.g. What should I reteach tomorrow?"
            className={`h-10 min-w-0 flex-1 px-3 text-sm ${FIELD}`}
          />
          <Button
            type="submit"
            disabled={Boolean(busy) || !question.trim()}
            className="shrink-0 gap-1.5"
          >
            {busy === 'copilot' ? <Loader size="inline" /> : <MessageSquare className="h-4 w-4" aria-hidden="true" />}
            Ask
          </Button>
        </div>
      </form>

      {chat.length > 0 ? (
        <div className="mt-3 max-h-48 space-y-2 overflow-y-auto">
          {chat.map((turn, index) => (
            <div
              key={`${turn.role}-${index}`}
              className={`rounded-[10px] px-3 py-2 text-[13px] leading-relaxed ${
                turn.role === 'teacher' ? 'bg-sunken text-foreground-secondary' : 'border border-border bg-card text-ink'
              }`}
            >
              <p className="mb-1 text-[12px] font-semibold text-muted-foreground">
                {turn.role === 'teacher' ? 'You' : 'Copilot'}
              </p>
              <p>{turn.content}</p>
              {turn.actions?.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {turn.actions.map((action) => (
                    <button
                      key={action}
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => fireAction(action)}
                      className="rounded-full border border-border bg-card px-2.5 py-1 text-left text-[12px] font-semibold text-ink transition-colors hover:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      {action}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={Boolean(busy)}
          onClick={() => run('lesson', async () => {
            const payload = await requestLessonPlan(scope);
            if (isLocked(payload)) return;
            setLesson(payload.plan);
          })}
          className={TOOL_BUTTON}
        >
          {busy === 'lesson' ? <Loader size="inline" /> : <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />}
          Lesson plan
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={Boolean(busy)}
          onClick={() => run('quiz', async () => {
            const payload = await requestQuizGen({ ...scope, count: 5 });
            if (isLocked(payload)) return;
            setQuiz(payload.quiz);
          })}
          className={TOOL_BUTTON}
        >
          {busy === 'quiz' ? <Loader size="inline" /> : <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />}
          Quiz gen
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={Boolean(busy)}
          onClick={() => run('intervention', async () => {
            const payload = await requestInterventions(scope);
            if (isLocked(payload)) return;
            setInterventions(payload.interventions || []);
          })}
          className={TOOL_BUTTON}
        >
          {busy === 'intervention' ? <Loader size="inline" /> : <Lightbulb className="h-3.5 w-3.5" aria-hidden="true" />}
          Interventions
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={Boolean(busy) || !parentUsername.trim()}
          onClick={() => run('parent', async () => {
            const payload = await requestParentReport({
              ...scope,
              username: parentUsername.trim(),
            });
            if (isLocked(payload)) return;
            setParentDraft(payload.draft);
            setParentMessage(payload.draft?.message || '');
            setCopied(false);
          })}
          className={TOOL_BUTTON}
          title={parentUsername.trim() ? 'Draft parent update' : 'Select a student or enter username'}
        >
          {busy === 'parent' ? <Loader size="inline" /> : <Users className="h-3.5 w-3.5" aria-hidden="true" />}
          Parent update
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => navigate('/exam')}
          className={TOOL_BUTTON}
        >
          Open Exam Builder
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className={LABEL} htmlFor="parent-username">
          Parent update student
        </label>
        <input
          id="parent-username"
          value={parentUsername}
          onChange={(event) => setParentUsername(event.target.value)}
          placeholder={studentName ? `${studentName} username` : 'student username'}
          className={`h-9 min-w-[10rem] flex-1 px-2.5 text-[13px] ${FIELD}`}
        />
        {studentName ? (
          <span className="text-[12px] text-muted-foreground">{studentName}</span>
        ) : null}
      </div>

      {lesson ? (
        <div className="mt-4 rounded-xl border border-border p-4">
          <p className="text-[15px] font-bold text-ink">{lesson.title}</p>
          <p className="mt-1 text-[13px] text-foreground-secondary">{lesson.objective}</p>
          <p className={`mt-3 ${LABEL}`}>Teach</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-[13px] text-foreground-secondary marker:text-faint">
            {(lesson.teach || []).map((item) => <li key={item}>{item}</li>)}
          </ul>
          <p className="mt-3 text-[13px] text-foreground-secondary"><span className="font-semibold text-ink">Exit ticket:</span> {lesson.exit_ticket}</p>
        </div>
      ) : null}

      {quiz?.questions?.length ? (
        <div className="mt-4 rounded-xl border border-border p-4">
          <p className="text-[15px] font-bold text-ink">Quiz draft ({quiz.questions.length})</p>
          <ol className="mt-2 list-decimal space-y-2 pl-4 text-[13px] text-foreground-secondary">
            {quiz.questions.map((item) => (
              <li key={item.id || item.question_text}>
                <span className="font-semibold text-ink">[{item.topic}]</span> {item.question_text}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {interventions?.length ? (
        <div className="mt-4 space-y-2">
          <p className={LABEL}>Suggested interventions</p>
          {interventions.map((item) => (
            <div key={item.title} className="rounded-xl border border-border p-3">
              <p className="text-[13px] font-semibold text-ink">{item.title} · {item.segment}</p>
              <p className="mt-1 text-[13px] text-foreground-secondary">{item.action}</p>
            </div>
          ))}
        </div>
      ) : null}

      {parentDraft ? (
        <div className="mt-4 rounded-xl border border-border p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <StatusBadge status="caution">Parent draft · review before send</StatusBadge>
              <p className="mt-2 text-[15px] font-bold text-ink">{parentDraft.subject_line}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              disabled={!parentMessage.trim()}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(parentMessage);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  setError('Could not copy to clipboard');
                }
              }}
              className="h-9 shrink-0 gap-1.5 px-3 text-[13px]"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <textarea
            value={parentMessage}
            onChange={(event) => setParentMessage(event.target.value)}
            rows={7}
            aria-label="Parent message"
            className={`mt-3 w-full px-3 py-2 text-[13px] leading-relaxed ${FIELD}`}
          />
          {parentDraft.talking_points?.length ? (
            <div className="mt-2">
              <p className={LABEL}>Talking points</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[13px] text-foreground-secondary marker:text-faint">
                {parentDraft.talking_points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="mt-2 text-[12px] text-muted-foreground">
            Edit freely, then copy into WhatsApp/email. Skyll never auto-sends to parents.
          </p>
        </div>
      ) : null}

      {artifacts.length > 0 && (
        <div className="mt-4 rounded-xl border border-border p-4">
          <p className={LABEL}>Recent AI artifacts</p>
          <div className="mt-2 space-y-1.5">
            {artifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                onClick={() => {
                  if (artifact.type === 'lesson_plan') setLesson(artifact.payload);
                  else if (artifact.type === 'quiz') setQuiz(artifact.payload);
                  else if (artifact.type === 'intervention') setInterventions(artifact.payload?.interventions || []);
                  else if (artifact.type === 'parent_report') {
                    setParentDraft(artifact.payload);
                    setParentMessage(artifact.payload?.message || '');
                    if (artifact.payload?.student?.username) {
                      setParentUsername(artifact.payload.student.username);
                    }
                  }
                }}
                className="flex min-h-10 w-full items-center justify-between gap-2 rounded-[10px] border border-border px-3 py-1.5 text-left transition-colors hover:border-hairline-strong hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="truncate text-[13px] font-medium text-foreground">
                  {artifact.type === 'lesson_plan' ? artifact.payload?.title || 'Lesson plan'
                    : artifact.type === 'quiz' ? `Quiz draft (${artifact.payload?.questions?.length || 0})`
                    : artifact.type === 'parent_report'
                      ? (artifact.payload?.subject_line || 'Parent update')
                      : 'Interventions'}
                  {artifact.scope?.subject ? ` · ${artifact.scope.subject}` : ''}
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">
                  {new Date(artifact.createdAt).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {locked ? (
        <div className="mt-4 rounded-xl border border-dashed border-hairline-strong bg-paper-soft p-4">
          <p className="text-[15px] font-bold text-ink">Not enough class evidence yet</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-foreground-secondary">{locked.reason}</p>
          <p className="mt-2 text-[12px] text-muted-foreground">
            AI generation unlocks once graded exams produce at least {locked.needed || 10} evidence signals for this class.
          </p>
        </div>
      ) : null}
    </section>
  );
}
