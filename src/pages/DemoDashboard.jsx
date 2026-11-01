import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, LogOut, Search } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs';
import { StatusBadge } from '../components/ui/StatusBadge';
import { RangeBar } from '../components/ui/RangeBar';
import { EmptyState } from '../components/ui/EmptyState';
import { cn } from '../lib/utils';

// ---------------------------------------------------------------------------
// Static demo data. This page mirrors the production TeacherDashboard layout
// but runs entirely on sample data - no session or API calls are required, so
// it can be used from the public "Try demo" link on the landing page.
// ---------------------------------------------------------------------------

export const DEMO_SCHOOL = 'Sunrise International School';
export const DEMO_ASSESSMENT = 'Mid-Term Assessment · 9A';

export const DEMO_STUDENTS = [
  { name: 'Aarav Sharma', username: 'aarav9tu', class: '9A', maths: { score: 15, total: 20 }, science: { score: 14, total: 20 } },
  { name: 'Priya Patel', username: 'priya9tu', class: '9A', maths: { score: 18, total: 20 }, science: { score: 16, total: 20 } },
  { name: 'Rohit Kumar', username: 'rohit9tu', class: '9A', maths: { score: 8, total: 20 }, science: { score: 10, total: 20 } },
  { name: 'Sneha Gupta', username: 'sneha9tu', class: '9A', maths: { score: 12, total: 20 }, science: { score: 11, total: 20 } },
  { name: 'Vikram Singh', username: 'vikram9tu', class: '9A', maths: { score: 19, total: 20 }, science: { score: 18, total: 20 } },
  { name: 'Ananya Reddy', username: 'ananya9tu', class: '9A', maths: { score: 6, total: 20 }, science: { score: 7, total: 20 } },
  { name: 'Karthik Nair', username: 'karthik9tu', class: '9A', maths: { score: 14, total: 20 }, science: { score: 13, total: 20 } },
  { name: 'Divya Joshi', username: 'divya9tu', class: '9A', maths: { score: 11, total: 20 }, science: { score: 15, total: 20 } },
  { name: 'Arjun Mehta', username: 'arjun9tu', class: '9A', maths: { score: 16, total: 20 }, science: { score: 12, total: 20 } },
  { name: 'Kavya Iyer', username: 'kavya9tu', class: '9A', maths: { score: 9, total: 20 }, science: { score: 8, total: 20 } },
];

const DEMO_GAPS = [
  { title: 'Polynomials', avg: '45.3%', description: '45.3% average attainment with 25/25 visible attempts. Priority reteach needed on zero-finding and factor theorem.' },
  { title: 'Decimal Representation', avg: '48.0%', description: '48.0% average attainment. Students struggle with converting repeating decimals to fractions.' },
  { title: 'Linear Equations', avg: '56.5%', description: '56.5% average attainment. Common error: incorrect sign handling when transposing terms.' },
];

const DEMO_INTERVENTIONS = [
  { type: 'immediate', title: 'Reteach Polynomials', action: 'Run a 20-minute worked-example loop using one ideal answer, one common incorrect answer, and one corrected answer.' },
  { type: 'immediate', title: 'Target Decimal Representation', action: 'Use a quick diagnostic exit ticket with one low-stakes question and require students to show the full conversion.' },
  { type: 'long-term', title: 'Weekly Verification Routine', action: 'Build in a 5-minute answer-checking habit at the end of every practice set to catch unsimplified or unverified answers.' },
  { type: 'long-term', title: 'Formula Application Practice', action: 'Rotate mixed problem types weekly so students practise selecting the right formula, not just applying a given one.' },
];

const DEMO_SEGMENTATION = {
  quadrant_a: ['Aarav Sharma', 'Priya Patel', 'Vikram Singh'],
  quadrant_b: ['Karthik Nair', 'Arjun Mehta'],
  quadrant_c: ['Sneha Gupta', 'Divya Joshi', 'Kavya Iyer'],
  quadrant_d: ['Rohit Kumar', 'Ananya Reddy'],
};

const DEMO_HOTSPOTS = [
  {
    id: 'Q4',
    title: 'Polynomials - finding zeroes',
    failure_rate: '55% failed or partial',
    why: 'Students treat the polynomial as an expression to simplify rather than an equation to solve; many never set p(x) = 0.',
    implication: 'Re-teach the zero-finding routine with an explicit "set to zero first" step before any factoring.',
  },
  {
    id: 'Q7',
    title: 'Repeating decimal to fraction conversion',
    failure_rate: '52% failed or partial',
    why: 'The multiply-and-subtract method is applied mechanically, with errors in the number of 9s used for the repeating block.',
    implication: 'Use a short drill on matching the repeating block length to the denominator before full conversions.',
  },
  {
    id: 'Q12',
    title: 'Balancing chemical equations',
    failure_rate: '48% failed or partial',
    why: 'Students balance oxygen last but forget to re-check hydrogen after adjusting water molecules.',
    implication: 'Teach a fixed element order (metal, non-metal, H, O) with a final atom-count verification table.',
  },
];

// One fully-worked student profile (matches the production report shape) so
// the sidebar can show the same depth of insight as a live dashboard.
const DEMO_STUDENT_PROFILE = {
  aarav9tu: {
    subjects: [
      {
        name: 'Maths',
        score: 15,
        total: 20,
        learning_profile: {
          core_strength: 'Scored full marks on Q6 (listing rational numbers) and Q8 (decimal conversion).',
          strategies: [{ topic: 'Simplification Practice', strategy: 'Practice converting fractions to simplest form after every conversion. Use the GCD method.' }],
          pattern_recognition: 'Aarav excels in procedural tasks but skips final verification steps, leading to unsimplified answers.',
        },
      },
      {
        name: 'Science',
        score: 14,
        total: 20,
        learning_profile: {
          core_strength: 'Correctly balanced all equations and identified reaction types.',
          strategies: [{ topic: 'Formula Sheet Review', strategy: 'Create a personal formula sheet and practice identifying which formula to use for each problem type.' }],
          pattern_recognition: 'Strong in chemistry, weak in physics calculations. Needs to build formula application skills.',
        },
      },
    ],
  },
};


const PASS_PCT = 35;
const TAB_PILL = 'h-9 shrink-0 rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground hover:border-hairline-strong hover:text-foreground data-[state=active]:border-ink data-[state=active]:bg-ink data-[state=active]:text-lime';

// Segments are framed by the help each group needs next, never by a label.
const SUPPORT_GROUPS = [
  { key: 'quadrant_d', title: 'Rebuild the foundations', note: 'Core concepts need reteaching before new work.' },
  { key: 'quadrant_c', title: 'Make the idea behind the method click', note: 'They put in the effort; the mental model is not secure yet.' },
  { key: 'quadrant_b', title: 'Practise applying steps in new contexts', note: 'Accurate steps. Unfamiliar questions are where marks go.' },
  { key: 'quadrant_a', title: 'Ready for harder problems', note: 'Accurate and consistent. Worth stretching.' },
];

function tierFor(pct) {
  if (pct >= 75) return { label: 'Strong', status: 'positive' };
  if (pct >= 45) return { label: 'Developing', status: 'caution' };
  return { label: 'Needs Work', status: 'critical' };
}

const percentOf = (value) => {
  const n = parseFloat(String(value ?? '').replace('%', ''));
  return Number.isFinite(n) ? n : null;
};

function splitFailureRate(rate) {
  const match = String(rate || '').match(/^\s*(\d+(?:\.\d+)?)\s*%\s*(.*)$/);
  if (!match) return { value: rate || '', caption: '' };
  return { value: `${match[1]}%`, caption: match[2] };
}

function initialsOf(name) {
  return String(name || '').trim().split(/\s+/).filter(Boolean).map((part) => part[0]).join('').substring(0, 2).toUpperCase();
}

export default function DemoDashboard() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedSubject, setSelectedSubject] = useState('Maths');
  const [studentSearch, setStudentSearch] = useState('');
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [sortBy, setSortBy] = useState('name');
  const [performanceFilter, setPerformanceFilter] = useState('');

  const subjectKey = selectedSubject === 'Maths' ? 'maths' : 'science';
  const scoreOf = (s) => s[subjectKey];
  const pctOf = (s) => Math.round((scoreOf(s).score / scoreOf(s).total) * 100);

  // Mirrors the production dashboard: opening a student's full report in a new
  // tab. In the demo this points at a static report page (no login required).
  const openStudentReport = (username) => {
    if (!username) return;
    window.open(`/demo/report/${username}`, '_blank', 'noopener,noreferrer');
  };

  const filteredStudents = DEMO_STUDENTS.filter((s) => {
    const haystack = `${s.name} ${s.username} ${s.class}`.toLowerCase();
    const matchesSearch = haystack.includes(studentSearch.trim().toLowerCase());
    const pct = pctOf(s);
    const matchesPerformance = !performanceFilter
      || (performanceFilter === 'strong' && pct >= 75)
      || (performanceFilter === 'developing' && pct >= 45 && pct < 75)
      || (performanceFilter === 'needs-work' && pct < 45);
    return matchesSearch && matchesPerformance;
  });

  const sortedStudents = [...filteredStudents].sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'marks-asc') return scoreOf(a).score - scoreOf(b).score;
    if (sortBy === 'marks-desc') return scoreOf(b).score - scoreOf(a).score;
    return 0;
  });

  const count = DEMO_STUDENTS.length;
  const avgPct = Math.round(DEMO_STUDENTS.reduce((acc, s) => acc + pctOf(s), 0) / count);
  const passedCount = DEMO_STUDENTS.filter((s) => pctOf(s) >= PASS_PCT).length;
  const topScorer = DEMO_STUDENTS.reduce((best, s) => (scoreOf(s).score > scoreOf(best).score ? s : best), DEMO_STUDENTS[0]);
  const avgScore = Math.round(DEMO_STUDENTS.reduce((acc, s) => acc + scoreOf(s).score, 0) / count);
  const avgMax = Math.round(DEMO_STUDENTS.reduce((acc, s) => acc + scoreOf(s).total, 0) / count);

  const topicsWeakestFirst = [...DEMO_GAPS].sort((a, b) => (percentOf(a.avg) ?? 101) - (percentOf(b.avg) ?? 101));
  const weakestTopic = topicsWeakestFirst[0];
  const supportGroups = SUPPORT_GROUPS
    .map((group) => ({ ...group, students: DEMO_SEGMENTATION[group.key] || [] }))
    .filter((group) => group.students.length > 0);

  const immediateInterventions = DEMO_INTERVENTIONS.filter((i) => i.type === 'immediate');
  const longTermInterventions = DEMO_INTERVENTIONS.filter((i) => i.type === 'long-term');

  const selectRow = (s) => setSelectedStudent(s);

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-screen flex-col bg-background">
      {/* --- Top bar --- */}
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 w-full max-w-[1180px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span className="font-headline text-[22px] font-extrabold leading-none tracking-[-0.03em] text-ink">
              <span className="sr-only">Skyll</span>
              <span aria-hidden="true">skyll<span className="text-coral">.</span></span>
            </span>
            <span className="truncate border-l border-border pl-3 text-[13px] text-foreground-secondary">{DEMO_SCHOOL}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge status="caution" className="hidden sm:inline-flex">Sample data</StatusBadge>
            <Button variant="ghost" size="sm" onClick={() => navigate('/')} title="Exit demo" className="h-10 gap-1.5 px-3 text-sm text-foreground-secondary hover:text-foreground">
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Exit demo</span>
              <span className="sr-only sm:hidden">Exit demo</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 pb-14 pt-6 sm:px-6 sm:pt-8 lg:px-8">
        {/* Demo banner: say what this is and where to go next. */}
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-sm text-foreground-secondary">
            <span className="font-semibold text-ink">Sample data.</span> A fictional class of {count} students, with the same dashboard and reports your teachers would use.
          </p>
          <Button asChild className="shrink-0">
            <a href="/partner">Start a free trial with your own answer sheets</a>
          </Button>
        </div>

        {/* --- Page header --- */}
        <header className="mt-8 flex flex-col gap-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <h1 className="font-headline text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink sm:text-[44px]">{DEMO_ASSESSMENT}</h1>
              <p className="text-sm text-foreground-secondary">{count} students · {selectedSubject} · {avgMax} marks</p>
            </div>
            <label className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-foreground-secondary">Subject</span>
              <Select value={selectedSubject} onChange={(e) => setSelectedSubject(e.target.value)} className="h-9 w-auto cursor-pointer py-1 pl-3 pr-8 text-sm font-semibold">
                <option value="Maths">Maths</option>
                <option value="Science">Science</option>
              </Select>
            </label>
          </div>

          <TabsList className="h-auto w-full justify-start gap-2 overflow-x-auto border-b-0 bg-transparent no-scrollbar">
            <TabsTrigger value="overview" className={TAB_PILL}>Overview</TabsTrigger>
            <TabsTrigger value="students" className={TAB_PILL}>Students · {count}</TabsTrigger>
            <TabsTrigger value="hotspots" className={TAB_PILL}>Questions · {DEMO_HOTSPOTS.length}</TabsTrigger>
            <TabsTrigger value="action" className={TAB_PILL}>Action plan</TabsTrigger>
          </TabsList>
        </header>

        <div className="mt-6">
          {/* --- Overview --- */}
          <TabsContent value="overview" className="flex flex-col gap-5 outline-none">
            <section aria-label="Summary" className="grid items-center gap-7 rounded-[20px] bg-ink px-5 py-7 text-white sm:px-9 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              <p className="font-headline text-[21px] font-bold leading-[1.3] tracking-[-0.01em] sm:text-[26px]">
                {count} students averaged {avgPct}% in {selectedSubject}, and {passedCount} passed.{' '}
                <span className="rounded bg-lime px-1.5 text-ink [box-decoration-break:clone]">{weakestTopic.title}</span>
                {' '}is the topic to reteach first, with a class average of {Math.round(percentOf(weakestTopic.avg))}%.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <InkStat label="Class average" value={`${avgPct}%`} hint={`${avgScore}/${avgMax} marks on average`} />
                <InkStat label="Passed" value={`${passedCount}/${count}`} hint={`Pass mark ${PASS_PCT}%`} />
                <div className="col-span-2 flex items-baseline justify-between gap-3 rounded-xl border border-white/20 px-3.5 py-3">
                  <span className="text-[13px] text-white/70">Top score</span>
                  <span className="min-w-0 truncate text-right text-sm font-semibold">
                    <span className="tabular-nums">{scoreOf(topScorer).score}/{scoreOf(topScorer).total}</span>
                    <span className="text-white/70"> · {topScorer.name}</span>
                  </span>
                </div>
              </div>
            </section>

            <div className="grid items-start gap-5 lg:grid-cols-2">
              <Card role="region" aria-labelledby="demo-dist" className="flex flex-col gap-4 p-5 sm:p-6">
                <SectionHeading id="demo-dist" title="How scores spread" description={`Students in each score band · ${selectedSubject}`} />
                <ScoreDistributionChart students={DEMO_STUDENTS} subjectKey={subjectKey} />
              </Card>

              <Card role="region" aria-labelledby="demo-topics" className="flex flex-col gap-4 p-5 sm:p-6">
                <SectionHeading id="demo-topics" title="Topics, weakest first" description="Class average on each priority topic" />
                <ul className="flex flex-col gap-5">
                  {topicsWeakestFirst.map((g, i) => {
                    const value = percentOf(g.avg);
                    return (
                      <li key={g.title} className="flex flex-col gap-2">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[15px] font-bold text-ink">{g.title}</span>
                          <span className="font-headline text-lg font-extrabold tabular-nums text-ink">{Math.round(value)}%</span>
                        </div>
                        <RangeBar value={value} label={`${g.title}: class average ${Math.round(value)}%`} />
                        {i === 0 && <StatusBadge status="caution" className="self-start">Reteach first</StatusBadge>}
                        <p className="text-[13px] leading-relaxed text-foreground-secondary">{g.description}</p>
                      </li>
                    );
                  })}
                </ul>
              </Card>

              <Card role="region" aria-labelledby="demo-support" className="flex flex-col gap-4 p-5 sm:p-6">
                <SectionHeading id="demo-support" title="Who needs what next" description="Grouped by the help they need, never by a label" />
                <ul className="flex flex-col gap-3">
                  {supportGroups.map((group, i) => (
                    <li key={group.key} className={cn('flex flex-col gap-1.5 rounded-xl px-4 py-3.5', i === 0 ? 'border-[1.5px] border-ink' : 'border border-border')}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-[15px] font-bold text-ink">{group.title}</span>
                        <span className="shrink-0 text-sm tabular-nums text-foreground-secondary">{group.students.length} student{group.students.length === 1 ? '' : 's'}</span>
                      </div>
                      <p className="text-sm text-foreground">{group.students.join(', ')}</p>
                      <p className="text-[13px] text-foreground-secondary">{group.note}</p>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card role="region" aria-labelledby="demo-costly" className="flex flex-col gap-2 p-5 sm:p-6">
                <SectionHeading id="demo-costly" title="Questions that cost the most" description="With the mistake most students made" />
                <ul className="flex flex-col">
                  {DEMO_HOTSPOTS.map((h) => {
                    const rate = splitFailureRate(h.failure_rate);
                    return (
                      <li key={h.id} className="grid grid-cols-[40px_minmax(0,1fr)_auto] gap-3 border-b border-border py-3 last:border-b-0">
                        <span className="font-headline text-[15px] font-extrabold text-ink">{h.id}</span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[15px] font-semibold text-ink">{h.title}</span>
                          <span className="text-sm text-foreground-secondary">{h.why}</span>
                        </span>
                        <span className="flex flex-col items-end">
                          <span className="font-headline text-lg font-extrabold tabular-nums text-ink">{rate.value}</span>
                          {rate.caption && <span className="max-w-[6rem] text-right text-[12px] leading-tight text-muted-foreground">{rate.caption}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <Button variant="link" className="h-auto self-start px-0 py-1 text-sm font-bold" onClick={() => setActiveTab('hotspots')}>
                  See every question with its fix
                </Button>
              </Card>
            </div>

            <Card role="region" aria-labelledby="demo-interventions" className="flex flex-col gap-4 p-5 sm:p-6">
              <SectionHeading
                id="demo-interventions"
                title="Recommended interventions"
                description="What to change in the next few lessons"
                action={<Button variant="secondary" size="sm" onClick={() => setActiveTab('action')}>Open the action plan</Button>}
              />
              <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {DEMO_INTERVENTIONS.map((inv, i) => (
                  <li key={inv.title} className="flex flex-col gap-1.5 rounded-xl border border-border p-4">
                    <span className="text-[12px] font-bold tabular-nums text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                    <p className="text-[15px] font-bold text-ink">{inv.title}</p>
                    <p className="text-sm leading-relaxed text-foreground-secondary">{inv.action}</p>
                  </li>
                ))}
              </ol>
            </Card>
          </TabsContent>

          {/* --- Students --- */}
          <TabsContent value="students" className="outline-none">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
              <Card className="flex min-w-0 flex-col overflow-hidden">
                <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center">
                  <div className="relative w-full sm:flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <Input
                      aria-label="Search students"
                      value={studentSearch}
                      onChange={(event) => setStudentSearch(event.target.value)}
                      placeholder="Search students"
                      className="pl-9"
                    />
                  </div>
                  <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 no-scrollbar" role="group" aria-label="Filter by performance">
                    {[['', 'All'], ['strong', 'Strong'], ['developing', 'Developing'], ['needs-work', 'Needs Work']].map(([value, text]) => (
                      <button
                        key={text}
                        type="button"
                        aria-pressed={performanceFilter === value}
                        onClick={() => setPerformanceFilter(value)}
                        className={cn(
                          'h-9 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          performanceFilter === value ? 'border-ink bg-ink text-lime' : 'border-border bg-card text-foreground hover:border-hairline-strong',
                        )}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="md:max-h-[calc(100vh-280px)] md:overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-card">
                      <tr className="border-b border-border text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                        <th scope="col" className="px-4 py-2.5 font-semibold sm:px-5">
                          <button type="button" onClick={() => setSortBy(sortBy === 'name' ? 'marks-desc' : 'name')} className="inline-flex items-center gap-1 uppercase hover:text-foreground">
                            Student <span aria-hidden="true">{sortBy === 'name' ? '↑' : '↕'}</span>
                          </button>
                        </th>
                        <th scope="col" className="hidden px-4 py-2.5 font-semibold sm:table-cell">
                          <button type="button" onClick={() => setSortBy(sortBy === 'marks-desc' ? 'marks-asc' : 'marks-desc')} className="inline-flex items-center gap-1 uppercase hover:text-foreground">
                            Score <span aria-hidden="true">{sortBy === 'marks-desc' ? '↓' : sortBy === 'marks-asc' ? '↑' : '↕'}</span>
                          </button>
                        </th>
                        <th scope="col" className="hidden px-4 py-2.5 font-semibold md:table-cell">Status</th>
                        <th scope="col" className="w-14 px-4 py-2.5 text-right font-semibold sm:px-5"><span className="sr-only">Report</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedStudents.map((s) => {
                        const isSelected = selectedStudent?.username === s.username;
                        const sc = scoreOf(s);
                        const tier = tierFor(pctOf(s));
                        return (
                          <tr
                            key={s.username}
                            tabIndex={0}
                            onClick={() => selectRow(s)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRow(s); } }}
                            className={cn(
                              'cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                              isSelected && 'bg-paper-soft shadow-[inset_3px_0_0_var(--ink)]',
                            )}
                          >
                            <td className="px-4 py-3 sm:px-5">
                              <div className="flex min-w-0 items-center gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-bold text-foreground-secondary" aria-hidden="true">{initialsOf(s.name)}</span>
                                <span className="min-w-0">
                                  <span className="block truncate text-[15px] font-semibold text-ink">{s.name}</span>
                                  <span className="block truncate text-[13px] text-foreground-secondary">Class {s.class} · {s.username}</span>
                                  <span className="mt-1 flex items-center gap-2 sm:hidden">
                                    <span className="text-sm font-bold tabular-nums text-ink">{sc.score} / {sc.total}</span>
                                    <StatusBadge status={tier.status}>{tier.label}</StatusBadge>
                                  </span>
                                </span>
                              </div>
                            </td>
                            <td className="hidden px-4 py-3 sm:table-cell">
                              <span className="font-headline text-lg font-extrabold tabular-nums text-ink">{sc.score}</span>
                              <span className="text-sm tabular-nums text-muted-foreground"> / {sc.total}</span>
                            </td>
                            <td className="hidden px-4 py-3 md:table-cell"><StatusBadge status={tier.status}>{tier.label}</StatusBadge></td>
                            <td className="px-4 py-3 text-right sm:px-5">
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); openStudentReport(s.username); }}
                                aria-label={`Open report for ${s.name}`}
                                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border text-foreground-secondary transition-colors hover:border-ink hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <ArrowRight className="h-4 w-4" aria-hidden="true" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!sortedStudents.length && (
                    <EmptyState icon={Search} title="No matching students">Try adjusting your search or performance filter.</EmptyState>
                  )}
                </div>
              </Card>

              <StudentReportPreview student={selectedStudent || sortedStudents[0]} onOpenReport={openStudentReport} />
            </div>
          </TabsContent>

          {/* --- Questions --- */}
          <TabsContent value="hotspots" className="flex flex-col gap-5 outline-none">
            <SectionHeading title="Questions that cost the most" description="Each question with the common mistake and what it means for teaching." />
            <ul className="flex flex-col gap-3">
              {DEMO_HOTSPOTS.map((h, i) => {
                const rate = splitFailureRate(h.failure_rate);
                const intervention = immediateInterventions[i % immediateInterventions.length] || {};
                return (
                  <li key={h.id}>
                    <Card className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 gap-y-3 p-5 sm:grid-cols-[48px_minmax(0,1fr)_auto] sm:p-6">
                      <span className="font-headline text-lg font-extrabold text-ink">{h.id}</span>
                      <h3 className="min-w-0 self-center text-[16px] font-bold leading-snug text-ink">{h.title}</h3>
                      <div className="col-start-2 flex items-baseline gap-2 sm:col-start-3 sm:row-start-1 sm:flex-col sm:items-end sm:gap-0">
                        <span className="font-headline text-[21px] font-extrabold tabular-nums text-ink">{rate.value}</span>
                        {rate.caption && <span className="text-[12px] text-muted-foreground sm:max-w-[7rem] sm:text-right">{rate.caption}</span>}
                      </div>
                      <dl className="col-span-2 grid gap-3 border-t border-border pt-3 text-sm sm:col-span-1 sm:col-start-2">
                        <div className="grid gap-0.5 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3">
                          <dt className="text-[13px] font-semibold text-muted-foreground">Common mistake</dt>
                          <dd className="leading-relaxed text-foreground">{h.why}</dd>
                        </div>
                        <div className="grid gap-0.5 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3">
                          <dt className="text-[13px] font-semibold text-muted-foreground">Fix</dt>
                          <dd className="leading-relaxed text-foreground">{h.implication}</dd>
                        </div>
                        <div className="grid gap-0.5 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3">
                          <dt className="text-[13px] font-semibold text-muted-foreground">Next step</dt>
                          <dd className="leading-relaxed text-foreground">
                            <span className="font-semibold">{intervention.title}</span>
                            <span className="text-foreground-secondary"> · {intervention.action}</span>
                          </dd>
                        </div>
                      </dl>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </TabsContent>

          {/* --- Action plan --- */}
          <TabsContent value="action" className="outline-none">
            <div className="grid items-start gap-5 md:grid-cols-2">
              <Card role="region" aria-labelledby="demo-now" className="flex flex-col gap-4 p-5 sm:p-6">
                <SectionHeading id="demo-now" title="This week" description="Immediate curriculum adjustments" />
                <ol className="flex flex-col">
                  {immediateInterventions.map((inv, i) => (
                    <li key={inv.title} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 border-b border-border py-3 last:border-b-0">
                      <span className="text-[13px] font-bold tabular-nums text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                      <span className="flex flex-col gap-1">
                        <span className="text-[15px] font-bold text-ink">{inv.title}</span>
                        <span className="text-sm leading-relaxed text-foreground-secondary">{inv.action}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </Card>
              <Card role="region" aria-labelledby="demo-later" className="flex flex-col gap-4 p-5 sm:p-6">
                <SectionHeading id="demo-later" title="Over the term" description="Long-term teaching shifts" />
                <ol className="flex flex-col">
                  {longTermInterventions.map((inv, i) => (
                    <li key={inv.title} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 border-b border-border py-3 last:border-b-0">
                      <span className="text-[13px] font-bold tabular-nums text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                      <span className="flex flex-col gap-1">
                        <span className="text-[15px] font-bold text-ink">{inv.title}</span>
                        <span className="text-sm leading-relaxed text-foreground-secondary">{inv.action}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </Card>
            </div>
          </TabsContent>
        </div>
      </main>
    </Tabs>
  );
}

function SectionHeading({ id, title, description, action }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id={id} className="font-headline text-[21px] font-extrabold leading-tight text-ink">{title}</h2>
        {description && <p className="text-sm text-foreground-secondary">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function InkStat({ label, value, hint }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-white/20 p-3.5">
      <span className="text-[13px] text-white/70">{label}</span>
      <span className="font-headline text-[32px] font-extrabold leading-tight tracking-[-0.03em] tabular-nums sm:text-[40px]">{value}</span>
      {hint && <span className="truncate text-[13px] text-white/70">{hint}</span>}
    </div>
  );
}

function ScoreDistributionChart({ students, subjectKey }) {
  const scores = students.map((s) => {
    const sc = s[subjectKey];
    return sc.total > 0 ? Math.round((sc.score / sc.total) * 100) : 0;
  });

  const buckets = [
    { label: '0–20%', min: 0, max: 20 },
    { label: '21–40%', min: 21, max: 40 },
    { label: '41–60%', min: 41, max: 60 },
    { label: '61–80%', min: 61, max: 80 },
    { label: '81–100%', min: 81, max: 100 },
  ];

  const data = buckets.map((b) => ({
    name: b.label,
    count: scores.filter((s) => s >= b.min && s <= b.max).length,
  }));
  const max = Math.max(1, ...data.map((d) => d.count));
  const description = data.map((d) => `${d.name}: ${d.count} student${d.count === 1 ? '' : 's'}`).join('; ');

  return (
    <div>
      <div role="img" aria-label={description} className="grid h-[180px] grid-cols-5 items-end gap-3 border-b-[1.5px] border-ink px-1 sm:h-[200px] sm:gap-4">
        {data.map((d) => (
          <div key={d.name} className="flex h-full flex-col items-center justify-end gap-1.5">
            <span className="text-[13px] font-bold tabular-nums text-ink">{d.count}</span>
            {d.count > 0 && (
              <div className="w-full max-w-14 rounded-t-md border-[1.5px] border-b-0 border-ink bg-chart-1" style={{ height: `${Math.round((d.count / max) * 82)}%` }} />
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-5 gap-3 px-1 text-center text-[12px] tabular-nums text-foreground-secondary sm:gap-4 sm:text-[13px]" aria-hidden="true">
        {data.map((d) => <span key={d.name}>{d.name}</span>)}
      </div>
    </div>
  );
}

function StudentReportPreview({ student, onOpenReport }) {
  if (!student) {
    return (
      <Card className="p-5">
        <p className="text-sm text-foreground-secondary">Select a student to view report details.</p>
      </Card>
    );
  }

  const profile = DEMO_STUDENT_PROFILE[student.username];
  const subjects = profile
    ? profile.subjects
    : [
        { name: 'Maths', score: student.maths.score, total: student.maths.total },
        { name: 'Science', score: student.science.score, total: student.science.total },
      ];

  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3 p-5 pb-4">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Selected student</p>
          <h3 className="mt-1 truncate font-headline text-[21px] font-extrabold leading-tight text-ink">{student.name}</h3>
          <p className="mt-0.5 truncate text-[13px] text-foreground-secondary">Class {student.class} · {student.username}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onOpenReport?.(student.username)} className="shrink-0 text-[13px]">
          Show Full Report
        </Button>
      </div>

      <div className="flex flex-col gap-3 px-5 pb-5">
        {subjects.map((subject) => {
          const pct = subject.total > 0 ? Math.round((subject.score / subject.total) * 100) : 0;
          const lp = subject.learning_profile || {};
          const tier = tierFor(pct);
          return (
            <div key={subject.name} className="rounded-xl border border-border p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="text-[15px] font-bold text-ink">{subject.name}</p>
                <div className="flex items-center gap-2">
                  <span className="font-headline text-base font-extrabold tabular-nums text-ink">{subject.score}/{subject.total}</span>
                  <StatusBadge status={tier.status} className="tabular-nums">{pct}%</StatusBadge>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                {lp.core_strength && (
                  <div>
                    <p className="text-[12px] font-semibold text-success">Strength</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-foreground">{lp.core_strength}</p>
                  </div>
                )}
                {lp.strategies?.[0] && (
                  <div className="border-t border-border pt-3">
                    <p className="text-[12px] font-semibold text-muted-foreground">Next step</p>
                    <p className="mt-0.5 text-[13px] font-semibold text-ink">{lp.strategies[0].topic || lp.strategies[0].title}</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-foreground-secondary">{lp.strategies[0].strategy}</p>
                  </div>
                )}
                {!lp.core_strength && (
                  <p className="text-[13px] text-foreground-secondary">Detailed insights are generated for every student in live reports.</p>
                )}
              </div>
            </div>
          );
        })}

        {subjects.map((subject) => {
          const lp = subject.learning_profile || {};
          if (!lp.pattern_recognition) return null;
          return (
            <div key={`pattern-${subject.name}`} className="rounded-xl bg-paper-soft p-4">
              <p className="mb-1 text-[12px] font-semibold text-muted-foreground">Learning pattern · {subject.name}</p>
              <p className="text-[13px] leading-relaxed text-foreground">{lp.pattern_recognition}</p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
