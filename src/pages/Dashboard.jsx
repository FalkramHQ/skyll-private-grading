import { useNavigate, useSearchParams } from 'react-router-dom';
import { useRef, useEffect } from 'react';
import { loginPathForSchool } from '../lib/auth';
import { signOut } from '../lib/session';
import { LogOut, ChevronRight, CircleUserRound, Download, Brain, Compass, Zap, CheckCircle2, CircleDot, Circle, Sparkles, Target, ArrowLeft, ArrowRight } from 'lucide-react';
import { studentData, getCurrentExamData } from '../data/studentData';
import { createStudentReportView } from '../lib/reportViewModel';
import { normalizeLearnerDna } from '../lib/learnerDna';
import AiHub from '../components/AiHub';
import DnaBadge from '../components/DnaBadge';
import { buildExamEntries, examFilterSortOptions, filterAndSortExamEntries, readExamFilterState, writeExamFilterState } from '../lib/examFilters';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Sticker } from '../components/ui/Sticker';
import { track } from '../lib/analytics';
import { cn } from '../lib/utils';

/* Loud notebook surfaces: the student volume. */
const LOUD_CARD = 'rounded-[20px] border-2 border-ink bg-card';
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const ICON_BUTTON = `inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border-2 border-ink bg-card px-2.5 text-sm font-semibold text-ink transition-colors hover:bg-paper ${FOCUS_RING}`;
const FIELD = 'mt-1 h-11 w-full rounded-[10px] border-[1.5px] border-ink bg-card px-2.5 text-sm font-normal text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const FIELD_LABEL = 'text-[13px] font-semibold text-foreground-secondary';

// Grouped by what to do next; never a label about the student.
const scoreStatus = (pct) => (pct >= 75
  ? { status: 'positive', label: 'Going well' }
  : pct >= 45
    ? { status: 'info', label: 'Getting there' }
    : { status: 'caution', label: 'Practise next' });

export default function Dashboard({ teacherView = false, backUrl = '/dashboard' }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const exams = studentData.exams || [];
  const selectedExam = searchParams.get('exam') || exams[0]?.id || 'term1';

  const currentData = createStudentReportView(getCurrentExamData(selectedExam));

  const filterState = readExamFilterState(searchParams);
  const allExamSubjects = buildExamEntries(exams, (id) => createStudentReportView(getCurrentExamData(id)), studentData.student || {});
  const visibleExamSubjects = filterAndSortExamEntries(allExamSubjects, filterState, filterState.sort);
  const filterOptions = {
    year: [...new Set(allExamSubjects.map((e) => e._exam.academicYear).filter(Boolean))],
    subject: [...new Set(allExamSubjects.map((e) => e._exam.subject).filter(Boolean))],
    grade: [...new Set(allExamSubjects.map((e) => e._exam.grade).filter(Boolean))],
    type: [...new Set(allExamSubjects.map((e) => e._exam.examType).filter(Boolean))],
    exam: [...new Map(allExamSubjects.map((e) => [e._exam.id, e._exam])).values()],
  };
  const updateFilter = (key, value) => setSearchParams(writeExamFilterState(searchParams, { ...filterState, [key]: value }), { replace: true });
  const clearFilters = () => setSearchParams(writeExamFilterState(searchParams, { year: '', subject: '', grade: '', type: '', exam: '', dateFrom: '', dateTo: '', sort: 'newest' }), { replace: true });

  const handleLogout = async () => { const path = loginPathForSchool(); await signOut(); navigate(path); };

  useEffect(() => {
    if (!exams.length && !studentData?.learner_dna) return undefined;
    track('report_viewed', {
      examId: selectedExam || null,
      teacherView: Boolean(teacherView),
      surface: 'web_dashboard',
    });
    if (studentData?.learner_dna) {
      track('dna_viewed', { surface: 'web_dashboard', teacherView: Boolean(teacherView) });
    }
    return undefined;
  }, [selectedExam, teacherView, exams.length]);

  const buildSubjectUrl = (subjectId, examId) => {
    const params = new URLSearchParams();
    params.set('exam', examId || selectedExam);
    const tab = searchParams.get('tab');
    const subject = searchParams.get('subject');
    const cls = searchParams.get('cls');
    if (tab) params.set('tab', tab);
    if (subject) params.set('subject', subject);
    if (cls) params.set('cls', cls);
    if (teacherView && studentData.username) params.set('student', studentData.username);
    return `/subject/${subjectId}?${params.toString()}`;
  };

  if (!currentData) {
    return (
      <div className="notebook-grid flex min-h-screen items-center justify-center px-4">
        <div className={`${LOUD_CARD} space-y-4 px-6 py-8 text-center shadow-hard-lg`}>
          <p className="text-base font-semibold text-foreground">No report data found</p>
          <Button variant="outline" onClick={handleLogout} className="h-11 border-2 px-5">Logout</Button>
        </div>
      </div>
    );
  }

  const { name, class: cls, school, avatar, examInfo: _examInfo } = currentData;
  const learnerDna = normalizeLearnerDna(studentData.learner_dna);
  const firstName = (name || '').split(' ')[0];
  const filtersActive = Boolean(filterState.year || filterState.subject || filterState.grade || filterState.type || filterState.dateFrom || filterState.dateTo);

  // "Your best" is earned: the single highest score across two or more published exams.
  const ranked = [...allExamSubjects].sort((a, b) => Number(b.pct || 0) - Number(a.pct || 0));
  const bestEntry = ranked.length > 1 && Number(ranked[0].pct || 0) > Number(ranked[1].pct || 0) ? ranked[0] : null;
  const bestKey = bestEntry ? `${bestEntry.id}-${bestEntry._examId}` : '';

  const openTutor = () => {
    const params = new URLSearchParams();
    if (teacherView && studentData.username) params.set('student', studentData.username);
    navigate(`/tutor${params.toString() ? `?${params}` : ''}`);
  };

  return (
    <div className="notebook-grid min-h-screen text-foreground">
      <header className="sticky top-0 z-50 border-b-2 border-ink bg-paper">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/skyll-logo.svg" alt="Skyll" className="hidden h-7 w-7 sm:block" />
            <div className="flex h-10 w-10 shrink-0 rotate-[-3deg] items-center justify-center rounded-xl border-2 border-ink bg-lime font-display text-sm font-extrabold text-ink" aria-hidden="true">{avatar}</div>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-bold text-foreground">{name}</p>
              <p className="truncate text-[13px] leading-tight text-foreground-secondary">Class {cls} · {school}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!teacherView && <button type="button" onClick={() => navigate('/profile')} className={ICON_BUTTON} aria-label="Open my profile" title="My profile"><CircleUserRound className="h-5 w-5" /></button>}
            <button type="button" onClick={() => {
              const reportParams = new URLSearchParams();
              reportParams.set('exam', selectedExam);
              const tab = searchParams.get('tab');
              const subject = searchParams.get('subject');
              const clsParam = searchParams.get('cls');
              if (tab) reportParams.set('tab', tab);
              if (subject) reportParams.set('subject', subject);
              if (clsParam) reportParams.set('cls', clsParam);
              if (['teacher', 'admin', 'skyll_admin'].includes(localStorage.getItem('userRole')) && studentData.username) reportParams.set('student', studentData.username);
              navigate(`/report?${reportParams.toString()}`);
            }} className={ICON_BUTTON} aria-label="Open the printable report" title="Printable report">
              <Download className="h-5 w-5" />
            </button>
            {teacherView ? (
              <button type="button" onClick={() => navigate(backUrl)} className={ICON_BUTTON}>
                <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                <span className="hidden sm:inline">Back to Students</span>
              </button>
            ) : (
              <button type="button" onClick={handleLogout} className={ICON_BUTTON} aria-label="Log out" title="Log out">
                <LogOut className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl space-y-8 px-4 pb-16 pt-8 sm:px-6">
        <section aria-label="Welcome">
          {teacherView ? (
            <>
              <p className="text-[15px] font-semibold text-foreground-secondary">Student report</p>
              <h1 className="mt-1 font-display text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-foreground sm:text-[44px]">{name}</h1>
            </>
          ) : (
            <h1 className="font-display text-[32px] font-extrabold leading-[1.08] tracking-[-0.03em] text-foreground sm:text-[44px]">
              Hi {firstName || 'there'}, here&rsquo;s <span className="bg-lime px-1.5 [box-decoration-break:clone]">what&rsquo;s next</span>.
            </h1>
          )}
        </section>

        {currentData.learningPlan?.nextAction && (
          <NextStepsCard
            learningPlan={currentData.learningPlan}
            onNavigate={navigate}
            buildSubjectUrl={buildSubjectUrl}
          />
        )}

        <section aria-labelledby="your-exams">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 id="your-exams" className="font-display text-[26px] text-foreground">Your Exams</h2>
            {(filterState.year || filterState.subject || filterState.grade || filterState.type || filterState.exam || filterState.dateFrom || filterState.dateTo || filterState.sort !== 'newest') && <button type="button" onClick={clearFilters} className={`h-11 rounded-[10px] px-2 text-sm font-semibold text-foreground underline underline-offset-4 hover:bg-card ${FOCUS_RING}`}>Clear filters</button>}
          </div>
          <div className={`${LOUD_CARD} mb-5 flex flex-wrap items-end gap-2 p-3 sm:flex-nowrap`} aria-label="Exam report filters">
            {/* Primary: Exam */}
            <label className={`min-w-0 flex-1 basis-full sm:basis-auto ${FIELD_LABEL}`}>Exam<select aria-label="Exam" value={filterState.exam} onChange={(event) => updateFilter('exam', event.target.value)} className={FIELD}><option value="">All exams</option>{filterOptions.exam.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
            {/* Primary: Sort */}
            <label className={`min-w-0 flex-1 sm:flex-none ${FIELD_LABEL}`}>Sort<select aria-label="Sort order" value={filterState.sort} onChange={(event) => updateFilter('sort', event.target.value)} className={FIELD}>{examFilterSortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {/* More filters dropdown */}
            <details className="relative shrink-0">
              <summary className={`flex h-11 cursor-pointer select-none list-none items-center gap-1.5 rounded-[10px] border-[1.5px] border-ink bg-card px-3 text-sm font-semibold text-foreground hover:bg-paper ${FOCUS_RING}`}>
                More
                {filtersActive
                  ? <><span className="h-2.5 w-2.5 rounded-full border-[1.5px] border-ink bg-lime" aria-hidden="true" /><span className="sr-only">(filters on)</span></>
                  : <ChevronRight className="h-4 w-4 rotate-90" aria-hidden="true" />}
              </summary>
              <div className="absolute right-0 top-full z-50 mt-2 grid w-[min(320px,calc(100vw-2rem))] grid-cols-2 gap-3 rounded-2xl border-2 border-ink bg-card p-4 shadow-hard-md">
                {[['year', 'Academic year', filterOptions.year], ['subject', 'Subject', filterOptions.subject], ['grade', 'Grade/class', filterOptions.grade], ['type', 'Exam type', filterOptions.type]].map(([key, label, options]) => (
                  <label key={key} className={`min-w-0 ${FIELD_LABEL}`}>{label}<select aria-label={label} value={filterState[key]} onChange={(event) => updateFilter(key, event.target.value)} className={FIELD}><option value="">All</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
                ))}
                <label className={FIELD_LABEL}>From<input aria-label="Exam date from" type="date" value={filterState.dateFrom} onChange={(event) => updateFilter('dateFrom', event.target.value)} className={FIELD} /></label>
                <label className={FIELD_LABEL}>To<input aria-label="Exam date to" type="date" value={filterState.dateTo} onChange={(event) => updateFilter('dateTo', event.target.value)} className={FIELD} /></label>
              </div>
            </details>
          </div>
        {allExamSubjects.length === 0 ? (
          <div className={LOUD_CARD}>
            <EmptyState icon={Sparkles} title="No exams yet">
              Your exam reports will appear here once they are graded.
            </EmptyState>
          </div>
        ) : visibleExamSubjects.length === 0 ? (
          <div className="rounded-[20px] border-2 border-dashed border-ink bg-card px-5 py-8 text-center text-base text-foreground-secondary" role="status">No published exam reports match these filters.</div>
        ) : (
        <div className="space-y-4">
          <p className="sr-only" role="status">Showing {visibleExamSubjects.length} published exam report{visibleExamSubjects.length === 1 ? '' : 's'}</p>
          {visibleExamSubjects.map((s) => (
            <SubjectCard key={s.id + '-' + s._examId} subject={s} best={`${s.id}-${s._examId}` === bestKey} onOpen={(subj) => navigate(buildSubjectUrl(subj.id, subj._examId))} />
          ))}
        </div>
        )}
        </section>

        {/* AI hub - every student AI feature reachable from one grid */}
        {!teacherView && <AiHub />}

        {/* Learning DNA - cross-exam, one per student */}
        {learnerDna && (
          <LearningDNA
            dna={learnerDna}
            firstName={firstName}
            onOpenHive={() => {
              const params = new URLSearchParams();
              if (teacherView && studentData.username) params.set('student', studentData.username);
              navigate(`/hive${params.toString() ? `?${params}` : ''}`);
            }}
            onOpenTutor={openTutor}
          />
        )}

        {studentData.learning_diagnosis && (
          <LearningDiagnosis
            diagnosis={studentData.learning_diagnosis}
            onOpenTutor={openTutor}
          />
        )}
      </main>
    </div>
  );
}

export function SubjectCard({ subject: s, onOpen, best = false }) {
  const tone = scoreStatus(s.pct);
  const qs = s.questions || [];
  const qCorrect = qs.filter(q => q.marks_total > 0 && Number(q.marks_obtained) >= Number(q.marks_total)).length;
  const qPartial = qs.filter(q => {
    const got = Number(q.marks_obtained);
    return Number.isFinite(got) && got > 0 && got < Number(q.marks_total);
  }).length;
  const qWrong = qs.filter(q => {
    const got = Number(q.marks_obtained);
    return !Number.isFinite(got) || got <= 0;
  }).length;
  const examName = s._examName || s._exam?.name;
  const focusLine = s.pct >= 75
    ? (s.learning_profile?.core_strength
        ? s.learning_profile.core_strength.slice(0, 80) + (s.learning_profile.core_strength.length > 80 ? '…' : '')
        : 'Strong performance')
    : s.pct >= 45
      ? (s.nextAction
          ? `Focus: ${s.nextAction.topic}`
          : 'Developing - keep practicing')
      : (s.misconceptions?.length > 0
          ? `Gap: ${s.misconceptions[0].issue}`
          : 'Needs focused attention');

  return (
    <button type="button" onClick={() => onOpen?.(s)}
      className={`press group relative w-full ${LOUD_CARD} p-4 text-left shadow-hard transition-colors hover:bg-paper-soft sm:p-5 ${FOCUS_RING}`}>
      {best && (
        <Sticker tone="lime" tilt={5} className="absolute -right-2 -top-3 z-10">Your best score</Sticker>
      )}
      <div className="flex items-center gap-3 sm:gap-5">
        <p className="shrink-0 whitespace-nowrap font-display font-extrabold leading-none tracking-[-0.04em] tabular-nums text-foreground">
          <span className="text-[40px] sm:text-[48px]">{s.score}</span>
          <span className="text-lg text-foreground-secondary sm:text-xl">/{s.total}</span>
        </p>

        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-lg leading-tight text-foreground">{examName || s.name}</h3>
          {examName && s.name && examName !== s.name && (
            <p className="truncate text-[13px] font-medium text-foreground-secondary">{s.name}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={tone.status} className="text-[13px]">{tone.label}</StatusBadge>
            <span className="text-sm font-semibold tabular-nums text-foreground-secondary">{s.pct}%</span>
          </div>
          {qs.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <div className="flex h-2.5 w-full max-w-[140px] overflow-hidden rounded-full border-[1.5px] border-ink bg-sunken" aria-hidden="true">
                {qCorrect > 0 && <div className="bg-success" style={{ width: `${(qCorrect / qs.length) * 100}%` }} />}
                {qPartial > 0 && <div className="bg-warning" style={{ width: `${(qPartial / qs.length) * 100}%` }} />}
              </div>
              <p className="flex items-center gap-2.5 text-[13px] font-medium tabular-nums text-foreground-secondary">
                {qCorrect > 0 && <span className="inline-flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />{qCorrect} full</span>}
                {qPartial > 0 && <span className="inline-flex items-center gap-1"><CircleDot className="h-3.5 w-3.5 text-warning" aria-hidden="true" />{qPartial} part</span>}
                {qWrong > 0 && <span className="inline-flex items-center gap-1"><Circle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />{qWrong} none</span>}
                <span className="sr-only">of {qs.length} questions</span>
              </p>
            </div>
          )}
          <p className="mt-2 line-clamp-2 text-sm text-foreground">{focusLine}</p>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-ink transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </div>
    </button>
  );
}

const RADAR_LABELS = {
  architect: 'Concepts',
  pathfinder: 'Methods',
  maker: 'Execution',
  cartographer: 'Notation',
  calibrator: 'Checking',
  bridgebuilder: 'Transfer',
};

// State dots: coral marks "practise next", never an error.
const STATE_STYLE = {
  secure: { color: 'var(--color-success)', label: 'Secure' },
  developing: { color: 'var(--color-warning)', label: 'Developing' },
  needs_practice: { color: 'var(--color-coral)', label: 'Practise next' },
  not_observed: { color: 'var(--color-faint)', label: 'Not seen yet' },
};

function LearningModeRadar({ dimensions }) {
  const cx = 110, cy = 92, R = 62;
  const angles = [-90, -30, 30, 90, 150, 210].map((d) => (d * Math.PI) / 180);

  const guideHex = (pct) => {
    const r = R * pct;
    return angles.map((a) => `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`).join(' ');
  };

  const points = dimensions.map((d, i) => {
    const score = d.score != null ? d.score : 0;
    const r = (score / 100) * R;
    return { x: cx + r * Math.cos(angles[i]), y: cy + r * Math.sin(angles[i]), dim: d };
  });

  const polygon = points.map((p) => `${p.x},${p.y}`).join(' ');
  const summary = dimensions.map((d) => `${RADAR_LABELS[d.id] || d.id}: ${(STATE_STYLE[d.state] || STATE_STYLE.not_observed).label}${d.score != null && d.state !== 'not_observed' ? ` (${d.score}%)` : ''}`).join(', ');

  return (
    <svg viewBox="0 0 220 180" className="mx-auto w-full max-w-[320px]" role="img" aria-label={`Learning modes. ${summary}`}>
      {[0.25, 0.5, 0.75, 1].map((pct) => (
        <polygon key={pct} points={guideHex(pct)} fill="none" stroke="var(--color-hairline)" strokeWidth={pct === 1 ? 1 : 0.6} strokeDasharray={pct === 1 ? '' : '2 2'} />
      ))}
      {angles.map((a, i) => (
        <line key={i} x1={cx} y1={cy} x2={cx + R * Math.cos(a)} y2={cy + R * Math.sin(a)} stroke="var(--color-hairline)" strokeWidth="0.6" />
      ))}
      <polygon points={polygon} fill="var(--color-seq-1)" fillOpacity="0.55" stroke="var(--color-ink)" strokeWidth="1.5" strokeLinejoin="round" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="3.4" fill={(STATE_STYLE[dimensions[i].state] || STATE_STYLE.not_observed).color} stroke="var(--color-ink)" strokeWidth="1" />
          <text x={cx + (R + 15) * Math.cos(angles[i])} y={cy + (R + 15) * Math.sin(angles[i]) - 3} textAnchor="middle" dominantBaseline="middle" fontSize="9" fontWeight="700" fill="var(--color-foreground)">
            {RADAR_LABELS[dimensions[i].id] || dimensions[i].id}
          </text>
          {dimensions[i].score != null && dimensions[i].state !== 'not_observed' && (
            <text x={cx + (R + 15) * Math.cos(angles[i])} y={cy + (R + 15) * Math.sin(angles[i]) + 7.5} textAnchor="middle" dominantBaseline="middle" fontSize="8.5" fill="var(--color-muted-foreground)">
              {dimensions[i].score}%
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

export function LearningDNA({ dna, firstName, onOpenHive, onOpenTutor }) {
  if (dna.schema_version !== 2) return null;
  const primary = dna.primary_mode || {};
  const growth = dna.growth_edge || {};
  const dimensions = dna.dimensions || [];
  const identity = dna.identity || {};
  const scope = dna.assessment_scope || {};
  const shownStates = [...new Set(dimensions.map((d) => d.state))].filter((state) => STATE_STYLE[state]);

  return (
    <section className={`${LOUD_CARD} p-5 sm:p-6`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {primary.mode_id ? <DnaBadge personaTitle={primary.mode_id} size={48} /> : <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 border-ink bg-lime text-ink"><Brain className="h-5 w-5" aria-hidden="true" /></div>}
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-foreground-secondary">{firstName ? `${firstName}'s Learning DNA` : 'Learning DNA'}</p>
            <h2 className="font-display text-[21px] leading-tight text-foreground">{identity.label || 'Learning snapshot'}</h2>
          </div>
        </div>
        {scope.label && <span className="shrink-0 rounded-full bg-sunken px-2.5 py-1 text-[13px] font-semibold text-foreground-secondary">{scope.label}</span>}
      </div>

      <div className="grid items-center gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <LearningModeRadar dimensions={dimensions} />
          {shownStates.length > 0 && (
            <ul className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1" aria-label="Legend">
              {shownStates.map((state) => (
                <li key={state} className="inline-flex items-center gap-1.5 text-[13px] text-foreground-secondary">
                  <span className="h-2.5 w-2.5 rounded-full border border-ink" style={{ background: STATE_STYLE[state].color }} aria-hidden="true" />
                  {STATE_STYLE[state].label}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-3">
          {[
            { key: 'strength', Icon: Sparkles, chip: 'bg-lime', label: 'Strength:', text: primary.title },
            { key: 'growth', Icon: Target, chip: 'bg-card', label: 'Growth:', text: growth.title },
            { key: 'next', Icon: Zap, chip: 'bg-coral', label: 'Next:', text: dna.next_move?.title },
          ].map(({ key, Icon, chip, label, text }) => (
            <div key={key} className="flex items-start gap-3">
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-[1.5px] border-ink ${chip}`} aria-hidden="true">
                <Icon className="h-4 w-4 text-ink" strokeWidth={2.4} />
              </span>
              <p className="min-w-0 pt-1 text-[15px] leading-snug text-foreground">
                <span className="font-bold">{label}</span> <span className="text-foreground-secondary">{text}</span>
              </p>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2 pt-2">
            {onOpenHive && (
              <Button onClick={onOpenHive} className="h-11 gap-1.5 px-4 text-sm">
                <Sparkles className="h-4 w-4" aria-hidden="true" /> View Hive
              </Button>
            )}
            {onOpenTutor && (
              <Button variant="outline" onClick={onOpenTutor} className="h-11 border-2 px-4 text-sm">
                Ask Tutor
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function LearningDiagnosis({ diagnosis, onOpenTutor }) {
  const patterns = diagnosis.patterns || [];
  const strengths = diagnosis.strengths || [];
  return (
    <section className={`${LOUD_CARD} p-5 sm:p-6`}>
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-[1.5px] border-ink bg-sunken text-ink" aria-hidden="true"><Compass className="h-5 w-5" /></span>
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-foreground-secondary">Learning diagnosis</p>
          <h2 className="font-display text-[21px] leading-tight text-foreground">{diagnosis.headline}</h2>
        </div>
      </div>

      {diagnosis.score_effect && (
        <p className="mb-4 rounded-xl bg-paper-soft px-3.5 py-2.5 text-[15px] leading-relaxed text-foreground">{diagnosis.score_effect}</p>
      )}

      {patterns.length > 0 && (
        <div className="mb-4 space-y-3">
          {patterns.map((pattern) => (
            <div key={pattern.title} className="rounded-2xl border border-border bg-paper-soft p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-base font-bold text-foreground">{pattern.title}</p>
                {pattern.impact && <span className="shrink-0 rounded-full bg-warning-soft px-2.5 py-1 text-[13px] font-semibold text-warning-soft-foreground">{pattern.impact}</span>}
              </div>
              {pattern.next_step && (
                <p className="mt-2 text-sm leading-relaxed text-foreground-secondary"><span className="font-bold text-foreground">Next: </span>{pattern.next_step}</p>
              )}
              {pattern.evidence?.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {pattern.evidence.map((question) => <span key={question} className="rounded-full border-[1.5px] border-ink bg-card px-2.5 py-0.5 text-[13px] font-semibold text-foreground">{question}</span>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {strengths.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-[13px] font-bold text-foreground-secondary">Working well</p>
          <div className="flex flex-wrap gap-2">
            {strengths.map((strength) => (
              <span key={strength.title} className="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-3 py-1 text-[13px] font-semibold text-success-soft-foreground">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />{strength.title}
              </span>
            ))}
          </div>
        </div>
      )}

      {(diagnosis.isolated || []).length > 0 && (
        <p className="mb-2 text-[13px] text-muted-foreground">Not a pattern yet: {diagnosis.isolated.map((item) => `${item.question} (${item.topic})`).join('; ')}</p>
      )}

      {diagnosis.attempt_signal && <p className="mb-4 text-[13px] text-muted-foreground">{diagnosis.attempt_signal}</p>}

      {onOpenTutor && (
        <Button onClick={onOpenTutor} className="h-11 px-4 text-sm">
          Make a revision plan
        </Button>
      )}
    </section>
  );
}

export function OverallSummary({ subjects }) {
  const totalScore = subjects.reduce((acc, s) => acc + (Number(s.score) || 0), 0);
  const totalMax = subjects.reduce((acc, s) => acc + (Number(s.total) || 0), 0);
  const overallPct = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
  const strongCount = subjects.filter(s => s.pct >= 75).length;
  const developingCount = subjects.filter(s => s.pct >= 45 && s.pct < 75).length;
  const needsAttentionCount = subjects.filter(s => s.pct < 45).length;

  return (
    <section aria-label="Overall performance" className="px-1 pt-2">
      <div className={`${LOUD_CARD} relative -rotate-2 p-5 shadow-hard-lg sm:p-6`}>
        <span aria-hidden="true" className="absolute -top-3 left-1/2 h-6 w-24 -translate-x-1/2 rotate-3 border-[1.5px] border-ink bg-lime" />
        <p className="text-[15px] font-semibold text-foreground">Overall Performance</p>
        <p className="mt-1 font-display font-extrabold leading-[0.9] tracking-[-0.05em] tabular-nums text-foreground">
          <span className="text-[84px] sm:text-[96px]">{totalScore}</span>
          <span className="text-[30px] text-foreground-secondary sm:text-[34px]">/{totalMax}</span>
        </p>
        <p className="mt-2 text-base font-semibold text-foreground-secondary">{overallPct}% of marks</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <StatPill count={strongCount} label="Going well" status="positive" />
          <StatPill count={developingCount} label="Getting there" status="info" />
          <StatPill count={needsAttentionCount} label="Practise next" status="caution" />
        </div>
      </div>
    </section>
  );
}

function StatPill({ count, label, status }) {
  if (count === 0) return null;
  return (
    <StatusBadge status={status} className="text-[13px]">
      <span className="tabular-nums">{count}</span> {label}
    </StatusBadge>
  );
}

export function NextStepsCard({ learningPlan, onNavigate, buildSubjectUrl }) {
  const { focusSubject, nextAction } = learningPlan;
  if (!nextAction) return null;

  return (
    <section aria-label="Your next step" className={cn(LOUD_CARD, 'flex flex-col gap-3 p-5 sm:p-6')}>
      <Sticker tone="coral" tilt={-2} className="self-start">Your next step</Sticker>
      <p className="font-display text-[24px] font-extrabold leading-tight tracking-[-0.02em] text-foreground sm:text-[26px]">
        {nextAction.topic}
      </p>
      <p className="text-base leading-relaxed text-foreground-secondary">
        {nextAction.shortAction || nextAction.action}
      </p>
      {focusSubject && (
        <Button
          size="lg"
          onClick={() => onNavigate(buildSubjectUrl(focusSubject.id))}
          className="mt-1 h-[54px] w-full justify-between rounded-[14px] border-2 px-5 text-base sm:w-auto sm:min-w-[280px]"
        >
          Go to {focusSubject.name} <ArrowRight className="h-5 w-5" aria-hidden="true" />
        </Button>
      )}
    </section>
  );
}

const CONFETTI_COLORS = ['#C9F230', '#FF6A3D', '#3A3AE8', '#111111'];

export function ConfettiBurst() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const particles = Array.from({ length: 40 }, () => ({
      x: rect.width / 2,
      y: rect.height / 2,
      vx: (Math.random() - 0.5) * 10,
      vy: (Math.random() - 1.2) * 10,
      r: Math.random() * 3 + 2,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 10,
      life: 1,
      decay: 0.015 + Math.random() * 0.015,
      gravity: 0.2 + Math.random() * 0.2,
    }));

    let animId;
    function draw() {
      ctx.clearRect(0, 0, rect.width, rect.height);
      let alive = 0;
      for (const p of particles) {
        if (p.life <= 0) continue;
        alive++;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.vx *= 0.96;
        p.vy *= 0.96;
        p.rotation += p.rotSpeed;
        p.life -= p.decay;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
        ctx.restore();
      }
      if (alive > 0) {
        animId = requestAnimationFrame(draw);
      }
    }
    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 pointer-events-none z-10"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
