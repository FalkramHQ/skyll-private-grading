const SORTS = new Set(['newest', 'oldest', 'performance']);

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
const asText = (value) => String(value ?? '').trim();

export function normalizeExamMetadata(exam = {}, subject = {}, student = {}) {
  const date = asText(firstValue(exam.date, exam.assessment_date, exam.exam_date, exam.published_at));
  return {
    id: asText(firstValue(exam.id, exam.test_id, exam.exam_id)),
    name: asText(firstValue(exam.name, exam.title, exam.display_name, exam.id, 'Assessment')),
    date,
    academicYear: asText(firstValue(exam.academic_year, exam.academicYear, exam.year)),
    subject: asText(firstValue(subject.name, subject.subject, exam.subject)),
    grade: asText(firstValue(exam.grade, exam.class, student.class)),
    examType: asText(firstValue(exam.exam_type, exam.examType, exam.type)),
  };
}

export function buildExamEntries(exams = [], getExamData = () => null, student = {}) {
  return exams.flatMap((exam) => {
    const data = getExamData(exam.id);
    return (data?.subjects || []).map((subject) => {
      const meta = normalizeExamMetadata(exam, subject, student);
      return {
        ...subject,
        _exam: meta,
        _examId: exam.id,
        _examName: meta.name,
      };
    });
  }).filter((entry) => entry._exam.id);
}

export function filterAndSortExamEntries(entries, filters = {}, sort = 'newest') {
  const safeSort = SORTS.has(sort) ? sort : 'newest';
  const result = entries.filter((entry) => {
    const exam = entry._exam;
    return (!filters.year || exam.academicYear === filters.year)
      && (!filters.subject || exam.subject === filters.subject)
      && (!filters.grade || exam.grade === filters.grade)
      && (!filters.type || exam.examType === filters.type)
      && (!filters.exam || exam.id === filters.exam)
      && (!filters.dateFrom || exam.date >= filters.dateFrom)
      && (!filters.dateTo || exam.date <= filters.dateTo);
  });
  return [...result].sort((a, b) => {
    if (safeSort === 'performance') return Number(b.pct || 0) - Number(a.pct || 0);
    const dateCompare = String(b._exam.date).localeCompare(String(a._exam.date));
    return safeSort === 'oldest' ? -dateCompare : dateCompare;
  });
}

export function readExamFilterState(searchParams) {
  const get = (name) => searchParams.get(name) || '';
  return {
    year: get('examYear'), subject: get('examSubject'), grade: get('examGrade'), type: get('examType'),
    exam: get('examId'), dateFrom: get('examFrom'), dateTo: get('examTo'), sort: SORTS.has(get('examSort')) ? get('examSort') : 'newest',
  };
}

export function writeExamFilterState(searchParams, state) {
  const params = new URLSearchParams(searchParams);
  const fields = { examYear: state.year, examSubject: state.subject, examGrade: state.grade, examType: state.type, examId: state.exam, examFrom: state.dateFrom, examTo: state.dateTo };
  Object.entries(fields).forEach(([key, value]) => (value ? params.set(key, value) : params.delete(key)));
  if (state.sort && state.sort !== 'newest') params.set('examSort', state.sort); else params.delete('examSort');
  return params;
}

export const examFilterSortOptions = [
  ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['performance', 'Best performance'],
];
