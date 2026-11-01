import { getStudentContext, getTeacherDashboard } from '../lib/db';

let _cachedStudentData = null;
let _cachedTeacherData = null;
// Monotonic ticket so that only the most recently requested year's response may
// write to the shared teacher cache. Without this, two in-flight fetches for
// different years can race and the slower (stale) one wins, overwriting the
// cache with a year the user has already navigated away from.
let _teacherRequestSeq = 0;
let _studentRequestSeq = 0;

export const loadStudentData = async (username) => {
  if (_cachedStudentData && _cachedStudentData.username === username) return _cachedStudentData;
  const seq = ++_studentRequestSeq;
  const { report, classRanks } = await getStudentContext(username);
  if (seq !== _studentRequestSeq) return _cachedStudentData;
  _cachedStudentData = report ? { ...report, username, classRanks } : report;
  return _cachedStudentData;
};

export const loadTeacherData = async (username, { year } = {}) => {
  const yearKey = year || '';
  if (_cachedTeacherData && _cachedTeacherData.username === username && _cachedTeacherData._year === yearKey) return _cachedTeacherData;
  // Claim this request's ticket before awaiting so a newer request can invalidate it.
  const seq = ++_teacherRequestSeq;
  const { report, studentReports, exams, academic_years } = await getTeacherDashboard({ year });
  // A newer request (different year) resolved after this one — do not let the
  // stale response clobber the cache. Return whatever the newest request stored.
  if (seq !== _teacherRequestSeq) return _cachedTeacherData;
  _cachedTeacherData = report ? { ...report, username, student_reports: studentReports, exams: exams || [], academic_years: academic_years || [], _year: yearKey } : report;
  return _cachedTeacherData;
};

export const studentData = new Proxy({}, {
    get(_, prop) {
        return _cachedStudentData ? _cachedStudentData[prop] : undefined;
    },
    ownKeys() {
        return _cachedStudentData ? Reflect.ownKeys(_cachedStudentData) : [];
    },
    getOwnPropertyDescriptor(_, prop) {
        if (!_cachedStudentData) return undefined;
        return {
            enumerable: true,
            configurable: true,
            value: _cachedStudentData[prop]
        };
    }
});

export const getCurrentExamData = (examId = 'term1') => {
  const data = _cachedStudentData;
  if (!data) return null;
  
  const examData = data[examId];
  if (!examData) {
      return {
        ...data.student,
        username: data.username,
          examInfo: data.exams.find(e => e.id === examId) || { id: examId, name: examId, date: "" },
          overall_insights: { strongest_area: "", focus_needed: [], pattern: "" },
          subjects: [],
          classRanks: data.classRanks,
      };
  }
  return {
    ...data.student,
    username: data.username,
    workflow: examData?.workflow || data.workflow,
    examInfo: data.exams.find(e => e.id === examId),
    overall_insights: examData.overall_insights,
    subjects: examData.subjects,
    classRanks: data.classRanks,
  };
};

export const teacherData = new Proxy({}, {
    get(_, prop) {
        return _cachedTeacherData ? _cachedTeacherData[prop] : undefined;
    },
    ownKeys() {
        return _cachedTeacherData ? Reflect.ownKeys(_cachedTeacherData) : [];
    },
    getOwnPropertyDescriptor(_, prop) {
        if (!_cachedTeacherData) return undefined;
        return {
            enumerable: true,
            configurable: true,
            value: _cachedTeacherData[prop]
        };
    }
});
