import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpenCheck, Brain, MessagesSquare, NotebookPen } from 'lucide-react';
import { listPracticeTests, listTutorSessions } from '../lib/db';

export default function AiHub() {
  const navigate = useNavigate();
  const [practice, setPractice] = useState(null);
  const [sessions, setSessions] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listPracticeTests({ limit: 5 })
      .then((payload) => { if (!cancelled) setPractice(payload.practiceTests || []); })
      .catch(() => { if (!cancelled) setPractice([]); });
    listTutorSessions({ limit: 5 })
      .then((payload) => { if (!cancelled) setSessions(payload.sessions || []); })
      .catch(() => { if (!cancelled) setSessions([]); });
    return () => { cancelled = true; };
  }, []);

  const lastTest = (practice || [])[0];
  const lastSession = (sessions || [])[0];
  const cards = [
    {
      title: 'Practice tests',
      icon: BookOpenCheck,
      detail: practice === null
        ? 'Loading…'
        : practice.length === 0
          ? 'No tests yet - generate one'
          : `${practice.length} test${practice.length === 1 ? '' : 's'}${
            lastTest?.score != null ? ` · last ${lastTest.score}/${lastTest.totalMarks}` : ''}`,
      onClick: () => navigate('/practice'),
    },
    {
      title: 'AI Tutor',
      icon: MessagesSquare,
      detail: sessions === null
        ? 'Loading…'
        : sessions.length === 0
          ? 'Start a conversation'
          : `${sessions.length} conversation${sessions.length === 1 ? '' : 's'} · last ${
            new Date(lastSession.lastAt).toLocaleDateString()}`,
      onClick: () => navigate('/tutor'),
    },
    {
      title: 'Learning Hive',
      icon: Brain,
      detail: 'Your learning modes + evidence signals',
      onClick: () => navigate('/hive'),
    },
    {
      title: 'Revision plan',
      icon: NotebookPen,
      detail: 'Evidence-bound priorities from your reports',
      onClick: () => navigate('/tutor'),
    },
  ];

  return (
    <section aria-label="AI tools">
      <h2 className="mb-3 font-display text-[26px] leading-tight text-foreground">Your AI tools</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(({ title, icon: Icon, detail, onClick }) => (
          <button
            key={title}
            type="button"
            onClick={onClick}
            className="press group flex min-h-[132px] flex-col rounded-[20px] border-2 border-ink bg-card p-4 text-left shadow-hard transition-colors hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border-[1.5px] border-ink bg-action-tint text-ink" aria-hidden="true">
              <Icon className="h-5 w-5" strokeWidth={2.2} />
            </span>
            <span className="mt-3 font-display text-[17px] font-bold leading-tight text-foreground">{title}</span>
            <span className="mt-1 text-[13px] leading-relaxed text-foreground-secondary">{detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
