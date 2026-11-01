import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { track } from '../lib/analytics';
import { ArrowLeft, Sparkles } from 'lucide-react';
import {
  generatePracticeTest,
  getPracticeTest,
  gradePracticeTest,
  listPracticeTests,
} from '../lib/db';
import { SUBJECTS } from '../lib/subjects';
import Loader from '../components/Loader';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Sticker } from '../components/ui/Sticker';

const LOUD_CARD = 'rounded-[20px] border-2 border-ink bg-card';
const ICON_BUTTON = 'inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border-2 border-ink bg-card px-2.5 text-sm font-semibold text-ink transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export default function PracticeTest() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const student = searchParams.get('student') || searchParams.get('username') || '';
  const topic = searchParams.get('topic') || '';
  const practiceId = searchParams.get('id') || '';

  const [practiceTest, setPracticeTest] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [grading, setGrading] = useState(false);
  const [error, setError] = useState('');
  const [locked, setLocked] = useState(null);
  const [subject, setSubject] = useState('Mathematics');
  const [history, setHistory] = useState(null);

  const questions = useMemo(() => practiceTest?.questions || [], [practiceTest?.questions]);
  const canSubmit = useMemo(
    () => questions.length > 0 && questions.some((question) => String(answers[question.id] || '').trim()),
    [questions, answers],
  );

  async function loadExisting(id) {
    setLoading(true);
    setError('');
    try {
      const payload = await getPracticeTest(id);
      setPracticeTest(payload.practiceTest);
      setResult(null);
    } catch (err) {
      setError(err.message || 'Could not load practice test');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (practiceId) loadExisting(practiceId);
  }, [practiceId]);

  const refreshHistory = useCallback(async () => {
    try {
      const payload = await listPracticeTests({ username: student || undefined, limit: 20 });
      setHistory(payload.practiceTests || []);
    } catch {
      setHistory([]);
    }
  }, [student]);

  useEffect(() => {
    if (!practiceId && !practiceTest) refreshHistory();
  }, [practiceId, practiceTest, refreshHistory]);

  async function handleGenerate() {
    setLoading(true);
    setError('');
    setLocked(null);
    setResult(null);
    setAnswers({});
    try {
      const payload = await generatePracticeTest({
        username: student || undefined,
        subject,
        topics: topic ? [topic] : undefined,
        count: 5,
      });
      if (payload?.ok === false && payload.reason === 'insufficient_data') {
        setLocked(payload.evidence || { reason: 'Not enough learning evidence yet.' });
        return;
      }
      setPracticeTest(payload.practiceTest);
      track('practice_started', { practiceTestId: payload.practiceTest?.id || null, subject, surface: 'web' });
      const next = new URLSearchParams(searchParams);
      next.set('id', payload.practiceTest.id);
      setSearchParams(next, { replace: true });
    } catch (err) {
      setError(err.message || 'Could not generate practice test');
    } finally {
      setLoading(false);
    }
  }

  async function handleGrade() {
    if (!practiceTest?.id) return;
    setGrading(true);
    setError('');
    try {
      const payload = await gradePracticeTest({
        practiceTestId: practiceTest.id,
        answers: questions.map((question) => ({
          questionId: question.id,
          answer: answers[question.id] || '',
        })),
        username: student || undefined,
      });
      setResult(payload);
      setPracticeTest((prev) => (prev ? { ...prev, status: 'graded' } : prev));
      track('practice_completed', { practiceTestId: practiceTest.id, surface: 'web' });
      refreshHistory();
    } catch (err) {
      setError(err.message || 'Could not grade practice test');
    } finally {
      setGrading(false);
    }
  }

  const fullMarks = result && Number(result.maxMarks) > 0 && Number(result.score) >= Number(result.maxMarks);

  return (
    <div className="notebook-grid min-h-screen text-foreground">
      <header className="sticky top-0 z-50 border-b-2 border-ink bg-paper">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <button
            type="button"
            onClick={() => navigate('/tutor')}
            className={ICON_BUTTON}
          >
            <ArrowLeft className="h-5 w-5" aria-hidden="true" />
            <span className="hidden sm:inline">Tutor</span>
            <span className="sr-only sm:hidden">Back to tutor</span>
          </button>
          <div className="min-w-0">
            <p className="truncate font-display text-[19px] font-extrabold leading-tight text-foreground">Practice test</p>
            <p className="truncate text-[13px] text-foreground-secondary">Typed answers · evidence-bound grading</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
        <section className={`${LOUD_CARD} p-5`}>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0 flex-1 basis-64">
              <h1 className="font-display text-[26px] font-extrabold leading-tight tracking-[-0.02em] text-foreground">Targeted practice</h1>
              <p className="mt-1 text-[15px] text-foreground-secondary">
                Questions focus on weak topics from your Hive signals and DNA.
                {topic ? ` Topic filter: ${topic}.` : ''}
              </p>
            </div>
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <select
                aria-label="Subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                disabled={Boolean(practiceTest)}
                className="h-11 min-w-0 flex-1 rounded-[10px] border-[1.5px] border-ink bg-card px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:border-hairline disabled:text-muted-foreground sm:flex-none"
              >
                {SUBJECTS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <Button
                type="button"
                disabled={loading}
                onClick={handleGenerate}
                className="h-11 shrink-0 gap-2 px-4 text-sm"
              >
                {loading ? <Loader size="inline" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
                {practiceTest ? 'New set' : 'Generate'}
              </Button>
            </div>
          </div>
          {error && <p className="mt-3 text-sm font-medium text-destructive">{error}</p>}
        </section>

        {locked && (
          <section className="rounded-[20px] border-2 border-dashed border-ink bg-card p-5">
            <p className="font-display text-lg font-bold text-foreground">Not enough learning evidence yet</p>
            <p className="mt-2 text-sm text-foreground-secondary">{locked.reason}</p>
            <p className="mt-2 text-[13px] text-muted-foreground">
              Signals are created automatically after your graded exams are processed.
              {topic ? '' : ' Pick a specific topic to practice from the question bank in the meantime.'}
            </p>
          </section>
        )}

        {!practiceTest && !loading && history?.length > 0 && (
          <section className={`${LOUD_CARD} p-5`}>
            <h2 className="font-display text-lg text-foreground">
              Past practice tests <span className="tabular-nums text-foreground-secondary">({history.length})</span>
            </h2>
            <div className="mt-3 space-y-2">
              {history.map((test) => (
                <button
                  key={test.id}
                  type="button"
                  onClick={() => loadExisting(test.id)}
                  className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-border bg-paper-soft px-3.5 py-2.5 text-left transition-colors hover:border-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {test.subject} · {new Date(test.createdAt).toLocaleDateString()}
                    </p>
                    <p className="truncate text-[13px] text-foreground-secondary">
                      {(test.topicFocus || []).slice(0, 3).join(', ') || 'Mixed topics'}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[13px] font-bold tabular-nums ${
                    test.score != null
                      ? 'border-2 border-ink bg-card text-foreground'
                      : 'bg-sunken text-foreground-secondary'
                  }`}>
                    {test.score != null ? `${test.score}/${test.totalMarks}` : test.status}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {loading && !practiceTest && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm font-semibold text-foreground-secondary">
            <Loader size="inline" />
            Building your practice set…
          </div>
        )}

        {practiceTest && (
          <section className="space-y-4">
            <div className="flex flex-wrap gap-2 text-[13px]">
              <span className="rounded-full border-[1.5px] border-ink bg-card px-3 py-1 font-semibold text-foreground">
                {practiceTest.subject}
              </span>
              <span className="rounded-full border-[1.5px] border-ink bg-card px-3 py-1 font-semibold tabular-nums text-foreground">
                {practiceTest.totalMarks} marks
              </span>
              {(practiceTest.topicFocus || []).slice(0, 4).map((item) => (
                <span key={item} className="rounded-full bg-action-tint px-3 py-1 font-medium text-foreground">{item}</span>
              ))}
            </div>

            {questions.map((question, index) => {
              const grade = result?.feedback?.questions?.find((row) => row.questionId === question.id);
              const answerId = `practice-answer-${question.id}`;
              return (
                <article key={question.id} className={`${LOUD_CARD} p-4 sm:p-5`}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-base font-bold text-foreground">
                      Q{index + 1}. {question.topic}
                      <span className="ml-2 text-[13px] font-medium text-foreground-secondary">
                        {question.difficulty} · {question.maxMarks} marks
                      </span>
                    </p>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">{question.questionText}</p>
                  {!result && (
                    <textarea
                      id={answerId}
                      aria-label={`Your answer to question ${index + 1}`}
                      value={answers[question.id] || ''}
                      onChange={(event) => setAnswers((prev) => ({ ...prev, [question.id]: event.target.value }))}
                      rows={4}
                      placeholder="Type your answer…"
                      className="mt-3 w-full rounded-xl border-[1.5px] border-ink bg-card px-3 py-2 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  )}
                  {grade && (
                    <div className={`mt-3 rounded-xl px-3.5 py-2.5 text-sm ${grade.isCorrect ? 'bg-success-soft' : 'bg-paper-soft'}`}>
                      <p className="flex flex-wrap items-center gap-2 font-semibold text-foreground">
                        <span className="font-display text-lg font-extrabold tabular-nums">{grade.marksObtained}/{grade.maxMarks}</span>
                        {grade.isCorrect && <StatusBadge status="positive">correct</StatusBadge>}
                      </p>
                      <p className="mt-1 leading-relaxed text-foreground-secondary">{grade.feedback}</p>
                    </div>
                  )}
                </article>
              );
            })}

            {!result && (
              <Button
                type="button"
                size="lg"
                disabled={!canSubmit || grading}
                onClick={handleGrade}
                className="h-[54px] w-full rounded-[14px] border-2 text-base"
              >
                {grading ? 'Grading…' : 'Submit for grading'}
              </Button>
            )}

            {result && (
              <section aria-label="Your practice score" className="px-1 pt-2">
                <div className={`${LOUD_CARD} relative -rotate-1 p-5 shadow-hard-lg sm:p-6`}>
                  <span aria-hidden="true" className="absolute -top-3 left-1/2 h-6 w-24 -translate-x-1/2 rotate-3 border-[1.5px] border-ink bg-lime" />
                  {fullMarks && <Sticker tone="lime" tilt={6} className="absolute -right-2 -top-4 px-3 py-2 font-display text-[15px] font-extrabold">Full marks</Sticker>}
                  <p className="text-[15px] font-semibold text-foreground">Score</p>
                  <p className="mt-1 font-display font-extrabold leading-[0.9] tracking-[-0.05em] tabular-nums text-foreground">
                    <span className="text-[72px]">{result.score}</span>
                    <span className="text-[28px] text-foreground-secondary">/{result.maxMarks}</span>
                  </p>
                  {result.feedback?.overall_feedback && (
                    <p className="mt-3 text-base leading-relaxed text-foreground">{result.feedback.overall_feedback}</p>
                  )}
                  {result.dnaFeed && (
                    <p className="mt-3 text-[13px] text-foreground-secondary">
                      DNA feed: {result.dnaFeed.feedsDna
                        ? `Hive signals written (${result.dnaFeed.written || 0})`
                        : 'deferred'} - {result.dnaFeed.reason || 'practice outcomes stored'}
                    </p>
                  )}
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={() => navigate(`/tutor${student ? `?student=${encodeURIComponent(student)}` : ''}`)}
                      className="h-11 px-4 text-sm"
                    >
                      Ask Tutor about this
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleGenerate}
                      className="h-11 border-2 px-4 text-sm"
                    >
                      Practice a similar set
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => navigate(`/hive${student ? `?student=${encodeURIComponent(student)}` : ''}`)}
                      className="h-11 border-2 px-4 text-sm"
                    >
                      View My Hive
                    </Button>
                  </div>
                </div>
              </section>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
