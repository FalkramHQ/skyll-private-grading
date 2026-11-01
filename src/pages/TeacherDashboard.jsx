import { lazy, Suspense, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  LogOut,
  Search,
  Sparkles,
  UserCircle,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  ChevronDown,
} from 'lucide-react';
import { teacherData, loadTeacherData } from '../data/studentData';
import { loginPathForSchool } from '../lib/auth';
import { track } from '../lib/analytics';
import { signOut } from '../lib/session';
import { assessmentScore, subjectsForAssessment, validClassFilter, withPercentage } from '../lib/teacherAssessment';
import { GRADES, normalizeSubject, availableSubjects as filterSubjects } from '../lib/subjects';
import ClassHivePanel from '../components/ClassHivePanel';
import TeacherAiPanel from '../components/TeacherAiPanel';
import MasteryPanel from '../components/MasteryPanel';
import { getMastery, normalizeMasteryRows } from '../lib/mastery';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/Tabs';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';

// KaTeX + markdown only render in the report preview; keep them out of the dashboard chunk.
const MathText = lazy(() => import('../components/MathText'));
import { Select } from '../components/ui/Select';
import { StatusBadge } from '../components/ui/StatusBadge';
import { RangeBar } from '../components/ui/RangeBar';
import { EmptyState } from '../components/ui/EmptyState';
import { cn } from '../lib/utils';
import { formatLongDate } from '../lib/formatDate';
import Loader from '../components/Loader';

// Quiet workspace: pill tabs, ink active state with lime text.
const TAB_PILL = 'h-9 shrink-0 rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground hover:border-hairline-strong hover:text-foreground data-[state=active]:border-ink data-[state=active]:bg-ink data-[state=active]:text-lime';
const FILTER_SELECT = 'h-9 w-auto shrink-0 cursor-pointer py-1 pl-3 pr-8 text-sm';

// Pass mark used across the dashboard (percent of the paper).
const PASS_PCT = 35;

// Segments are framed by the help each group needs next, never by a label.
const SUPPORT_GROUPS = [
  { key: 'quadrant_d', title: 'Rebuild the foundations', note: 'Core concepts need reteaching before new work.' },
  { key: 'quadrant_c', title: 'Make the idea behind the method click', note: 'They put in the effort; the mental model is not secure yet.' },
  { key: 'quadrant_b', title: 'Practise applying steps in new contexts', note: 'Accurate steps. Unfamiliar questions are where marks go.' },
  { key: 'quadrant_a', title: 'Ready for harder problems', note: 'Accurate and consistent. Worth stretching.' },
];

function tierFor(pct) {
  if (pct >= 75) return { label: 'Strong', status: 'positive', text: 'text-success' };
  if (pct >= 45) return { label: 'Developing', status: 'caution', text: 'text-warning' };
  return { label: 'Needs Work', status: 'critical', text: 'text-destructive' };
}

function percentOf(value) {
  const n = parseFloat(String(value ?? '').replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.map((part) => part[0]).join('').substring(0, 2).toUpperCase();
  return String(name || '').substring(0, 2).toUpperCase();
}

function Wordmark() {
  return (
    <span className="font-headline text-[22px] font-extrabold leading-none tracking-[-0.03em] text-ink">
      <span className="sr-only">Skyll</span>
      <span aria-hidden="true">skyll<span className="text-coral">.</span></span>
    </span>
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

function splitFailureRate(rate) {
  const match = String(rate || '').match(/^\s*(\d+(?:\.\d+)?)\s*%\s*(.*)$/);
  if (!match) return { value: rate || '', caption: '' };
  return { value: `${match[1]}%`, caption: match[2] };
}

export default function TeacherDashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  
  const initialTab = searchParams.get('tab') || 'overview';
  const resolvedTab = ['segmentation', 'action'].includes(initialTab) ? 'overview' : initialTab;
  const [activeTab, setActiveTab] = useState(resolvedTab);
  
  const [selectedSubject, setSelectedSubject] = useState(searchParams.get('subject') || '');
  const [selectedCohort] = useState(searchParams.get('cohort') || '');
  const [studentSearch, setStudentSearch] = useState(searchParams.get('q') || '');
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [selectedClass, setSelectedClass] = useState(searchParams.get('cls') || '');
  const [selectedExam, setSelectedExam] = useState(searchParams.get('exam') || '');
  const [sortBy, setSortBy] = useState(searchParams.get('sort') || 'name');
  const [performanceFilter, setPerformanceFilter] = useState('');
  const [selectedYear, setSelectedYear] = useState(searchParams.get('year') || '');
  const [selectedExamType, setSelectedExamType] = useState(searchParams.get('type') || '');
  const [dateFrom, setDateFrom] = useState(searchParams.get('from') || '');
  const reportMode = 'summary';
  const [dynamicReports, setDynamicReports] = useState({});

  // NLQ intelligent search
  const [nlqQuery, setNlqQuery] = useState('');
  const [nlqResults, setNlqResults] = useState(null);
  const [nlqFilter, setNlqFilter] = useState(null);
  const [nlqLoading, setNlqLoading] = useState(false);
  const [nlqError, setNlqError] = useState('');

  const runNlq = async (e) => {
    e.preventDefault();
    if (!nlqQuery.trim()) return;
    setNlqLoading(true);
    setNlqError('');
    setNlqResults(null);
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: nlqQuery.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setNlqError(data.error || 'Query failed'); return; }
      setNlqFilter(data.filter);
      setNlqResults(data.results);
    } catch { setNlqError('Network error'); }
    finally { setNlqLoading(false); }
  };

  const updateParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const [_dataVersion, setDataVersion] = useState(0);
  const data = teacherData;
  const academicYears = Array.isArray(data.academic_years) ? data.academic_years : [];
  const rawExamsList = Array.isArray(data.exams) ? data.exams : [];
  // Pre-filter exams by exam type and date before deriving subjects/grades
  const examsList = rawExamsList.filter((e) => {
    if (selectedExamType && e.exam_type !== selectedExamType) return false;
    if (dateFrom && e.exam_date && e.exam_date !== dateFrom) return false;
    return true;
  });
  const schoolSubjects = filterSubjects(examsList.map((e) => e.subject).filter(Boolean));
  const schoolGrades = GRADES.filter((g) => examsList.some((e) => e.grade === g));

  const handleLogout = async () => {
    const path = loginPathForSchool();
    await signOut();
    navigate(path);
  };

  const openStudentReport = (username) => {
    if (!username) return;
    const params = new URLSearchParams();
    if (currentSubject) params.set('subject', currentSubject);
    if (selectedClass) params.set('cls', selectedClass);
    if (activeTab) params.set('tab', activeTab);
    const qs = params.toString();
    window.open(`/student/${username}${qs ? `?${qs}` : ''}`, '_blank', 'noopener,noreferrer');
  };
  
  const availableCohorts = data?.cohort_reports && typeof data.cohort_reports === 'object'
    ? Object.keys(data.cohort_reports).filter((key) => data.cohort_reports[key]?.overview)
    : [];
  // Prefer an explicitly selected graded exam. When Exam is "All", pick a cohort
  // that matches the subject/grade filters instead of always falling back to [0]
  // (which left Summary showing e.g. 12th Physics under English + 10th filters).
  const cohortMatchesFilters = (cohortId) => {
    if (!cohortId) return false;
    const rawExam = rawExamsList.find((e) => (e.source_test_id || e.id) === cohortId);
    
    if (selectedExamType && rawExam?.exam_type !== selectedExamType) return false;
    if (dateFrom && rawExam?.exam_date !== dateFrom) return false;

    const assessment = data.cohort_reports?.[cohortId]?.assessment || {};
    const subject = rawExam?.subject || assessment.subject || '';
    const grade = rawExam?.grade || assessment.grade || '';
    if (selectedSubject && normalizeSubject(subject) !== selectedSubject) return false;
    if (selectedClass && String(grade) !== String(selectedClass)) return false;
    return true;
  };
  const matchingCohorts = availableCohorts.filter(cohortMatchesFilters);
  const sortedCohortsByDate = [...availableCohorts].sort((a, b) => {
    const examA = rawExamsList.find((e) => (e.source_test_id || e.id) === a);
    const examB = rawExamsList.find((e) => (e.source_test_id || e.id) === b);
    const dateA = examA?.exam_date || '';
    const dateB = examB?.exam_date || '';
    return dateB.localeCompare(dateA); // newest first
  });
  const mostRecentCohort = sortedCohortsByDate[0] || '';

  const currentCohort = selectedExam && availableCohorts.includes(selectedExam)
    ? selectedExam
    : (!selectedExam && selectedCohort && matchingCohorts.includes(selectedCohort))
    ? selectedCohort
    : (!selectedSubject && !selectedClass && !selectedExam)
    ? mostRecentCohort
    : (matchingCohorts[0] || '');

  useEffect(() => {
    track('teacher_dashboard_viewed', { surface: 'web_teacher' });
  }, []);

  // A preview from another exam (or year) must not linger beside this cohort.
  useEffect(() => {
    setSelectedStudent(null);
  }, [currentCohort, selectedYear]);

  useEffect(() => {
    if (!currentCohort) return;
    if (Object.prototype.hasOwnProperty.call(dynamicReports, currentCohort)) return;
    const seeded = (data?.student_reports || []).filter((report) => report.test_id === currentCohort);
    if (seeded.length) {
      setDynamicReports((prev) => (
        Object.prototype.hasOwnProperty.call(prev, currentCohort) ? prev : { ...prev, [currentCohort]: seeded }
      ));
      return;
    }

    let active = true;
    fetch(`/api/teacher-dashboard?year=${selectedYear || ''}&exam_id=${encodeURIComponent(currentCohort)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `Could not load roster (${r.status})`);
        return body;
      })
      .then((res) => {
        if (!active) return;
        setDynamicReports((prev) => ({
          ...prev,
          [currentCohort]: Array.isArray(res.studentReports) ? res.studentReports : [],
        }));
      })
      .catch((error) => {
        console.error(error);
        if (!active) return;
        setDynamicReports((prev) => (
          Object.prototype.hasOwnProperty.call(prev, currentCohort) ? prev : { ...prev, [currentCohort]: null }
        ));
      });

    return () => { active = false; };
    // dynamicReports intentionally omitted — we gate on hasOwnProperty inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCohort, data?.student_reports, selectedYear]);

  // Year change invalidates per-exam report cache and reloads base data.
  useEffect(() => {
    setDynamicReports({});
    let active = true;

    (async () => {
      if (!data.username || !active) return;
      const opts = selectedYear && selectedYear !== 'all' ? { year: selectedYear } : {};
      try {
        await loadTeacherData(data.username, opts);
        if (active) setDataVersion(v => v + 1);
      } catch (error) {
        console.error(error);
        if (active) setDataVersion(v => v + 1);
      }
    })();

    return () => { active = false; };
  }, [selectedYear, data.username]);

  if (!data || Object.keys(data).length === 0) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="font-headline text-[21px] font-extrabold text-ink">No cohort data found</h2>
          <Button variant="link" onClick={handleLogout} className="h-auto px-0 text-sm font-semibold">
            Logout and try another account
          </Button>
        </div>
      </div>
    );
  }

  // Handle multiple subjects for admin.
  const availableSubjects = Object.keys(data).filter((key) => {
    return data[key]
      && key !== 'student_reports'
      && key !== 'cohort_report'
      && key !== 'username'
      && key !== 'subject'
      && typeof data[key] === 'object'
      && data[key].overview;
  });
  const selectedCohortSubject = currentCohort ? data.cohort_reports?.[currentCohort]?.assessment?.subject : '';
  const currentSubject = selectedCohortSubject || (availableSubjects.length > 0
    ? (selectedSubject || availableSubjects[0]) 
    : data.subject);
  
  const cohort_report = availableCohorts.length > 0
    ? data.cohort_reports[currentCohort]
    : availableSubjects.length > 0
    ? data[currentSubject] 
    : data.cohort_report;

  if (!cohort_report) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-[15px] text-foreground-secondary">This exam’s cohort report is not available yet.</p>
          <Button type="button" variant="secondary" onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </div>
    );
  }

  const overview = cohort_report.overview || {};
  // Topic objects ({ title, avg }) only: canonical cohorts send systemic_gaps
  // as sentences about student counts, which are not topics.
  const gaps = (Array.isArray(cohort_report.topic_gaps) ? cohort_report.topic_gaps : cohort_report.gaps || cohort_report.systemic_gaps || [])
    .filter((gap) => gap && typeof gap === 'object' && String(gap.title || '').trim());
  const segmentation = cohort_report.segmentation || {};
  const hotspots = cohort_report.exam_hotspots || cohort_report.hotspots || [];
  const interventions = cohort_report.interventions || cohort_report.instructional_intervention_plan || [];
  const immediateInterventions = interventions.filter((item) => item.type === 'immediate' || !item.type);
  const longTermInterventions = interventions.filter((item) => item.type === 'long-term');
  const followThroughInterventions = longTermInterventions.length ? longTermInterventions : interventions.slice(0, 3).map((item) => ({
    ...item,
    title: item.title || item.topic,
    action: `${item.action || item.description || 'Use the intervention consistently.'} Track the next assessment to see whether this gap narrows.`,
  }));
  const allStudentReports = Array.isArray(data.student_reports) ? data.student_reports : [];
  const selectedTestId = cohort_report.assessment?.test_id || '';
  const hasFetchedReports = selectedTestId
    ? Object.prototype.hasOwnProperty.call(dynamicReports, selectedTestId)
    : true;
  const fetchedReports = hasFetchedReports ? (dynamicReports[selectedTestId] || []) : [];
  const studentReports = selectedTestId
    ? (hasFetchedReports
      ? fetchedReports
      : allStudentReports.filter((report) => report.test_id === selectedTestId))
    : allStudentReports;
  const reportsLoading = Boolean(selectedTestId && !hasFetchedReports);
  const rosterLoadFailed = Boolean(selectedTestId && dynamicReports[selectedTestId] === null);
  const classes = [...new Set(studentReports.map((r) => r.student?.class).filter(Boolean))].sort();
  const effectiveClassFilter = validClassFilter(selectedClass, classes);
  const assessmentScope = { testId: selectedTestId, subject: currentSubject };
  const subjectsForSelectedCohort = (report) => subjectsForAssessment(report, assessmentScope);
  const assessmentScoreForReport = (report) => withPercentage(assessmentScore(report, assessmentScope));
  
  const filteredStudents = studentReports.filter((report) => {
    const haystack = `${report.username || ''} ${report.student?.name || ''} ${report.student?.class || ''}`.toLowerCase();
    const matchesSearch = haystack.includes(studentSearch.trim().toLowerCase());
    const matchesClass = !effectiveClassFilter || report.student?.class === effectiveClassFilter;
    const matchesSubject = subjectsForSelectedCohort(report).length > 0;
    const matchesPerformance = !performanceFilter || (() => {
      const { score, total } = assessmentScoreForReport(report);
      if (!total) return false;
      const pct = (score / total) * 100;
      if (performanceFilter === 'strong') return pct >= 75;
      if (performanceFilter === 'developing') return pct >= 45 && pct < 75;
      if (performanceFilter === 'needs-work') return pct < 45;
      return true;
    })();
    return matchesSearch && matchesClass && matchesSubject && matchesPerformance;
  });

  const getStudentScore = (report) => {
    return assessmentScoreForReport(report).score;
  };

  const sortedStudents = [...filteredStudents].sort((a, b) => {
    if (sortBy === 'name') return (a.student?.name || '').localeCompare(b.student?.name || '');
    if (sortBy === 'name-desc') return (b.student?.name || '').localeCompare(a.student?.name || '');
    if (sortBy === 'marks-asc') return getStudentScore(a) - getStudentScore(b);
    if (sortBy === 'marks-desc') return getStudentScore(b) - getStudentScore(a);
    return 0;
  });

  const activeSecondaryFiltersCount = [selectedYear, selectedExamType, dateFrom].filter(Boolean).length;
  const anyFilterActive = Boolean(selectedSubject || selectedClass || selectedExam || selectedYear || selectedExamType || dateFrom);
  const clearFilters = () => {
    setSelectedSubject(''); setSelectedClass(''); setSelectedExam('');
    setSelectedYear(''); setSelectedExamType(''); setDateFrom('');
    setStudentSearch('');
    setSearchParams(new URLSearchParams({ tab: activeTab }), { replace: true });
  };

  const examInfo = examsList.find((e) => (e.source_test_id || e.id) === currentCohort) || examsList.find((e) => e.name === cohort_report.assessment?.title);
  const breadcrumbText = data.school || 'Institute';

  // --- Derived view data (presentation only) ---
  const classScores = studentReports.map((report) => {
    const score = assessmentScoreForReport(report);
    if (!score.total) return null;
    return { name: report.student?.name || report.username, ...score };
  }).filter(Boolean);
  const scoredCount = classScores.length;
  const avgPct = scoredCount > 0 ? Math.round(classScores.reduce((acc, s) => acc + s.pct, 0) / scoredCount) : 0;
  const passedCount = classScores.filter((s) => s.pct >= PASS_PCT).length;
  const topScorer = scoredCount > 0 ? classScores.reduce((best, curr) => (curr.score > best.score ? curr : best)) : null;
  const avgScore = scoredCount > 0 ? Math.round(classScores.reduce((acc, s) => acc + s.score, 0) / scoredCount) : 0;
  const avgMax = scoredCount > 0 ? Math.round(classScores.reduce((acc, s) => acc + s.total, 0) / scoredCount) : 0;

  const topicsWeakestFirst = [...gaps].sort((a, b) => {
    const pa = percentOf(a.avg);
    const pb = percentOf(b.avg);
    if (pa == null && pb == null) return 0;
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pa - pb;
  });
  const weakestTopic = topicsWeakestFirst[0];
  const supportGroups = SUPPORT_GROUPS
    .map((group) => ({ ...group, students: segmentation[group.key] || [] }))
    .filter((group) => group.students.length > 0);

  const pageTitle = cohort_report.assessment?.title || examInfo?.name || 'Class insights';
  const metaParts = [
    `${overview.evaluated_students || studentReports.length || 0} students`,
    normalizeSubject(examInfo?.subject || cohort_report.assessment?.subject || currentSubject || ''),
    examInfo?.grade ? `Grade ${examInfo.grade}` : '',
    formatLongDate(examInfo?.exam_date),
  ].filter(Boolean);

  const toggleNameSort = (next) => { setSortBy(next); updateParam('sort', next); };
  const selectRow = (report) => {
    // On phones there is no side preview panel — open the report directly.
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
      openStudentReport(report.username);
      return;
    }
    setSelectedStudent(report);
  };

  return (
    <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); updateParam('tab', v); }} className="flex min-h-screen flex-col bg-background">
      {rosterLoadFailed && (
        <div role="alert" className="border-b border-destructive/20 bg-destructive-soft px-4 py-2 text-center text-sm font-medium text-destructive">
          Could not load this exam’s student roster. Refresh the page to try again.
        </div>
      )}

      {/* --- Top bar --- */}
      <header className="border-b border-border bg-card pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-16 w-full max-w-[1180px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Wordmark />
            <span className="truncate border-l border-border pl-3 text-[13px] text-foreground-secondary">{breadcrumbText}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => navigate('/teacher-profile')} aria-label="Open teacher profile" className="h-10 gap-1.5 px-3 text-sm">
              <UserCircle className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Profile</span>
            </Button>
            <Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Log out" className="text-foreground-secondary hover:text-foreground">
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 pb-14 pt-7 sm:px-6 sm:pt-9 lg:px-8">
        {/* --- Page header: title, meta, filters, tabs --- */}
        <header className="flex flex-col gap-5">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="font-headline text-[32px] font-extrabold leading-[1.05] tracking-[-0.03em] text-ink [overflow-wrap:anywhere] sm:text-[44px]">{pageTitle}</h1>
            <p className="text-sm text-foreground-secondary">{metaParts.join(' · ')}</p>
          </div>

          {(examsList.length > 0 || rawExamsList.length > 0) && (
            <div className="flex items-center gap-2">
              {/* Scroll only the primary selects — overflow on this row clipped the More filters panel. */}
              <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto no-scrollbar">
                <Select aria-label="Subject" value={selectedSubject} onChange={(e) => { setSelectedSubject(e.target.value); updateParam('subject', e.target.value); }} className={cn(FILTER_SELECT, 'min-w-[7.5rem]')}>
                  <option value="" disabled hidden>Subject</option>
                  {schoolSubjects.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
                <Select aria-label="Grade" value={selectedClass} onChange={(e) => { setSelectedClass(e.target.value); updateParam('cls', e.target.value); }} className={cn(FILTER_SELECT, 'min-w-[7rem]')}>
                  <option value="" disabled hidden>Grade</option>
                  {schoolGrades.map((g) => <option key={g} value={g}>{g}</option>)}
                </Select>
                <Select aria-label="Exam" value={selectedExam} onChange={(e) => { setSelectedExam(e.target.value); updateParam('exam', e.target.value); }} className={cn(FILTER_SELECT, 'min-w-[8rem] max-w-[11rem] truncate sm:max-w-[240px]')}>
                  <option value="" disabled hidden>Exam</option>
                  {examsList
                    .filter((e) => (!selectedSubject || normalizeSubject(e.subject) === selectedSubject) && (!selectedClass || e.grade === selectedClass))
                    .map((e) => <option key={e.id} value={e.source_test_id || e.id}>{e.name}</option>)}
                </Select>
              </div>

              <details className="group relative shrink-0">
                <summary className="flex h-9 cursor-pointer select-none list-none items-center gap-1.5 rounded-[10px] border border-border bg-card px-3 text-sm font-semibold text-foreground hover:border-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="hidden sm:inline">More filters</span>
                  <span className="sm:hidden">More</span>
                  {activeSecondaryFiltersCount > 0 && (
                    <Badge className="h-5 min-w-[1.25rem] justify-center px-1.5 tabular-nums">{activeSecondaryFiltersCount}</Badge>
                  )}
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <div className="absolute right-0 top-full z-50 mt-2 flex min-w-[240px] flex-col gap-4 rounded-2xl border border-ink bg-card p-4">
                  {academicYears.length > 0 && (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] font-semibold text-foreground-secondary">Academic year</span>
                      <Select value={selectedYear} onChange={(e) => { setSelectedYear(e.target.value); updateParam('year', e.target.value); }} className="h-9 text-sm">
                        {academicYears.map((y) => <option key={y.id} value={y.id}>{y.label}{y.is_current ? ' (Current)' : ''}</option>)}
                        <option value="">All Years</option>
                      </Select>
                    </label>
                  )}
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-semibold text-foreground-secondary">Exam type</span>
                    <Select value={selectedExamType} onChange={(e) => { setSelectedExamType(e.target.value); updateParam('type', e.target.value); }} className="h-9 text-sm">
                      <option value="">All Types</option>
                      <option value="mcq">MCQ</option>
                      <option value="subjective">Subjective</option>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-semibold text-foreground-secondary">Date</span>
                    <Select value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); updateParam('from', e.target.value); }} className="h-9 text-sm">
                      <option value="">All Dates</option>
                      {[...new Set(rawExamsList.map((e) => e.exam_date).filter(Boolean))].sort().reverse().map((d) => (
                        <option key={d} value={d}>{new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</option>
                      ))}
                    </Select>
                  </label>
                </div>
              </details>

              {anyFilterActive && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="h-9 shrink-0 gap-1 px-2.5 text-sm text-foreground-secondary hover:text-foreground">
                  <X className="h-4 w-4" aria-hidden="true" /><span className="hidden sm:inline">Clear all</span><span className="sr-only sm:hidden">Clear all filters</span>
                </Button>
              )}
            </div>
          )}

          <TabsList className="h-auto w-full justify-start gap-2 overflow-x-auto border-b-0 bg-transparent no-scrollbar">
            <TabsTrigger value="overview" className={TAB_PILL}>Overview</TabsTrigger>
            <TabsTrigger value="students" className={TAB_PILL}>Students{studentReports.length ? ` · ${studentReports.length}` : ''}</TabsTrigger>
            <TabsTrigger value="hotspots" className={TAB_PILL}>Questions{hotspots.length ? ` · ${hotspots.length}` : ''}</TabsTrigger>
            <TabsTrigger value="ai" className={TAB_PILL}>Teacher AI</TabsTrigger>
          </TabsList>
        </header>

        <div className="mt-6">
          {/* --- Overview --- */}
          <TabsContent value="overview" className="flex flex-col gap-5 outline-none">
            {reportsLoading && studentReports.length === 0 ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader className="text-primary" />
              </div>
            ) : studentReports.length > 0 ? (
              <section aria-label="Summary" className="grid items-center gap-7 rounded-[20px] bg-ink px-5 py-7 text-white sm:px-9 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
                <p className="font-headline text-[21px] font-bold leading-[1.3] tracking-[-0.01em] sm:text-[26px]">
                  {scoredCount > 0
                    ? <>{scoredCount} student{scoredCount === 1 ? '' : 's'} averaged {avgPct}%, and {passedCount} passed. </>
                    : <>Scores for this exam are still coming in. </>}
                  {weakestTopic ? (
                    <>
                      <span className="rounded px-1.5 text-ink [box-decoration-break:clone] bg-lime">{weakestTopic.title}</span>
                      {' '}is the topic to reteach first{percentOf(weakestTopic.avg) != null ? `, with a class average of ${Math.round(percentOf(weakestTopic.avg))}%.` : '.'}
                    </>
                  ) : 'No single topic stands out as a gap.'}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <InkStat label="Class average" value={scoredCount > 0 ? `${avgPct}%` : '—'} hint={scoredCount > 0 ? `${avgScore}/${avgMax} marks on average` : null} />
                  <InkStat label="Passed" value={scoredCount > 0 ? `${passedCount}/${scoredCount}` : '—'} hint={`Pass mark ${PASS_PCT}%`} />
                  {topScorer && (
                    <div className="col-span-2 flex items-baseline justify-between gap-3 rounded-xl border border-white/20 px-3.5 py-3">
                      <span className="text-[13px] text-white/70">Top score</span>
                      <span className="min-w-0 truncate text-right text-sm font-semibold">
                        <span className="tabular-nums">{topScorer.score}/{topScorer.total}</span>
                        <span className="text-white/70"> · {topScorer.name}</span>
                      </span>
                    </div>
                  )}
                </div>
              </section>
            ) : (
              <Card>
                <EmptyState icon={Search} title="No cohort data">No student reports are available for this view yet.</EmptyState>
              </Card>
            )}

            <div className="grid items-start gap-5 lg:grid-cols-2">
              {sortedStudents.length > 0 && (
                <Card role="region" aria-labelledby="dist-heading" className="flex flex-col gap-4 p-5 sm:p-6">
                  <SectionHeading id="dist-heading" title="How scores spread" description="Students in each score band" />
                  <ScoreDistributionChart students={sortedStudents} />
                </Card>
              )}

              <Card role="region" aria-labelledby="topics-heading" className="flex flex-col gap-4 p-5 sm:p-6">
                <SectionHeading id="topics-heading" title="Topics, weakest first" description="Class average on each priority topic" />
                {topicsWeakestFirst.length > 0 ? (
                  <ul className="flex flex-col gap-5">
                    {topicsWeakestFirst.map((g, i) => {
                      const value = percentOf(g.avg);
                      return (
                        <li key={`${g.title}-${i}`} className="flex flex-col gap-2">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="min-w-0 text-[15px] font-bold text-ink">{g.title}</span>
                            {value != null && <span className="shrink-0 font-headline text-lg font-extrabold tabular-nums text-ink">{Math.round(value)}%</span>}
                          </div>
                          {value != null && <RangeBar value={value} label={`${g.title}: class average ${Math.round(value)}%`} />}
                          {i === 0 && <StatusBadge status="caution" className="self-start">Reteach first</StatusBadge>}
                          {g.description && <p className="text-[13px] leading-relaxed text-foreground-secondary">{g.description}</p>}
                        </li>
                      );
                    })}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">No priority gaps identified.</p>}
              </Card>

              <Card role="region" aria-labelledby="support-heading" className="flex flex-col gap-4 p-5 sm:p-6">
                <SectionHeading id="support-heading" title="Who needs what next" description="Grouped by the help they need, never by a label" />
                {supportGroups.length > 0 ? (
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
                ) : <p className="text-sm text-muted-foreground">Groups appear once the class report has enough graded answers.</p>}
              </Card>

              {hotspots.length > 0 && (
                <Card role="region" aria-labelledby="costly-heading" className="flex flex-col gap-2 p-5 sm:p-6">
                  <SectionHeading id="costly-heading" title="Questions that cost the most" description="With the mistake most students made" />
                  <ul className="flex flex-col">
                    {hotspots.slice(0, 3).map((h, i) => {
                      const rate = splitFailureRate(h.failure_rate);
                      return (
                        <li key={`${h.id || i}`} className="grid grid-cols-[40px_minmax(0,1fr)_auto] gap-3 border-b border-border py-3 last:border-b-0">
                          <span className="font-headline text-[15px] font-extrabold text-ink">{h.id || `Q${i + 1}`}</span>
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-[15px] font-semibold text-ink"><Suspense fallback={h.title}><MathText text={h.title} stripJargon={false} /></Suspense></span>
                            {h.why && <span className="text-sm text-foreground-secondary">{h.why}</span>}
                          </span>
                          <span className="flex flex-col items-end">
                            <span className="font-headline text-lg font-extrabold tabular-nums text-ink">{rate.value}</span>
                            {rate.caption && <span className="max-w-[6rem] text-right text-[12px] leading-tight text-muted-foreground">{rate.caption}</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <Button variant="link" className="h-auto self-start px-0 py-1 text-sm font-bold" onClick={() => { setActiveTab('hotspots'); updateParam('tab', 'hotspots'); }}>
                    See all {hotspots.length} question{hotspots.length === 1 ? '' : 's'} with fixes
                  </Button>
                </Card>
              )}
            </div>

            <Card role="region" aria-labelledby="interventions-heading" className="flex flex-col gap-4 p-5 sm:p-6">
              <SectionHeading id="interventions-heading" title="Recommended interventions" description="What to change in the next few lessons" />
              {interventions.length > 0 ? (
                <ol className="grid gap-3 md:grid-cols-3">
                  {interventions.slice(0, 3).map((inv, i) => (
                    <li key={i} className="flex flex-col gap-1.5 rounded-xl border border-border p-4">
                      <span className="text-[12px] font-bold tabular-nums text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                      <p className="text-[15px] font-bold text-ink">{inv.title || inv.topic}</p>
                      <p className="text-sm leading-relaxed text-foreground-secondary">{inv.action || inv.description}</p>
                    </li>
                  ))}
                </ol>
              ) : <p className="text-sm text-muted-foreground">No interventions recommended.</p>}
            </Card>
          </TabsContent>

          {/* --- Students --- */}
          <TabsContent value="students" className="outline-none">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
              <Card className="flex min-w-0 flex-col overflow-hidden">
                <div className="flex flex-col gap-3 border-b border-border p-4">
                  <details className="group sm:hidden">
                    <summary className="flex min-h-11 cursor-pointer select-none list-none items-center gap-2 text-sm font-semibold text-foreground">
                      <span className="rounded-full bg-ink px-2 py-0.5 text-[12px] font-bold leading-none text-lime">AI</span>
                      Ask AI about the class
                      <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
                    </summary>
                    <form onSubmit={runNlq} className="relative mt-2 flex items-center">
                      <Input
                        aria-label="Ask AI about the class"
                        value={nlqQuery} onChange={(e) => setNlqQuery(e.target.value)}
                        placeholder="e.g. students below 50% in Maths"
                        className="pr-20"
                      />
                      <Button type="submit" variant="ink" disabled={nlqLoading} size="sm" className="absolute right-1 top-1 h-8">
                        {nlqLoading ? '...' : 'Search'}
                      </Button>
                    </form>
                  </details>
                  <form onSubmit={runNlq} className="relative hidden items-center sm:flex">
                    <Sparkles className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                    <Input
                      aria-label="Ask AI about the class"
                      value={nlqQuery} onChange={(e) => setNlqQuery(e.target.value)}
                      placeholder="Ask anything... (e.g. 'Aditi Sharma 9th Maths last week')"
                      className="pl-9 pr-24"
                    />
                    <Button type="submit" variant="ink" disabled={nlqLoading} size="sm" className="absolute right-1 top-1 h-8">
                      {nlqLoading ? '...' : 'Search'}
                    </Button>
                  </form>
                  {nlqError && <p role="alert" className="text-sm text-destructive">{nlqError}</p>}
                  {nlqFilter && Object.keys(nlqFilter).length > 0 && (
                    <p className="text-[13px] text-foreground-secondary">
                      Interpreted: {Object.entries(nlqFilter).map(([k, v]) => `${k}=${v}`).join(', ')}
                    </p>
                  )}
                  {nlqResults && (
                    <div className="flex items-center justify-between gap-2 rounded-[10px] bg-sunken px-3 py-2 text-sm">
                      <span>Found {nlqResults.length} matches via AI</span>
                      <Button variant="ghost" size="sm" onClick={() => { setNlqResults(null); setNlqQuery(''); setNlqFilter(null); }} className="h-8 px-2 text-sm">Clear AI search</Button>
                    </div>
                  )}

                  <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                    <div className="relative w-full sm:min-w-[200px] sm:flex-1">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                      <Input
                        aria-label="Search students"
                        value={studentSearch}
                        onChange={(e) => { setStudentSearch(e.target.value); updateParam('q', e.target.value); }}
                        placeholder="Search by name or roll number"
                        className="pl-9"
                      />
                    </div>
                    <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 no-scrollbar" role="group" aria-label="Filter by performance">
                      {['all', 'strong', 'developing', 'needs-work'].map((tier) => {
                        const isActive = performanceFilter === (tier === 'all' ? '' : tier);
                        const labels = { all: 'All', strong: 'Strong', developing: 'Developing', 'needs-work': 'Needs Work' };
                        return (
                          <button
                            key={tier}
                            type="button"
                            aria-pressed={isActive}
                            onClick={() => setPerformanceFilter(tier === 'all' ? '' : tier)}
                            className={cn(
                              'h-9 whitespace-nowrap rounded-full border px-3.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              isActive ? 'border-ink bg-ink text-lime' : 'border-border bg-card text-foreground hover:border-hairline-strong',
                            )}
                          >
                            {labels[tier]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="flex-1 md:max-h-[calc(100vh-280px)] md:overflow-y-auto">
                  {/* Mobile-only sort strip — hidden on md+ where the table header handles it */}
                  {!nlqResults && (
                    <div className="flex items-center gap-1 border-b border-border px-4 py-1.5 text-[13px] text-foreground-secondary md:hidden">
                      <span className="mr-1 font-semibold">Sort</span>
                      <button type="button" onClick={() => toggleNameSort(sortBy === 'name' ? 'name-desc' : 'name')} className="flex min-h-9 items-center gap-1 rounded-lg px-2 hover:text-foreground">
                        Name {sortBy === 'name' ? <ArrowUp className="h-3.5 w-3.5" /> : sortBy === 'name-desc' ? <ArrowDown className="h-3.5 w-3.5" /> : null}
                      </button>
                      <button type="button" onClick={() => toggleNameSort(sortBy === 'marks-desc' ? 'marks-asc' : 'marks-desc')} className="flex min-h-9 items-center gap-1 rounded-lg px-2 hover:text-foreground">
                        Score {sortBy === 'marks-desc' ? <ArrowDown className="h-3.5 w-3.5" /> : sortBy === 'marks-asc' ? <ArrowUp className="h-3.5 w-3.5" /> : null}
                      </button>
                    </div>
                  )}

                  {nlqResults ? (
                    <div className="w-full overflow-x-auto">
                      {nlqResults.length === 0 ? (
                        <EmptyState icon={Search} title="No matching results">Try adjusting your AI search query.</EmptyState>
                      ) : (
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 z-10 bg-card">
                            <tr className="border-b border-border text-left text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                              <th className="px-4 py-2.5 font-semibold">Student</th>
                              <th className="px-4 py-2.5 font-semibold">Exam</th>
                              <th className="px-4 py-2.5 font-semibold">Subject</th>
                              <th className="px-4 py-2.5 font-semibold">Date</th>
                              <th className="px-4 py-2.5 text-right font-semibold">Score</th>
                            </tr>
                          </thead>
                          <tbody>
                            {nlqResults.map((r, i) => (
                              <tr key={i} className="border-b border-border last:border-b-0 hover:bg-paper-soft">
                                <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-ink">{r.studentName}</td>
                                <td className="whitespace-nowrap px-4 py-2.5 text-foreground-secondary">{r.examName}</td>
                                <td className="px-4 py-2.5 text-foreground-secondary">{r.subject}</td>
                                <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-foreground-secondary">{r.examDate || '-'}</td>
                                <td className={cn('px-4 py-2.5 text-right font-semibold tabular-nums', r.pct != null ? tierFor(r.pct).text : 'text-ink')}>
                                  {r.pct != null ? `${r.pct}%` : r.score != null ? `${r.score}/${r.maxMarks}` : '-'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ) : (
                    <div className="w-full">
                      {sortedStudents.length > 0 && (
                        <div className="sticky top-0 z-10 hidden items-center border-b border-border bg-card px-5 py-2.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground md:flex">
                          <button
                            type="button"
                            onClick={() => toggleNameSort(sortBy === 'name' ? 'name-desc' : sortBy === 'name-desc' ? '' : 'name')}
                            className="flex min-w-0 flex-[2] items-center gap-1 text-left uppercase hover:text-foreground"
                          >
                            Student
                            {sortBy === 'name' ? <ArrowUp className="h-3 w-3" /> : sortBy === 'name-desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-50" />}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleNameSort(sortBy === 'marks-desc' ? 'marks-asc' : 'marks-desc')}
                            className="flex min-w-0 flex-1 items-center gap-1 text-left uppercase hover:text-foreground"
                          >
                            Score
                            {sortBy === 'marks-desc' ? <ArrowDown className="h-3 w-3" /> : sortBy === 'marks-asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-50" />}
                          </button>
                          <div className="min-w-0 flex-1">Status</div>
                          <div className="w-10 shrink-0 text-center">Report</div>
                        </div>
                      )}

                      {sortedStudents.map((report, idx) => {
                        const username = report.username;
                        const name = report.student?.name || report.username;
                        const cls = report.student?.class || '-';
                        const isSelected = selectedStudent?.username === username;

                        let scoreText = '-';
                        let pct = 0;
                        const { score, total } = assessmentScoreForReport(report);
                        if (total) { scoreText = score; pct = (score / total) * 100; }
                        const tier = tierFor(pct);

                        return (
                          <div
                            key={idx}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isSelected}
                            onClick={() => selectRow(report)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRow(report); } }}
                            className={cn(
                              'flex cursor-pointer items-center gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-5',
                              isSelected && 'bg-paper-soft shadow-[inset_3px_0_0_var(--ink)]',
                            )}
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-3 md:flex-[2]">
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-bold text-foreground-secondary" aria-hidden="true">
                                {initialsOf(name)}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-[15px] font-semibold text-ink">{name}</p>
                                <p className="truncate text-[13px] text-foreground-secondary">{cls}</p>
                                <div className="mt-1 flex items-center gap-2 md:hidden">
                                  <span className="text-sm font-bold tabular-nums text-ink">{scoreText}{total ? ` / ${total}` : ''}</span>
                                  <StatusBadge status={tier.status}>{tier.label}</StatusBadge>
                                </div>
                              </div>
                            </div>

                            <div className="hidden min-w-0 flex-1 items-baseline gap-1 pr-4 md:flex">
                              <span className="font-headline text-lg font-extrabold tabular-nums text-ink">{scoreText}</span>
                              {total ? <span className="text-sm tabular-nums text-muted-foreground">/ {total}</span> : null}
                            </div>

                            <div className="hidden min-w-0 flex-1 items-center pr-4 md:flex">
                              <StatusBadge status={tier.status}>{tier.label}</StatusBadge>
                            </div>

                            <div className="flex w-10 shrink-0 items-center justify-end">
                              <button
                                type="button"
                                className="flex h-9 w-9 items-center justify-center rounded-full border border-border text-foreground-secondary transition-colors hover:border-ink hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={(e) => { e.stopPropagation(); openStudentReport(username); }}
                                aria-label={`Open report for ${name}`}
                              >
                                <ArrowRight className="h-4 w-4" aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {reportsLoading ? (
                    <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
                      <Loader size="inline" className="text-primary" />
                      Loading students…
                    </div>
                  ) : !(nlqResults || sortedStudents).length ? (
                    <EmptyState icon={Search} title="No matching students">Try adjusting your search or filters.</EmptyState>
                  ) : null}
                </div>
              </Card>

              <div className="hidden flex-col gap-5 lg:flex">
                <StudentReportPreview report={selectedStudent || (!nlqResults && sortedStudents[0])} mode={reportMode} onOpenReport={openStudentReport} />
                <ClassHivePanel className={selectedClass} />
              </div>
            </div>
          </TabsContent>

          {/* --- Questions (hotspots & actions) --- */}
          <TabsContent value="hotspots" className="flex flex-col gap-5 outline-none">
            <SectionHeading title="Questions that cost the most" description="Each question with the common mistake, what it means for teaching, and a next step." />

            {hotspots.length === 0 ? (
              <Card>
                <EmptyState icon={Search} title="No question analysis yet">Hotspots appear once grading data is available.</EmptyState>
              </Card>
            ) : (
              <ul className="flex flex-col gap-3">
                {hotspots.map((h, i) => {
                  const intervention = immediateInterventions[i % immediateInterventions.length] || {};
                  const rate = splitFailureRate(h.failure_rate);
                  return (
                    <li key={i}>
                      <Card className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 gap-y-3 p-5 sm:grid-cols-[48px_minmax(0,1fr)_auto] sm:p-6">
                        <span className="font-headline text-lg font-extrabold text-ink">{h.id || `Q${i + 1}`}</span>
                        <h3 className="min-w-0 self-center text-[16px] font-bold leading-snug text-ink"><Suspense fallback={h.title}><MathText text={h.title} stripJargon={false} /></Suspense></h3>
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
                              <span className="font-semibold">{intervention.title || 'Review Topic'}</span>
                              <span className="text-foreground-secondary"> · {intervention.action || 'Follow through with targeted practice.'}</span>
                            </dd>
                          </div>
                        </dl>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}

            {followThroughInterventions.length > 0 && (
              <section aria-labelledby="longterm-heading" className="mt-3 flex flex-col gap-3">
                <SectionHeading id="longterm-heading" title="Long-term teaching shifts" description="Habits to build over the coming weeks" />
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {followThroughInterventions.map((inv, i) => (
                    <Card key={i} className="flex flex-col gap-1.5 p-4">
                      <p className="text-[15px] font-bold text-ink">{inv.title}</p>
                      <p className="text-sm leading-relaxed text-foreground-secondary">{inv.action || inv.description}</p>
                    </Card>
                  ))}
                </div>
              </section>
            )}
          </TabsContent>

          {/* --- Teacher AI --- */}
          <TabsContent value="ai" className="outline-none">
            <div className="mx-auto max-w-3xl">
              <TeacherAiPanel
                className={selectedClass}
                subject={selectedSubject || currentSubject || ''}
                examId={currentCohort || selectedExam || ''}
                username={selectedStudent?.username || ''}
                studentName={selectedStudent?.student?.name || selectedStudent?.studentName || ''}
              />
            </div>
          </TabsContent>
        </div>
      </main>
    </Tabs>
  );
}

function ScoreDistributionChart({ students }) {
  const scores = students.map((s) => {
    const subs = s.term1?.subjects || [];
    if (subs.length === 0) return 0;
    const total = subs.reduce((acc, sub) => acc + (sub.score || 0), 0);
    const max = subs.reduce((acc, sub) => acc + (sub.total || 0), 0);
    return max > 0 ? Math.round((total / max) * 100) : 0;
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

  return <DistributionBars data={data} />;
}

function DistributionBars({ data }) {
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

function StudentReportPreview({ report, mode, onOpenReport }) {
  const [masteryRows, setMasteryRows] = useState([]);
  const [masteryLoading, setMasteryLoading] = useState(true);
  const drillUsername = report?.username || '';

  const [trackedUsername, setTrackedUsername] = useState(drillUsername);
  if (trackedUsername !== drillUsername) {
    setTrackedUsername(drillUsername);
    setMasteryRows([]);
    setMasteryLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!drillUsername) { setMasteryRows([]); setMasteryLoading(false); return; }
      setMasteryLoading(true);
      try {
        const data = await getMastery({ username: drillUsername });
        if (!cancelled) setMasteryRows(normalizeMasteryRows(data.mastery));
      } catch {
        if (!cancelled) setMasteryRows([]);
      } finally {
        if (!cancelled) setMasteryLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [drillUsername]);

  if (!report) {
    return <Card className="p-5"><p className="text-sm text-muted-foreground">Select a student to view report details.</p></Card>;
  }

  const subjects = report.term1?.subjects || [];
  const isDetailed = mode === 'detailed';

  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3 p-5 pb-4">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">Selected student</p>
          <h3 className="mt-1 truncate font-headline text-[21px] font-extrabold leading-tight text-ink">{report.student?.name || report.username}</h3>
          <p className="mt-0.5 truncate text-[13px] text-foreground-secondary">{report.student?.class || '-'} · {report.public_username || report.username}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onOpenReport?.(report.username)} className="shrink-0 text-[13px]">
          Show Full Report
        </Button>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-3">
          {subjects.map((subject) => {
            const pct = subject.total > 0 ? Math.round((subject.score / subject.total) * 100) : 0;
            const lp = subject.learning_profile || {};
            const tier = tierFor(pct);

            return (
              <div key={subject.id || subject.name} className="rounded-xl border border-border p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p className="text-[15px] font-bold text-ink">{subject.name}</p>
                  <div className="flex items-center gap-2">
                    <span className="font-headline text-base font-extrabold tabular-nums text-ink">{subject.score}/{subject.total}</span>
                    <StatusBadge status={tier.status} className="tabular-nums">{pct}%</StatusBadge>
                  </div>
                </div>
                {!isDetailed && (
                  <div className="flex flex-col gap-3">
                    {lp.core_strength && (
                      <div>
                        <p className="text-[12px] font-semibold text-success">Strength</p>
                        <p className="mt-0.5 truncate text-[13px] leading-relaxed text-foreground">{lp.core_strength}</p>
                      </div>
                    )}
                    {lp.strategies?.[0] && (
                      <div className="border-t border-border pt-3">
                        <p className="text-[12px] font-semibold text-muted-foreground">Next step</p>
                        <p className="mt-0.5 text-[13px] font-semibold text-ink">{lp.strategies[0].topic || lp.strategies[0].title}</p>
                        <p className="mt-0.5 truncate text-[13px] leading-relaxed text-foreground-secondary">{lp.strategies[0].strategy || lp.strategies[0].action}</p>
                      </div>
                    )}
                  </div>
                )}
                {isDetailed && subject.questions?.length > 0 && (
                  <div className="mt-2 rounded-lg border border-border p-3">
                    <p className="mb-2 text-[12px] font-semibold text-muted-foreground">Questions</p>
                    <div className="flex flex-col gap-2">
                      {subject.questions.map((q, qi) => (
                        <div key={qi} className="text-[13px]">
                          <div className="mb-0.5 flex items-center gap-2">
                            <span className="font-semibold text-ink">{q.number}</span>
                            <span className={cn('font-semibold tabular-nums', q.marks_obtained >= q.marks_total ? 'text-success' : 'text-destructive')}>
                              {q.marks_obtained}/{q.marks_total}
                            </span>
                          </div>
                          {q.student_answer && <p className="truncate text-foreground-secondary">Answer: {q.student_answer}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <MasteryPanel rows={masteryRows} loading={masteryLoading} />

        {subjects.map((subject) => {
          const lp = subject.learning_profile || {};
          if (!lp.pattern_recognition && !lp.root_cause_analysis) return null;
          return (
            <div key={`pattern-${subject.id || subject.name}`} className="rounded-xl bg-paper-soft p-4">
              <p className="mb-1 text-[12px] font-semibold text-muted-foreground">Learning pattern · {subject.name}</p>
              <div className="text-[13px] leading-relaxed text-foreground"><Suspense fallback={null}><MathText text={lp.pattern_recognition || lp.root_cause_analysis} block /></Suspense></div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
