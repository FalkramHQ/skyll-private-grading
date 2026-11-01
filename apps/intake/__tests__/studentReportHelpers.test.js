import { formatMathText } from '../src/formatMathText';
import { dnaSummary, getExamBundle, resolveNotificationSubject } from '../src/studentReportHelpers';

describe('formatMathText', () => {
  it('renders common latex as readable text', () => {
    expect(formatMathText('$\\frac{1}{2}$ of $\\vec{a}$ and $\\sqrt{9}$')).toContain('(1)/(2)');
    expect(formatMathText('$\\frac{1}{2}$ of $\\vec{a}$ and $\\sqrt{9}$')).toContain('a⃗');
    expect(formatMathText('$\\frac{1}{2}$ of $\\vec{a}$ and $\\sqrt{9}$')).toContain('√(9)');
    expect(formatMathText('\\times \\pi')).toBe('× π');
  });

  it('strips math delimiters without leaving dollars', () => {
    expect(formatMathText('Solve $x^2$ now')).not.toContain('$');
    expect(formatMathText('Solve $x^2$ now')).toContain('x^2');
  });
});

describe('studentReportHelpers', () => {
  const report = {
    exams: [
      { id: 'exam-a', name: 'Chemistry Unit Test', date: '2026-08-01' },
      { id: 'exam-b', name: 'Physics Midterm', date: '2026-07-10' },
    ],
    term1: {
      subjects: [{ name: 'Chemistry', score: 14, total: 25 }],
      overall_insights: { strongest_area: 'Organic naming', focus_needed: ['Mechanisms'] },
    },
    'exam-a': {
      subjects: [{ name: 'Chemistry', score: 14, total: 25 }],
      overall_insights: { strongest_area: 'Organic naming', focus_needed: ['Mechanisms'] },
    },
    'exam-b': {
      subjects: [{ name: 'Physics', score: 18, total: 40 }],
      overall_insights: { strongest_area: 'Optics', focus_needed: ['Vectors'] },
    },
    learner_dna: {
      primary_mode: {
        mode_id: 'architect',
        title: 'The Architect - Concept building',
        description: 'You build concepts carefully before jumping to method.',
      },
      growth_edge: {
        mode_id: 'calibrator',
        title: 'Strengthen The Calibrator',
        action: 'Check one finished solution against the marking points before moving on.',
      },
      next_move: {
        title: 'Practise verification',
        action: 'Re-work one missed question and verify each step.',
      },
      dimensions: [
        { id: 'architect', state: 'secure', evidence_count: 3 },
        { id: 'calibrator', state: 'needs_practice', evidence_count: 2 },
        { id: 'maker', state: 'not_observed', evidence_count: 0 },
      ],
    },
  };

  it('exposes all exams and switches subject bundles', () => {
    const latest = getExamBundle(report, 'exam-a');
    const older = getExamBundle(report, 'exam-b');
    expect(latest.exams).toHaveLength(2);
    expect(latest.subjects[0].name).toBe('Chemistry');
    expect(older.subjects[0].name).toBe('Physics');
    expect(older.insights.focus_needed).toEqual(['Vectors']);
  });

  it('maps DNA v2 into actionable mobile copy', () => {
    const dna = dnaSummary(report.learner_dna);
    expect(dna.title).toMatch(/Architect/i);
    expect(dna.growth).toMatch(/Calibrator/i);
    expect(dna.next).toMatch(/missed question/i);
    expect(dna.modes.map((mode) => mode.id)).toEqual(['architect', 'calibrator']);
    expect(dna.title).not.toMatch(/still taking shape/i);
  });
});

describe('resolveNotificationSubject', () => {
  const report = {
    exams: [
      { id: 'exam-a', name: 'Chemistry Unit Test' },
      { id: 'exam-b', name: 'Physics Midterm' },
    ],
    term1: { subjects: [{ name: 'Chemistry', score: 14, total: 25 }] },
    'exam-a': { subjects: [{ name: 'Chemistry', score: 14, total: 25 }] },
    'exam-b': { subjects: [{ name: 'Physics', score: 18, total: 40 }] },
  };

  it('opens the exact subject for the exam the notification names', () => {
    const hit = resolveNotificationSubject(report, { subject: 'Chemistry', testId: 'exam-a' });
    expect(hit.subject.name).toBe('Chemistry');
    expect(hit.exam.id).toBe('exam-a');
  });

  it('matches subject names case-insensitively and trims whitespace', () => {
    const hit = resolveNotificationSubject(report, { subject: '  physics ', testId: 'exam-b' });
    expect(hit.subject.name).toBe('Physics');
    expect(hit.exam.id).toBe('exam-b');
  });

  it('falls back to another exam when the testId is stale or missing', () => {
    const stale = resolveNotificationSubject(report, { subject: 'Chemistry', testId: 'exam-b' });
    expect(stale.exam.id).toBe('exam-a');
    const noId = resolveNotificationSubject(report, { subject: 'Physics' });
    expect(noId.subject.name).toBe('Physics');
    expect(noId.exam.id).toBe('exam-b');
  });

  it('returns null when the subject is absent or inputs are missing', () => {
    expect(resolveNotificationSubject(report, { subject: 'Biology' })).toBeNull();
    expect(resolveNotificationSubject(report, {})).toBeNull();
    expect(resolveNotificationSubject(null, { subject: 'Chemistry' })).toBeNull();
  });
});
