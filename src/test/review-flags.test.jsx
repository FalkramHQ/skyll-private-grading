// Teachers see why a question was flagged: each grading tag as a labelled chip,
// an answer credited under another question, and the rubric key-check finding.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import VlReviewDashboard from '../pages/VlReviewDashboard';
import { keyCheckFinding, reviewFlagsFor } from '../../shared/reviewFlags.js';
import { asReviewItem } from '../../api/vl-queue.js';

describe('reviewFlagsFor', () => {
  it('labels known tags, humanizes unknown ones and skips tags with their own badge', () => {
    const flags = reviewFlagsFor({ reviewTags: ['flagged', 'harsh_zero', 'idea_credit_review', 'low_extraction_confidence', 'some_new_tag', 'idea_credit_review'] });
    expect(flags.map((flag) => flag.label)).toEqual(['Zero may deserve credit', 'Answer hard to read', 'Some new tag']);
    expect(flags[0].hint).toMatch(/part marks/);
  });

  it('marks an unclear maths answer as critical', () => {
    expect(reviewFlagsFor({ reviewTags: ['low_extraction_confidence', 'symbol_answer_unclear'] }).map((flag) => [flag.label, flag.tone])).toEqual([
      ['Maths answer unclear', 'critical'],
      ['Answer hard to read', 'caution'],
    ]);
  });

  it('adds the duplicate and key-check flags, critical first', () => {
    const flags = reviewFlagsFor({
      reviewTags: ['feedback_language_fallback_english'],
      duplicateOf: 'Q4',
      keyCheck: { verdict: 'disagree', checker_answer: '2.5 m/s', status: 'open', note: 'Key used g = 9.8 twice' },
    });
    expect(flags.map((flag) => flag.key)).toEqual(['key_check', 'duplicate_of', 'feedback_language_fallback_english']);
    expect(flags[0]).toMatchObject({ label: 'Key disputed', tone: 'critical' });
    expect(flags[1].label).toBe('Credited under Q4');
  });

  it('shows key-check findings only when they needed a decision', () => {
    expect(keyCheckFinding({ verdict: 'agree', status: 'none' })).toBeNull();
    expect(keyCheckFinding({ verdict: 'unsupported', status: 'none' })).toBeNull();
    expect(keyCheckFinding(null)).toBeNull();
    expect(keyCheckFinding({ verdict: 'alternative', checker_answer: 'B', status: 'alternative' })).toMatchObject({
      summary: 'Another printed option also looks correct: B',
      resolution: 'The admin accepted this as an alternative answer.',
    });
    expect(keyCheckFinding({ verdict: 'disagree', checker_answer: '12', status: 'kept' }).resolution).toBe('The admin kept the key.');
  });
});

describe('review API item', () => {
  it('carries duplicate_of and the key check from the query row', () => {
    const row = { id: 'q1', student_id: 'st1', question_number: 'Q2', duplicate_of: 'Q4', key_check_json: JSON.stringify({ verdict: 'disagree', status: 'kept', checker_answer: '12' }) };
    const item = asReviewItem(row, { reviewTags: ['low_extraction_confidence'] }, new Map(), new Set(), new Map(), new Map(), new Map(), new Map());
    expect(item.duplicateOf).toBe('Q4');
    expect(item.keyCheck).toMatchObject({ status: 'kept', checker_answer: '12' });
    const bare = asReviewItem({ id: 'q2', student_id: 'st1', question_number: 'Q3' }, {}, new Map(), new Set(), new Map(), new Map(), new Map(), new Map());
    expect(bare).toMatchObject({ duplicateOf: null, keyCheck: null });
  });
});

describe('review screen flags', () => {
  const item = (overrides) => ({
    testId: 't1', isCanonicalTest: true, testStudentId: 'ts_0',
    school: 'Demo School', subject: 'Physics', gradeLevel: '11th', examName: 'Units test',
    studentId: '11th_s0', studentName: 'Asha Rao', studentUsername: 's0',
    questionText: 'Find the speed.', correctAnswer: '3 m/s', marksAllocated: 2, pageCount: 1,
    studentAnswer: { attempted: true, studentWrote: 'answer' },
    grade: { marks: 0, allocated: 2, status: 'incorrect' },
    gradeRationale: { whatWentCorrect: '', missingOrWrong: 'No working shown.' },
    reviewStatus: 'pending', overrideMarks: null,
    ...overrides,
  });
  let items;

  beforeEach(() => {
    items = [
      item({ id: 'i1', questionNumber: '1', isFlagged: true, reviewTags: ['flagged', 'idea_credit_review'], duplicateOf: 'Q3', keyCheck: { verdict: 'disagree', checker_answer: '2.5 m/s', status: 'kept', note: 'Checker used the given radius.' } }),
      item({ id: 'i2', questionNumber: '2', reviewTags: [] }),
    ];
    window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    window.ResizeObserver = class { observe() {} disconnect() {} };
    Element.prototype.scrollTo = () => {};
    localStorage.clear();
    localStorage.setItem('userRole', 'admin');
    localStorage.setItem('userSchool', 'Demo School');
    localStorage.setItem('skyll.review.rosterTipSeen', '1');
    window.history.replaceState(null, '', '/review?cohort=test%3At1&student=11th_s0');
    const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    globalThis.fetch = vi.fn((url) => {
      const u = String(url);
      if (u.startsWith('/api/vl-queue?summary=true')) {
        return json({ cohorts: [{ school: 'Demo School', subject: 'Physics', gradeLevel: '11th', examName: 'Units test', testId: 't1', isCanonicalTest: true, totalQuestions: 2, totalStudents: 1, pending: 2, approved: 0 }], cohortStatuses: {} });
      }
      if (u.startsWith('/api/vl-queue?')) return json({ items });
      if (u.startsWith('/api/auth/features')) return json({ features: {} });
      if (u.startsWith('/api/rechecks')) return json({ requests: [] });
      return json({});
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows labelled flags, the duplicate and the key-check finding for the current question', async () => {
    await act(async () => { render(<BrowserRouter><VlReviewDashboard /></BrowserRouter>); });
    expect(await screen.findByText('Zero may deserve credit')).toBeInTheDocument();
    expect(screen.getByText('Credited under Q3')).toBeInTheDocument();
    expect(screen.getByText('Key was checked')).toBeInTheDocument();
    expect(screen.getByText(/An independent check disagreed with the key: 2.5 m\/s/)).toBeInTheDocument();
    expect(screen.getByText(/The admin kept the key/)).toBeInTheDocument();
    expect(screen.getByText(/Check whether part marks are due/)).toBeInTheDocument();
  });
});
