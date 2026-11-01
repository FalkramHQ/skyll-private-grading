import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpenCheck } from 'lucide-react';
import { Button } from '../components/ui/Button';
import TutorChat from '../components/TutorChat';
import RevisionPlan from '../components/RevisionPlan';
import ReadinessScore from '../components/ReadinessScore';
import { askTutor, createRevisionPlan, getReadinessScore, getTutorHistory, listRevisionPlans, listTutorSessions } from '../lib/db';
import { SUBJECTS } from '../lib/subjects';
import { track } from '../lib/analytics';

const ICON_BUTTON = 'inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border-2 border-ink bg-card px-2.5 text-sm font-semibold text-ink transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export default function StudentTutor() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const student = searchParams.get('student') || searchParams.get('username') || '';
  const sessionId = searchParams.get('session') || '';

  const [readiness, setReadiness] = useState(null);
  const [readinessLoading, setReadinessLoading] = useState(true);
  const [readinessError, setReadinessError] = useState('');
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState('');
  const [planLocked, setPlanLocked] = useState(null);
  const [subject, setSubject] = useState('Mathematics');
  const [sessions, setSessions] = useState(null);
  const [pastPlans, setPastPlans] = useState(null);

  useEffect(() => {
    track('tutor_opened', { surface: 'web', student: student || null });
  }, [student]);

  useEffect(() => {
    let cancelled = false;
    listTutorSessions({ limit: 8 })
      .then((payload) => { if (!cancelled) setSessions(payload.sessions || []); })
      .catch(() => { if (!cancelled) setSessions([]); });
    listRevisionPlans({ username: student || undefined, limit: 5 })
      .then((payload) => { if (!cancelled) setPastPlans(payload.plans || []); })
      .catch(() => { if (!cancelled) setPastPlans([]); });
    return () => { cancelled = true; };
  }, [student]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setReadinessLoading(true);
      setReadinessError('');
      try {
        const payload = await getReadinessScore({ username: student || undefined, subject });
        if (!cancelled) setReadiness(payload);
      } catch (err) {
        if (!cancelled) setReadinessError(err.message || 'Could not load readiness');
      } finally {
        if (!cancelled) setReadinessLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [student, subject]);

  async function generatePlan() {
    setPlanLoading(true);
    setPlanError('');
    setPlanLocked(null);
    try {
      const payload = await createRevisionPlan({
        username: student || undefined,
        subject,
      });
      if (payload?.ok === false && payload.reason === 'insufficient_data') {
        setPlanLocked(payload.evidence || { reason: 'Not enough learning evidence yet.' });
        return;
      }
      setPlan(payload.plan);
      listRevisionPlans({ username: student || undefined, limit: 5 })
        .then((refreshed) => setPastPlans(refreshed.plans || []))
        .catch(() => {});
    } catch (err) {
      setPlanError(err.message || 'Could not create revision plan');
    } finally {
      setPlanLoading(false);
    }
  }

  const practiceParams = new URLSearchParams();
  if (student) practiceParams.set('student', student);
  const firstPriorityTopic = plan?.priority_1?.topic;
  if (firstPriorityTopic) practiceParams.set('topic', firstPriorityTopic);

  return (
    <div className="notebook-grid min-h-screen text-foreground">
      <header className="sticky top-0 z-50 border-b-2 border-ink bg-paper">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              className={ICON_BUTTON}
            >
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              <span className="hidden sm:inline">Dashboard</span>
              <span className="sr-only sm:hidden">Back to dashboard</span>
            </button>
            <div className="min-w-0">
              <h1 className="truncate font-display text-[19px] font-extrabold leading-tight text-foreground">Tutor</h1>
              <p className="truncate text-[13px] text-foreground-secondary">Evidence-bound help from your reports and Hive</p>
            </div>
          </div>
          <Button
            type="button"
            onClick={() => navigate(`/practice${practiceParams.toString() ? `?${practiceParams}` : ''}`)}
            className="h-11 shrink-0 gap-1.5 px-4 text-sm"
          >
            <BookOpenCheck className="h-4 w-4" aria-hidden="true" />
            Practice
          </Button>
        </div>
      </header>
      <main className="mx-auto grid max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[1.2fr_0.8fr]">
        <TutorChat
          key={sessionId || 'new'}
          username={student || null}
          initialSessionId={sessionId || null}
          askTutor={askTutor}
          loadHistory={getTutorHistory}
        />
        <div className="space-y-6">
          <div className="rounded-[20px] border-2 border-ink bg-card p-4">
            <label htmlFor="tutor-subject" className="text-[13px] font-bold text-foreground-secondary">
              Subject focus
            </label>
            <select
              id="tutor-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              className="mt-1.5 h-11 w-full rounded-[10px] border-[1.5px] border-ink bg-card px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {SUBJECTS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <ReadinessScore readiness={readiness} loading={readinessLoading} error={readinessError} />
          {planLocked ? (
            <section className="rounded-[20px] border-2 border-dashed border-ink bg-card p-5">
              <p className="font-display text-lg font-bold text-foreground">Not enough learning evidence yet</p>
              <p className="mt-2 text-sm text-foreground-secondary">{planLocked.reason}</p>
              <p className="mt-2 text-[13px] text-muted-foreground">
                A revision plan is built from your graded-exam signals. Once your next exam is processed, come back and generate one.
              </p>
            </section>
          ) : (
            <RevisionPlan plan={plan} loading={planLoading} error={planError} onGenerate={generatePlan} />
          )}
          {sessions?.length > 0 && (
            <div className="rounded-[20px] border-2 border-ink bg-card p-4">
              <p className="font-display text-base font-bold text-foreground">Past conversations</p>
              <div className="mt-2 space-y-2">
                {sessions.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    onClick={() => {
                      const params = new URLSearchParams();
                      if (student) params.set('student', student);
                      params.set('session', session.sessionId);
                      navigate(`/tutor?${params}`);
                    }}
                    className="min-h-11 w-full rounded-xl border border-border bg-paper-soft px-3 py-2 text-left transition-colors hover:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <p className="truncate text-sm font-semibold text-foreground">
                      {session.firstQuestion || 'Tutor session'}
                    </p>
                    <p className="text-[13px] text-foreground-secondary">
                      {new Date(session.lastAt).toLocaleDateString()} · {session.turns} messages
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
          {pastPlans?.length > 0 && (
            <div className="rounded-[20px] border-2 border-ink bg-card p-4">
              <p className="font-display text-base font-bold text-foreground">Past revision plans</p>
              <div className="mt-2 space-y-2">
                {pastPlans.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => setPlan(row.plan)}
                    className="min-h-11 w-full rounded-xl border border-border bg-paper-soft px-3 py-2 text-left transition-colors hover:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <p className="truncate text-sm font-semibold text-foreground">
                      {row.plan?.priority_1?.topic || row.subject}
                    </p>
                    <p className="text-[13px] text-foreground-secondary">
                      {row.subject} · {new Date(row.createdAt).toLocaleDateString()}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
