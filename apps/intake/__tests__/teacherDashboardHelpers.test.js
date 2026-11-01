import {
  normalizeSubject,
  deriveDefaultSelections,
  resetSelections,
  calculateKPIs,
  calculateScoreDistribution,
  sortStudents,
  filterStudents
} from '../src/teacherDashboardHelpers';

describe('teacherDashboardHelpers', () => {
  describe('normalizeSubject', () => {
    test('normalizes subject names and aliases', () => {
      expect(normalizeSubject('maths')).toBe('Mathematics');
      expect(normalizeSubject('math')).toBe('Mathematics');
      expect(normalizeSubject('mathematics')).toBe('Mathematics');
      expect(normalizeSubject('physics')).toBe('Physics');
      expect(normalizeSubject('chemistry')).toBe('Chemistry');
      expect(normalizeSubject('chem')).toBe('Chemistry');
      expect(normalizeSubject('biology')).toBe('Biology');
      expect(normalizeSubject('bio')).toBe('Biology');
      expect(normalizeSubject('science')).toBe('Science');
      expect(normalizeSubject('accounts')).toBe('Accounts');
      expect(normalizeSubject('accountancy')).toBe('Accounts');
      expect(normalizeSubject('english')).toBe('English');
      expect(normalizeSubject('hindi')).toBe('Hindi');
      expect(normalizeSubject('german')).toBe('German');
      expect(normalizeSubject('Deutsch')).toBe('German');
      expect(normalizeSubject('German language')).toBe('German');
      expect(normalizeSubject('History & Civics')).toBe('History');
      expect(normalizeSubject('civics')).toBe('History');
      expect(normalizeSubject('geography')).toBe('Geography');
      expect(normalizeSubject('deutsch')).toBe('German');
      expect(normalizeSubject('german language')).toBe('German');
    });

    test('normalizes set spellings like "Science Set A"', () => {
      expect(normalizeSubject('Science Set A')).toBe('Science');
      expect(normalizeSubject('Physics Set B')).toBe('Physics');
    });

    test('handles empty inputs', () => {
      expect(normalizeSubject(null)).toBe('');
      expect(normalizeSubject('')).toBe('');
    });
  });

  describe('deriveDefaultSelections', () => {
    const data = {
      academic_years: [
        { id: 'ay2025', label: '2024-2025', is_current: false },
        { id: 'ay2026', label: '2025-2026', is_current: true }
      ],
      exams: [
        { id: 'exam1', source_test_id: 'test1', academic_year_id: 'ay2026', exam_date: '2026-08-01' },
        { id: 'exam2', source_test_id: 'test2', academic_year_id: 'ay2026', exam_date: '2026-08-02' },
        { id: 'exam3', source_test_id: 'test3', academic_year_id: 'ay2025', exam_date: '2025-08-01' }
      ]
    };

    test('defaults to current academic year and its most recent matching exam', () => {
      const defaults = deriveDefaultSelections(data);
      expect(defaults.defaultYear).toBe('ay2026');
      // defaultExamId is first one since they are pre-sorted in the backend list
      expect(defaults.defaultExamId).toBe('test1');
    });

    test('handles empty data gracefully', () => {
      const defaults = deriveDefaultSelections(null);
      expect(defaults.defaultYear).toBe('');
      expect(defaults.defaultExamId).toBe('');
    });
  });

  describe('resetSelections', () => {
    const exams = [
      { id: 'exam1', source_test_id: 'test1', academic_year_id: 'ay2026', subject: 'Maths', grade: '9th', exam_type: 'mcq', exam_date: '2026-08-01' },
      { id: 'exam2', source_test_id: 'test2', academic_year_id: 'ay2026', subject: 'Physics', grade: '10th', exam_type: 'subjective', exam_date: '2026-08-02' },
      { id: 'exam3', source_test_id: 'test3', academic_year_id: 'ay2025', subject: 'Chemistry', grade: '9th', exam_type: 'mcq', exam_date: '2025-08-01' }
    ];

    test('keeps all selections if they are valid', () => {
      const current = {
        year: 'ay2026',
        subject: 'Mathematics',
        grade: '9th',
        examType: 'mcq',
        examDate: '2026-08-01',
        examId: 'test1'
      };
      const reset = resetSelections(exams, current);
      expect(reset).toEqual(current);
    });

    test('resets downstream selections when an upstream filter changes and they become invalid', () => {
      const current = {
        year: 'ay2026',
        subject: 'Physics', // physics is 10th, subjective
        grade: '9th',       // invalid for physics
        examType: 'mcq',    // invalid for physics
        examDate: '2026-08-01', // invalid for physics
        examId: 'test1'     // invalid for physics
      };
      const reset = resetSelections(exams, current);
      expect(reset.year).toBe('ay2026');
      expect(reset.subject).toBe('Physics');
      expect(reset.grade).toBe('');      // reset because Physics does not have 9th grade
      expect(reset.examType).toBe('');   // reset
      expect(reset.examDate).toBe('');   // reset
      expect(reset.examId).toBe('test2'); // defaulted to the valid physics exam
    });

    test('resets invalid academic year transition', () => {
      const current = {
        year: 'ay2025',
        subject: 'Mathematics', // Mathematics only in ay2026
        grade: '9th',
        examType: 'mcq',
        examDate: '2026-08-01',
        examId: 'test1'
      };
      const reset = resetSelections(exams, current);
      expect(reset.year).toBe('ay2025');
      expect(reset.subject).toBe('');
      expect(reset.grade).toBe('9th'); // Chemistry in ay2025 is 9th grade, so this is valid!
      expect(reset.examType).toBe('mcq'); // Chemistry in ay2025 is mcq, so this is valid!
      expect(reset.examDate).toBe(''); // invalid date for 2025
      expect(reset.examId).toBe('test3'); // Chemistry exam
    });
  });

  describe('KPIs and Metrics', () => {
    const studentReports = [
      {
        username: 'student1',
        student: { name: 'Aditi Sharma', class: '9th' },
        test_id: 'test1',
        term1: {
          subjects: [
            { name: 'Mathematics', score: 80, total: 100 }
          ]
        }
      },
      {
        username: 'student2',
        student: { name: 'Rahul Verma', class: '9th' },
        test_id: 'test1',
        term1: {
          subjects: [
            { name: 'Mathematics', score: 30, total: 100 }
          ]
        }
      },
      {
        username: 'student3',
        student: { name: 'Rohan Gupta', class: '9th' },
        test_id: 'test1',
        term1: {
          subjects: [
            { name: 'Mathematics', score: 90, total: 100 }
          ]
        }
      }
    ];

    test('calculates correct KPIs', () => {
      const kpis = calculateKPIs(studentReports, 'test1', 'Mathematics');
      expect(kpis.evaluatedStudents).toBe(3);
      // Avg: (80 + 30 + 90) / 3 = 66.67 -> 67%
      expect(kpis.averagePercentage).toBe(67);
      // Pass rate: (2 out of 3 pass >= 35%) = 67%
      expect(kpis.passRate).toBe(67);
      // Top scorer is Rohan Gupta with 90/100
      expect(kpis.topScorer).toEqual({ name: 'Rohan Gupta', score: 90, total: 100 });
    });

    test('handles empty scores and missing data', () => {
      const kpis = calculateKPIs([], 'test1', 'Mathematics');
      expect(kpis.evaluatedStudents).toBe(0);
      expect(kpis.averagePercentage).toBe(0);
      expect(kpis.passRate).toBe(0);
      expect(kpis.topScorer).toBeNull();
    });

    test('calculates score distribution correctly', () => {
      const dist = calculateScoreDistribution(studentReports, 'test1', 'Mathematics');
      expect(dist).toEqual([
        { name: '0–20%', count: 0 },
        { name: '21–40%', count: 1 }, // Rahul (30%)
        { name: '41–60%', count: 0 },
        { name: '61–80%', count: 1 }, // Aditi (80%)
        { name: '81–100%', count: 1 } // Rohan (90%)
      ]);
    });
  });

  describe('Sorting and Filtering', () => {
    const studentReports = [
      {
        username: 'student1',
        student: { name: 'Aditi Sharma', class: '9th' },
        test_id: 'test1',
        term1: {
          subjects: [
            { name: 'Mathematics', score: 80, total: 100 }
          ]
        }
      },
      {
        username: 'student2',
        student: { name: 'Rahul Verma', class: '10th' },
        test_id: 'test1',
        term1: {
          subjects: [
            { name: 'Mathematics', score: 30, total: 100 }
          ]
        }
      },
      {
        username: 'student3',
        student: { name: 'Amit Kumar', class: '9th' },
        test_id: 'test1',
        term1: {
          subjects: [
            { name: 'Mathematics', score: 95, total: 100 }
          ]
        }
      }
    ];

    test('sorts students correctly', () => {
      const sortedByName = sortStudents(studentReports, 'name', 'test1', 'Mathematics');
      expect(sortedByName[0].student.name).toBe('Aditi Sharma');
      expect(sortedByName[1].student.name).toBe('Amit Kumar');
      expect(sortedByName[2].student.name).toBe('Rahul Verma');

      const sortedByMarksDesc = sortStudents(studentReports, 'marks-desc', 'test1', 'Mathematics');
      expect(sortedByMarksDesc[0].student.name).toBe('Amit Kumar'); // 95
      expect(sortedByMarksDesc[1].student.name).toBe('Aditi Sharma'); // 80
      expect(sortedByMarksDesc[2].student.name).toBe('Rahul Verma'); // 30

      const sortedByMarksAsc = sortStudents(studentReports, 'marks-asc', 'test1', 'Mathematics');
      expect(sortedByMarksAsc[0].student.name).toBe('Rahul Verma'); // 30
    });

    test('filters students by class, search query, and performance', () => {
      // Filter class 9th
      const classFiltered = filterStudents(studentReports, 'test1', 'Mathematics', { classFilter: '9th' });
      expect(classFiltered.length).toBe(2);
      expect(classFiltered.map(s => s.student.name)).toContain('Aditi Sharma');
      expect(classFiltered.map(s => s.student.name)).toContain('Amit Kumar');

      // Filter search query
      const queryFiltered = filterStudents(studentReports, 'test1', 'Mathematics', { query: 'kumar' });
      expect(queryFiltered.length).toBe(1);
      expect(queryFiltered[0].student.name).toBe('Amit Kumar');

      // Filter performance band (developing: 45-75%) -> empty since we have 80% (strong), 95% (strong), 30% (needs-work)
      const developingFiltered = filterStudents(studentReports, 'test1', 'Mathematics', { performanceFilter: 'developing' });
      expect(developingFiltered.length).toBe(0);

      // Filter strong (>= 75%)
      const strongFiltered = filterStudents(studentReports, 'test1', 'Mathematics', { performanceFilter: 'strong' });
      expect(strongFiltered.length).toBe(2);
    });
  });
});
