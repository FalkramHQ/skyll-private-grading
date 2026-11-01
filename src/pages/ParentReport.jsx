import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Home, Link2Off, Sparkles } from 'lucide-react';
import { Sticker } from '../components/ui/Sticker';
import Loader from '../components/Loader';
import { formatLongDate } from '../lib/formatDate';

// Loud sticker card: ink outline on white. Only the score card adds the hard shadow.
const LOUD_CARD = 'rounded-[20px] border-2 border-ink bg-card';

const hasNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

const percentOf = (score, max) => (hasNumber(score) && hasNumber(max) && Number(max) > 0 ? Math.round((Number(score) / Number(max)) * 100) : null);

function initialsOf(name = '') {
  const letters = String(name).split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 3);
  return letters.toUpperCase() || 'S';
}

function SectionTitle({ children, className = '' }) {
  return <h2 className={`font-display text-xl leading-snug text-foreground ${className}`}>{children}</h2>;
}

/** Raw score first, "/ max" second, percentage and grade only as support. */
function ScoreCard({ report }) {
  const score = hasNumber(report.overallScore) ? Number(report.overallScore) : null;
  const max = hasNumber(report.overallMax) ? Number(report.overallMax) : null;
  const pct = percentOf(score, max);
  const meta = [report.studentName, report.className ? `Class ${report.className}` : '', report.examTitle].filter(Boolean).join(' · ');
  const date = formatLongDate(report.examDate);

  return (
    <section aria-label="How they did" className={`${LOUD_CARD} p-5 shadow-hard-lg sm:p-6`}>
      <p className="text-[15px] leading-relaxed text-foreground-secondary">{meta}</p>
      {score !== null && max !== null ? (
        <p className="mt-2 font-display font-extrabold leading-[0.9] tracking-[-0.05em] tabular-nums text-foreground">
          <span className="text-[72px] sm:text-[80px]">{score}</span>
          <span className="text-[28px] sm:text-[30px] text-foreground-secondary">/{max}</span>
        </p>
      ) : (
        <p className="mt-2 text-base text-foreground-secondary">Marks will appear here once the school publishes them.</p>
      )}
      {(pct !== null || report.overallGrade) && (
        <p className="mt-3 text-base font-semibold text-foreground">
          {[pct !== null ? `${pct}% of marks` : '', report.overallGrade ? `Grade ${report.overallGrade}` : ''].filter(Boolean).join(' · ')}
        </p>
      )}
      {date && <p className="mt-1 text-sm text-muted-foreground">{date}</p>}
    </section>
  );
}

function SubjectRows({ subjects }) {
  return (
    <section className={`${LOUD_CARD} overflow-hidden`}>
      <SectionTitle className="px-5 pb-2 pt-4">Subjects</SectionTitle>
      <ul>
        {subjects.map((subject, i) => {
          const hasScore = hasNumber(subject.score) && hasNumber(subject.maxMarks);
          const note = subject.practice?.[0]?.topic
            ? `Practise ${subject.practice[0].topic} a little more.`
            : subject.improvements?.[0]
              ? subject.improvements[0]
              : subject.strengths?.[0] || '';
          return (
            <li key={`${subject.name}-${i}`} className={`flex flex-col gap-1 px-5 py-3.5 ${i === 0 ? 'border-t-[1.5px] border-ink' : 'border-t border-border'}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-[17px] font-bold text-foreground">{subject.name}</span>
                {hasScore ? (
                  <span className="shrink-0 font-display text-xl font-extrabold tabular-nums text-foreground">{subject.score}/{subject.maxMarks}</span>
                ) : subject.grade ? (
                  <span className="shrink-0 font-display text-xl font-extrabold text-foreground">Grade {subject.grade}</span>
                ) : null}
              </div>
              {note && <p className="text-base leading-relaxed text-foreground-secondary">{note}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PracticeAtHome({ subjects }) {
  const groups = subjects
    .map((subject) => ({
      name: subject.name,
      practice: (subject.practice || []).filter((item) => item?.action),
      improvements: subject.improvements || [],
    }))
    .filter((group) => group.practice.length > 0 || group.improvements.length > 0);
  if (groups.length === 0) return null;

  return (
    <section aria-labelledby="practice-at-home" className="rounded-[20px] border-2 border-ink bg-lime p-5">
      <div className="flex items-center gap-2">
        <Home className="h-5 w-5 shrink-0 text-ink" strokeWidth={2.4} aria-hidden="true" />
        <SectionTitle><span id="practice-at-home">What to practise at home</span></SectionTitle>
      </div>
      <div className="mt-3 space-y-4">
        {groups.map((group) => (
          <div key={group.name}>
            <p className="text-sm font-bold uppercase tracking-[0.06em] text-ink">{group.name}</p>
            <ul className="mt-1.5 space-y-2">
              {group.practice.length > 0
                ? group.practice.map((item, i) => (
                    <li key={i} className="text-[17px] leading-relaxed text-ink">
                      {item.topic && <span className="font-bold">{item.topic}: </span>}
                      {item.action}
                    </li>
                  ))
                : group.improvements.map((item, i) => (
                    <li key={i} className="text-[17px] leading-relaxed text-ink">{item}</li>
                  ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function Strengths({ subjects }) {
  const rows = subjects.flatMap((subject) => (subject.strengths || []).map((text) => ({ subject: subject.name, text })));
  if (rows.length === 0) return null;
  return (
    <section className={`${LOUD_CARD} p-5`}>
      <SectionTitle>What is going well</SectionTitle>
      <ul className="mt-3 space-y-3">
        {rows.map((row, i) => (
          <li key={i} className="flex gap-2.5">
            <CheckCircle2 className="mt-1 h-[18px] w-[18px] shrink-0 text-success" strokeWidth={2.4} aria-hidden="true" />
            <p className="text-base leading-relaxed text-foreground">
              <span className="font-semibold">{row.subject}: </span>{row.text}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextMove({ nextMove }) {
  if (!nextMove?.action) return null;
  return (
    <section className={`${LOUD_CARD} flex flex-col gap-3 p-5`}>
      <Sticker tone="coral" tilt={-2} className="self-start px-3 py-1.5 text-[13px]">One thing to try together</Sticker>
      {nextMove.title && <p className="font-display text-[22px] font-extrabold leading-tight tracking-[-0.02em] text-foreground">{nextMove.title}</p>}
      <p className="text-base leading-relaxed text-foreground-secondary">{nextMove.action}</p>
    </section>
  );
}

function LearningProfile({ learnerDna }) {
  const patterns = learnerDna?.patterns || [];
  if (!learnerDna || (patterns.length === 0 && !learnerDna.learningStyle)) return null;
  return (
    <section className={`${LOUD_CARD} p-5`}>
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 shrink-0 text-ink" strokeWidth={2.2} aria-hidden="true" />
        <SectionTitle>How they learn</SectionTitle>
      </div>
      {learnerDna.learningStyle && <p className="mt-2 text-base leading-relaxed text-foreground">{learnerDna.learningStyle}</p>}
      {patterns.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {patterns.map((pattern, i) => (
            <li key={i} className="rounded-full border-[1.5px] border-ink bg-paper px-3 py-1 text-sm font-semibold text-foreground">{pattern}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function ParentReport() {
  const [searchParams] = useSearchParams();
  // `/r/<token>` comes from WhatsApp report messages; `?token=` from older links.
  const { token: pathToken } = useParams();
  const token = pathToken || searchParams.get('token');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) {
      setError('No access token provided');
      setLoading(false);
      return;
    }
    async function loadReport() {
      try {
        const res = await fetch(`/api/auth/parent?token=${encodeURIComponent(token)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to load report');
        setData(json);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    loadReport();
  }, [token]);

  if (loading) {
    return (
      <div className="notebook-grid flex min-h-screen items-center justify-center px-4">
        <div className="flex flex-col items-center gap-4 rounded-[20px] border-2 border-ink bg-card px-8 py-7 shadow-hard-lg">
          <Loader size="page" />
          <p className="text-base font-semibold text-foreground">Loading report...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="notebook-grid flex min-h-screen items-center justify-center px-4 py-10">
        <main className={`${LOUD_CARD} flex w-full max-w-md flex-col items-center gap-3 px-6 py-9 text-center shadow-hard-lg`}>
          <span className="flex h-14 w-14 rotate-[-4deg] items-center justify-center rounded-full border-2 border-ink bg-card" aria-hidden="true">
            <Link2Off className="h-6 w-6 text-ink" strokeWidth={2.4} />
          </span>
          <h1 className="font-display text-2xl text-foreground">Unable to load report</h1>
          <p className="text-base text-foreground-secondary">{error || 'This link may have expired.'}</p>
          <p className="text-sm text-muted-foreground">Contact the school for a new link.</p>
        </main>
      </div>
    );
  }

  const report = data.report;
  const subjects = report.subjects || [];
  const expires = formatLongDate(data.expiresAt, { day: 'numeric', month: 'long' });

  return (
    <div className="notebook-grid min-h-screen text-foreground">
      <header className="mx-auto flex max-w-2xl items-center gap-3 px-4 pb-2 pt-5 sm:px-6">
        <span className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-xl border-2 border-ink bg-card text-[13px] font-bold text-ink" aria-hidden="true">
          {initialsOf(report.schoolName)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[17px] font-bold leading-snug text-foreground">{report.schoolName || 'Student report'}</p>
          <p className="text-sm text-foreground-secondary">Student report via Skyll</p>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-4 px-4 pb-10 pt-3 sm:px-6">
        <h1 className="sr-only">{report.studentName}: {report.examTitle}</h1>
        <ScoreCard report={report} />
        {subjects.length > 0 && <SubjectRows subjects={subjects} />}
        <PracticeAtHome subjects={subjects} />
        <NextMove nextMove={report.learnerDna?.nextMove} />
        <Strengths subjects={subjects} />
        <LearningProfile learnerDna={report.learnerDna} />

        <footer className="space-y-1 pt-3 text-center">
          <p className="text-sm leading-relaxed text-foreground-secondary">
            Generated by Skyll · This report is confidential and intended for the parent/guardian of {report.studentName}.
          </p>
          {expires && <p className="text-sm text-muted-foreground">This link works until {expires}.</p>}
        </footer>
      </main>
    </div>
  );
}
