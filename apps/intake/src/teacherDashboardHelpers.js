export function normalizeSubject(raw) {
  if (!raw) return '';
  const cleaned = String(raw).trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';
  const aliases = {
    maths: 'Mathematics',
    math: 'Mathematics',
    mathematics: 'Mathematics',
    physics: 'Physics',
    chemistry: 'Chemistry',
    chem: 'Chemistry',
    biology: 'Biology',
    bio: 'Biology',
    science: 'Science',
    accounts: 'Accounts',
    accountancy: 'Accounts',
    english: 'English',
    'english language': 'English',
    'eng language': 'English',
    eng: 'English',
    hindi: 'Hindi',
    german: 'German',
    deutsch: 'German',
    'german language': 'German',
    history: 'History',
    hist: 'History',
    civics: 'History',
    'history and civics': 'History',
    'history & civics': 'History',
    'history civics': 'History',
    'history/civics': 'History',
    geography: 'Geography',
    geo: 'Geography',
  };
  const lower = cleaned.toLowerCase();
  if (aliases[lower]) return aliases[lower];

  const setMatch = cleaned.match(/^(.*?)\s+set\s+[A-Za-z0-9]+$/i);
  const base = (setMatch ? setMatch[1] : cleaned).trim();
  const baseLower = base.toLowerCase();
  if (aliases[baseLower]) return aliases[baseLower];

  const subjects = ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'Science', 'Accounts', 'English', 'Hindi', 'German', 'History', 'Geography'];
  const exact = subjects.find(s => s.toLowerCase() === baseLower);
  return exact || base;
}

export function deriveDefaultSelections(data) {
  const academicYears = data?.academic_years || [];
  const exams = data?.exams || [];
  const defaultYearObj = academicYears.find(y => y.is_current) || academicYears[0];
  const defaultYear = defaultYearObj?.id || '';

  let filteredExams = exams;
  if (defaultYear && defaultYear !== 'all') {
    filteredExams = exams.filter(e => {
      if (e.academic_year_id && String(e.academic_year_id) === String(defaultYear)) return true;
      if (defaultYearObj && e.academic_year && String(e.academic_year) === String(defaultYearObj.label)) return true;
      if (String(e.academic_year_id || e.academic_year || '') === String(defaultYear)) return true;
      return false;
    });
  }
  const defaultExam = filteredExams[0];
  const defaultExamId = defaultExam ? (defaultExam.source_test_id || defaultExam.id) : '';
  return { defaultYear, defaultExamId };
}

export function resetSelections(exams, current, academicYears = []) {
  let { year, subject, grade, examType, examDate, examId } = current;
  const examsList = exams || [];

  // Filter exams by year
  let yearExams = examsList;
  if (year && year !== 'all') {
    const selectedYearObj = academicYears.find(y => String(y.id) === String(year));
    yearExams = examsList.filter(e => {
      if (e.academic_year_id && String(e.academic_year_id) === String(year)) return true;
      if (selectedYearObj && e.academic_year && String(e.academic_year) === String(selectedYearObj.label)) return true;
      if (String(e.academic_year_id || e.academic_year || '') === String(year)) return true;
      return false;
    });
  }

  // 1. Subject filter
  if (subject) {
    const hasSubject = yearExams.some(e => normalizeSubject(e.subject) === subject);
    if (!hasSubject) subject = '';
  }
  let filtered = yearExams;
  if (subject) {
    filtered = filtered.filter(e => normalizeSubject(e.subject) === subject);
  }

  // 2. Grade filter
  if (grade) {
    const hasGrade = filtered.some(e => e.grade === grade);
    if (!hasGrade) grade = '';
  }
  if (grade) {
    filtered = filtered.filter(e => e.grade === grade);
  }

  // 3. Exam Type filter
  if (examType) {
    const hasType = filtered.some(e => e.exam_type === examType);
    if (!hasType) examType = '';
  }
  if (examType) {
    filtered = filtered.filter(e => e.exam_type === examType);
  }

  // 4. Exam Date filter
  if (examDate) {
    const hasDate = filtered.some(e => e.exam_date === examDate);
    if (!hasDate) examDate = '';
  }
  if (examDate) {
    filtered = filtered.filter(e => e.exam_date === examDate);
  }

  // 5. Exam ID
  const validExamIds = filtered.map(e => e.source_test_id || e.id);
  if (!examId || !validExamIds.includes(examId)) {
    examId = validExamIds[0] || '';
  }

  return { year, subject, grade, examType, examDate, examId };
}

export function subjectsForAssessment(report, testId, subject) {
  const subjects = report?.term1?.subjects || report?.subjects || [];
  if (testId) return subjects;
  if (!subject) return subjects;
  return subjects.filter(entry => normalizeSubject(entry.name) === normalizeSubject(subject));
}

export function getReportScore(report, testId, subject) {
  const subjects = subjectsForAssessment(report, testId, subject);
  let score = 0;
  let total = 0;
  for (const sub of subjects) {
    score += Number(sub.score) || 0;
    total += Number(sub.total) || 0;
  }
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  return { score, total, pct };
}

export function calculateKPIs(studentReports, testId, subject) {
  const scored = (studentReports || [])
    .map(report => {
      const score = getReportScore(report, testId, subject);
      if (!score.total) return null;
      return {
        name: report.student?.name || report.username || '',
        score: score.score,
        total: score.total,
        pct: score.pct
      };
    })
    .filter(Boolean);

  const count = scored.length;
  const avgPct = count > 0 ? Math.round(scored.reduce((acc, s) => acc + s.pct, 0) / count) : 0;
  const passRate = count > 0 ? Math.round(scored.filter(s => s.pct >= 35).length / count * 100) : 0;
  const topScorer = count > 0 ? scored.reduce((best, curr) => curr.score > best.score ? curr : best) : null;

  return {
    evaluatedStudents: count,
    averagePercentage: avgPct,
    passRate,
    topScorer: topScorer ? { name: topScorer.name, score: topScorer.score, total: topScorer.total } : null
  };
}

export function calculateScoreDistribution(studentReports, testId, subject) {
  const scores = (studentReports || [])
    .map(report => {
      const score = getReportScore(report, testId, subject);
      if (!score.total) return null;
      return score.pct;
    })
    .filter(val => val !== null);

  const buckets = [
    { label: '0–20%', min: 0, max: 20 },
    { label: '21–40%', min: 21, max: 40 },
    { label: '41–60%', min: 41, max: 60 },
    { label: '61–80%', min: 61, max: 80 },
    { label: '81–100%', min: 81, max: 100 },
  ];

  return buckets.map(b => ({
    name: b.label,
    count: scores.filter(s => s >= b.min && s <= b.max).length,
  }));
}

export function sortStudents(studentReports, sortBy, testId, subject) {
  const reports = [...(studentReports || [])];
  return reports.sort((a, b) => {
    if (sortBy === 'name') {
      const nameA = a.student?.name || a.username || '';
      const nameB = b.student?.name || b.username || '';
      return nameA.localeCompare(nameB);
    }
    const scoreA = getReportScore(a, testId, subject).score;
    const scoreB = getReportScore(b, testId, subject).score;
    if (sortBy === 'marks-asc') return scoreA - scoreB;
    if (sortBy === 'marks-desc') return scoreB - scoreA;
    return 0;
  });
}

export function filterStudents(studentReports, testId, subject, filters) {
  const { query, classFilter, performanceFilter } = filters;
  const normalizedClassFilter = classFilter ? classFilter.trim().toLowerCase() : '';
  const searchVal = query ? query.trim().toLowerCase() : '';

  return (studentReports || []).filter(report => {
    if (searchVal) {
      const haystack = `${report.username || ''} ${report.student?.name || ''} ${report.student?.class || ''}`.toLowerCase();
      if (!haystack.includes(searchVal)) return false;
    }

    if (normalizedClassFilter) {
      const cls = (report.student?.class || '').toLowerCase();
      if (cls !== normalizedClassFilter) return false;
    }

    const subjects = subjectsForAssessment(report, testId, subject);
    if (!subjects || subjects.length === 0) return false;

    if (performanceFilter) {
      const { total, pct } = getReportScore(report, testId, subject);
      if (!total) return false;
      if (performanceFilter === 'strong' && pct < 75) return false;
      if (performanceFilter === 'developing' && (pct < 45 || pct >= 75)) return false;
      if (performanceFilter === 'needs-work' && pct >= 45) return false;
    }

    return true;
  });
}
