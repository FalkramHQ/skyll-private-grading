import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Printer, BookOpen } from 'lucide-react';
import { Badge } from '../components/ui/Badge';
import { StatusBadge } from '../components/ui/StatusBadge';
import { cn } from '../lib/utils';
import { LearningDNA, OverallSummary, LearningDiagnosis, NextStepsCard, SubjectCard } from './Dashboard';
import { normalizeLearnerDna } from '../lib/learnerDna';
import { createStudentReportView } from '../lib/reportViewModel';
import { DEMO_STUDENTS, DEMO_SCHOOL, DEMO_ASSESSMENT } from './DemoDashboard';

// ---------------------------------------------------------------------------
// Static demo student report. This reuses the SAME section components as the
// production student report (Dashboard.jsx) - Learner DNA, Overall Summary,
// Learning Diagnosis, exam subject cards, and Next Steps - fed with sample
// data run through the same normalizers, so it matches the live report
// exactly. No session or API calls are required.
// ---------------------------------------------------------------------------

const MATHS_QUESTIONS = [
  { id: 'M-Q1', topic: 'Number Systems', detail: 'Representing rational numbers on the number line', max: 4 },
  { id: 'M-Q2', topic: 'Polynomials', detail: 'Finding zeroes and verifying the factor theorem', max: 4 },
  { id: 'M-Q3', topic: 'Linear Equations', detail: 'Solving equations using transposition', max: 4 },
  { id: 'M-Q4', topic: 'Decimal Representation', detail: 'Converting repeating decimals to fractions', max: 4 },
  { id: 'M-Q5', topic: 'Coordinate Geometry', detail: 'Plotting points and identifying quadrants', max: 4 },
];

const SCIENCE_QUESTIONS = [
  { id: 'S-Q1', topic: 'Matter', detail: 'States of matter and their properties', max: 4 },
  { id: 'S-Q2', topic: 'Chemical Reactions', detail: 'Balancing chemical equations', max: 4 },
  { id: 'S-Q3', topic: 'Motion', detail: 'Distinguishing distance from displacement', max: 4 },
  { id: 'S-Q4', topic: 'Force & Laws of Motion', detail: "Applying Newton's laws to everyday situations", max: 4 },
  { id: 'S-Q5', topic: 'Cell Biology', detail: 'Cell structure and organelle function', max: 4 },
];

const FEEDBACK = {
  full: [
    'Clear method, correct answer, and a sensible verification step.',
    'Full marks - accurate working with a well-structured explanation.',
    'Excellent: the key concept is applied correctly and justified.',
  ],
  partial: [
    'Correct approach, but a calculation slip in the final step cost a mark.',
    'Method shown correctly; the final answer was left unsimplified.',
    'Right idea, but one key step was skipped so full credit could not be given.',
  ],
  zero: [
    'The core concept was not applied - the answer addresses a different idea.',
    'No working shown and the final answer is incorrect.',
    'Key definition missing, so the reasoning could not be followed.',
  ],
};

function hash(str) {
  let h = 7;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
const pick = (arr, seed) => arr[seed % arr.length];

// Distribute a subject score across its questions so per-question marks always
// add up exactly to the student's recorded score.
function distribute(score, questions, seed) {
  const order = [...questions].sort((a, b) => (hash(a.id + seed) % 997) - (hash(b.id + seed) % 997));
  let remaining = score;
  const awarded = {};
  for (const q of order) {
    if (remaining >= q.max) { awarded[q.id] = q.max; remaining -= q.max; }
    else if (remaining > 0) { awarded[q.id] = remaining; remaining = 0; }
    else awarded[q.id] = 0;
  }
  return awarded;
}

const statusOf = (marks, max) => (marks === max ? 'full' : marks > 0 ? 'partial' : 'zero');
const tierOf = (pct) => (pct >= 75 ? 'strong' : pct >= 45 ? 'developing' : 'needs-work');

const DNA_TEXT = {
  strong: {
    primary: { mode_id: 'architect', title: 'Concept building is the engine', description: 'Builds a clear model of what a question is asking before computing, which keeps accuracy high across topics.', evidence: 'Full-credit answers on multi-step concept questions.' },
    growth: { title: 'Stretch into harder application', action: 'Practise timed, multi-step application problems to convert accuracy into speed under exam conditions.', evidence: 'Small slips appear only on the hardest questions.' },
    next_move: { title: 'Raise the difficulty ceiling', action: 'Two high-difficulty application questions per week, reviewed for method, not just answers.' },
  },
  developing: {
    primary: { mode_id: 'maker', title: 'Execution and completion', description: 'Works through standard routines reliably and finishes questions, with most marks lost at the final step.', evidence: 'Correct methods on routine questions across both subjects.' },
    growth: { title: 'Verify before moving on', action: 'Add a short verification pass at the end of every question to catch unsimplified or slipped answers.', evidence: 'Part-credit answers usually have a correct setup and a weak finish.' },
    next_move: { title: 'Lock in the final step', action: 'One focused practice set per weak topic, ending with a 2-minute check of every final answer.' },
  },
  'needs-work': {
    primary: { mode_id: 'pathfinder', title: 'Problem interpretation is the focus', description: 'Attempts every question but often selects a method before fully interpreting what is being asked.', evidence: 'Attempts on all questions, with concept-level errors on several.' },
    growth: { title: 'Rebuild the foundations', action: 'Revisit core definitions with fully worked examples before attempting independent practice.', evidence: 'Errors cluster on questions requiring the underlying definition.' },
    next_move: { title: 'Basics first, daily', action: '15 minutes a day on foundational concepts, using worked examples before independent attempts.' },
  },
};

function buildRawDna(student, tier) {
  const t = DNA_TEXT[tier];
  const modeStates = {
    strong: { architect: 'secure', pathfinder: 'secure', maker: 'secure', cartographer: 'developing', calibrator: 'developing', bridgebuilder: 'secure' },
    developing: { architect: 'developing', pathfinder: 'developing', maker: 'secure', cartographer: 'developing', calibrator: 'needs_practice', bridgebuilder: 'developing' },
    'needs-work': { architect: 'needs_practice', pathfinder: 'developing', maker: 'developing', cartographer: 'needs_practice', calibrator: 'needs_practice', bridgebuilder: 'needs_practice' },
  }[tier];
  const dimensions = Object.entries(modeStates).map(([id, state]) => {
    const score = state === 'secure' ? 80 + (hash(student.username + id) % 15)
      : state === 'developing' ? 55 + (hash(student.username + id) % 20)
      : 30 + (hash(student.username + id) % 20);
    return { id, state, score, evidence_count: 3 + (hash(student.username + id) % 3), evidence_question_ids: ['Q1', 'Q3', 'Q5'] };
  });
  return {
    primary_mode: t.primary,
    growth_edge: { mode_id: 'calibrator', ...t.growth },
    assessment_scope: { level: 'assessment_snapshot', detail: 'This profile describes evidence from the current assessment. It is a guide for practice, not a fixed label.' },
    dimensions,
    identity: { evidence: `Based on ${DEMO_ASSESSMENT} across Maths and Science.` },
    next_move: t.next_move,
  };
}

function buildDiagnosis(student, tier, subjects) {
  const missed = subjects.flatMap((s) => s.questions.filter((q) => statusOf(q.marks_obtained, q.marks_total) !== 'full').map((q) => `${s.name} · Q${q.number}`));
  return {
    headline: tier === 'strong' ? 'Performance is stable - push the ceiling higher'
      : tier === 'developing' ? 'Uneven topic mastery - a few gaps are costing most marks'
      : 'Foundational gaps need attention before new topics stack up',
    scope: `Based on ${DEMO_ASSESSMENT} across Maths and Science.`,
    score_effect: tier === 'strong' ? 'Closing the last few marks would move the overall score into the top band.'
      : tier === 'developing' ? 'Recovering the part-credit questions identified below would lift the overall score by roughly one grade band.'
      : 'Focusing on the foundational gaps below would recover the largest share of lost marks.',
    patterns: [{
      title: tier === 'strong' ? 'Minor slips on multi-step questions'
        : tier === 'developing' ? 'Drops marks on the final step, not the method'
        : 'Concepts applied mechanically without checking the result',
      detail: tier === 'strong' ? 'Working is sound but occasionally rushed on questions that combine two or more ideas.'
        : tier === 'developing' ? 'The method is usually set up correctly, but the last step (simplifying, verifying, concluding) is where marks slip away.'
        : 'Steps are reproduced from memory without checking whether the answer makes sense, so errors go uncaught.',
      impact: tier === 'strong' ? 'Impact: ~1–2 marks per paper, mostly on the hardest questions.' : 'Impact: 3–5 marks per paper - enough to move up a grade band.',
      next_step: tier === 'strong' ? 'Practise timed multi-step problems and review only the final-step errors.'
        : tier === 'developing' ? 'Add a 2-minute verification pass at the end of every practice set.'
        : 'Use worked examples first, then attempt the same problem independently.',
      evidence: missed.slice(0, 4).length ? missed.slice(0, 4) : ['No significant gaps detected'],
    }],
    strengths: [
      { title: 'Full-credit topics are genuinely understood', detail: 'Full-mark answers show the concept is applied, not guessed.' },
      { title: tier === 'needs-work' ? 'Consistent attempt rate' : 'Reliable on routine questions', detail: tier === 'needs-work' ? 'Every question was attempted - the priority is now accuracy, not effort.' : 'Standard, well-practised question types are answered correctly and consistently.' },
    ],
    attempt_signal: 'All questions were attempted.',
  };
}

function buildReport(student) {
  const seed = student.username;
  const subjectDefs = [
    { id: 'maths', name: 'Maths', key: 'maths', questions: MATHS_QUESTIONS },
    { id: 'science', name: 'Science', key: 'science', questions: SCIENCE_QUESTIONS },
  ];

  const rawSubjects = subjectDefs.map((def) => {
    const { score, total } = student[def.key];
    const pct = Math.round((score / total) * 100);
    const tier = tierOf(pct);
    const awarded = distribute(score, def.questions, seed + def.key);
    const questions = def.questions.map((q, i) => {
      const marks = awarded[q.id];
      const status = statusOf(marks, q.max);
      return {
        number: String(i + 1),
        marks_obtained: marks,
        marks_total: q.max,
        summary: q.topic,
        why_correct: status === 'full' ? pick(FEEDBACK.full, hash(seed + q.id)) : '',
        diagnosis: status !== 'full' ? pick(FEEDBACK[status === 'partial' ? 'partial' : 'zero'], hash(seed + q.id)) : '',
      };
    });
    const weakest = def.questions.reduce((a, b) => (awarded[a.id] / a.max <= awarded[b.id] / b.max ? a : b));
    return {
      id: def.id,
      name: def.name,
      score,
      total,
      status: tier === 'strong' ? 'strong' : tier === 'developing' ? 'developing' : 'needs_work',
      questions,
      learning_profile: { core_strength: `Scored full marks on ${def.questions.filter((q) => awarded[q.id] === q.max).map((q) => q.topic).slice(0, 2).join(' and ') || 'the routine questions'}.` },
      misconceptions: pct < 45 ? [{ issue: `Gaps in ${weakest.topic}` }] : [],
      recommendations: [{ topic: weakest.topic, action: `Focused practice on ${weakest.topic.toLowerCase()}: two short sets this week, checking the final step of every answer.`, priority: 'important' }],
    };
  });

  const totalScore = rawSubjects.reduce((a, s) => a + s.score, 0);
  const totalMax = rawSubjects.reduce((a, s) => a + s.total, 0);
  const overallPct = Math.round((totalScore / totalMax) * 100);
  const tier = tierOf(overallPct);

  // Same normalizers the production report uses.
  const view = createStudentReportView({
    name: student.name,
    class: student.class,
    school: DEMO_SCHOOL,
    avatar: student.name.split(' ').map((p) => p[0]).join('').slice(0, 2),
    examInfo: { id: 'term1', name: DEMO_ASSESSMENT, date: '' },
    overall_insights: { strongest_area: '', focus_needed: [], pattern: '' },
    subjects: rawSubjects,
  });
  const dna = normalizeLearnerDna(buildRawDna(student, tier));
  const diagnosis = buildDiagnosis(student, tier, rawSubjects);

  return { student, view, dna, diagnosis, tier };
}

// Status is icon + words; full credit is success green.
const STATUS_META = {
  full: { label: 'Full credit', status: 'positive', chip: 'bg-success-soft text-success-soft-foreground' },
  partial: { label: 'Partial credit', status: 'caution', chip: 'bg-card text-foreground' },
  zero: { label: 'Not awarded', status: 'neutral', chip: 'bg-warning-soft text-warning-soft-foreground' },
};

const ICON_BUTTON = 'inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border-2 border-ink bg-card px-2.5 text-sm font-semibold text-ink transition-colors hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export default function DemoStudentReport() {
  const { username } = useParams();
  const student = DEMO_STUDENTS.find((s) => s.username === username);

  if (!student) {
    return (
      <div className="notebook-grid flex min-h-screen items-center justify-center px-4">
        <div className="space-y-4 rounded-[20px] border-2 border-ink bg-card px-6 py-8 text-center shadow-hard-lg">
          <p className="text-base font-semibold text-foreground">Student not found.</p>
          <Link to="/demo" className={cn(ICON_BUTTON, 'px-4')}>Back to demo dashboard</Link>
        </div>
      </div>
    );
  }

  const { view, dna, diagnosis } = buildReport(student);
  const scrollToQuestions = () => document.getElementById('demo-question-analysis')?.scrollIntoView({ behavior: 'smooth' });

  return (
    <div className="notebook-grid min-h-screen text-foreground">
      {/* Header - mirrors the production student report header */}
      <header className="sticky top-0 z-50 border-b-2 border-ink bg-paper print:hidden">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/skyll-logo.svg" alt="Skyll" className="hidden h-7 w-7 sm:block" />
            <div className="flex h-10 w-10 shrink-0 rotate-[-3deg] items-center justify-center rounded-xl border-2 border-ink bg-lime font-display text-sm font-extrabold text-ink" aria-hidden="true">{view.avatar}</div>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-bold text-foreground">{student.name}</p>
              <p className="truncate text-[13px] leading-tight text-foreground-secondary">Class {student.class} · {DEMO_SCHOOL}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge variant="warning" className="hidden px-3 py-1 text-[13px] sm:inline-flex">Demo data</Badge>
            <button type="button" onClick={() => window.print()} title="Print / PDF" aria-label="Print or save as PDF" className={ICON_BUTTON}>
              <Printer className="h-5 w-5" aria-hidden="true" />
            </button>
            <Link to="/demo" className={ICON_BUTTON}>
              <ArrowLeft className="h-5 w-5" aria-hidden="true" />
              <span className="hidden sm:inline">Back to demo</span>
              <span className="sr-only sm:hidden">Back to demo</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-8 px-4 pb-12 pt-8 sm:px-6">
        <Badge variant="warning" className="px-3 py-1 text-[13px] sm:hidden">Demo data</Badge>
        {/* Same sections, same components as the production student report */}
        <OverallSummary subjects={view.subjects} />
        <NextStepsCard learningPlan={view.learningPlan} onNavigate={scrollToQuestions} buildSubjectUrl={(id) => id} />

        <section aria-labelledby="demo-your-exams">
          <h2 id="demo-your-exams" className="mb-3 font-display text-[26px] text-foreground">Your Exams</h2>
          <div className="space-y-4">
            {view.subjects.map((s) => (
              <SubjectCard key={s.id} subject={s} onOpen={scrollToQuestions} />
            ))}
          </div>
        </section>

        <LearningDNA dna={dna} firstName={student.name.split(' ')[0]} />
        <LearningDiagnosis diagnosis={diagnosis} />

        {/* Question-level depth (in production this lives on the subject page) */}
        <div id="demo-question-analysis" className="space-y-6">
          {view.subjects.map((s) => (
            <section key={s.id} className="overflow-hidden rounded-[20px] border-2 border-ink bg-card">
              <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-3 pt-5">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-5 w-5 text-ink" aria-hidden="true" />
                  <h2 className="font-display text-[21px] text-foreground">{s.name} - Question Analysis</h2>
                </div>
                <p className="text-sm font-semibold tabular-nums text-foreground-secondary">{s.questions.filter((q) => Number(q.marks_obtained) >= Number(q.marks_total)).length}/{s.questions.length} full credit</p>
              </div>
              <div>
                {s.questions.map((q, index) => {
                  const marks = Number(q.marks_obtained) || 0;
                  const max = Number(q.marks_total) || 0;
                  const status = statusOf(marks, max);
                  const meta = STATUS_META[status];
                  const bank = (s.id === 'maths' ? MATHS_QUESTIONS : SCIENCE_QUESTIONS)[Number(q.number) - 1];
                  const feedback = q.why_correct || q.diagnosis || pick(FEEDBACK[status], hash(student.username + q.number));
                  return (
                    <div key={q.number} className={`px-5 py-4 ${index === 0 ? 'border-t-[1.5px] border-ink' : 'border-t border-border'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-base font-semibold text-foreground"><span className="text-foreground-secondary">Q{q.number}</span> · {q.summary}</p>
                          {bank && <p className="mt-0.5 text-[13px] text-foreground-secondary">{bank.detail}</p>}
                        </div>
                        <span className={`shrink-0 rounded-full border-2 border-ink px-2.5 py-0.5 text-sm font-bold tabular-nums ${meta.chip}`}>{marks}/{max}</span>
                      </div>
                      <StatusBadge status={meta.status} className="mt-2">{meta.label}</StatusBadge>
                      <p className="mt-2 text-sm leading-relaxed text-foreground-secondary">{feedback}</p>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <p className="pb-4 text-center text-[13px] text-muted-foreground">
          Demo report with sample data · Live reports are generated for every student from their actual answer sheets.
        </p>
      </main>
    </div>
  );
}
