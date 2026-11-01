// Reviewer focus layout (school flag review_focus_layout): reviewers can work
// one student at a time or one question across every student, the marks box
// refuses impossible marks, and approve-and-next follows the visible order.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import VlReviewDashboard from '../pages/VlReviewDashboard';

const students = [['s0', 'Asha Rao'], ['s1', 'Kiran Patil'], ['s2', 'Meera Joshi']];
const questions = ['1', '2', '3'];

function buildItems() {
  return students.flatMap(([sid, name], si) => questions.map((q, qi) => ({
    id: `i_${si}_${qi}`, testId: 't1', isCanonicalTest: true, testStudentId: `ts_${si}`,
    school: 'Demo School', subject: 'Physics', gradeLevel: '11th', examName: 'Units test',
    studentId: `11th_${sid}`, studentName: name, studentUsername: sid,
    questionNumber: q, questionText: `Question ${q}`, marksAllocated: 1, pageCount: 1,
    studentAnswer: { attempted: true, studentWrote: 'answer' },
    grade: { marks: 1, allocated: 1, status: 'correct' },
    reviewStatus: 'pending', overrideMarks: null,
  })));
}

let items;
let posted;

function json(body) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  items = buildItems();
  posted = [];
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {},
  }));
  window.ResizeObserver = class { observe() {} disconnect() {} };
  Element.prototype.scrollTo = () => {};
  localStorage.clear();
  localStorage.setItem('userRole', 'admin');
  localStorage.setItem('userSchool', 'Demo School');
  localStorage.setItem('skyll.review.rosterTipSeen', '1');
  window.history.replaceState(null, '', '/review?cohort=test%3At1&student=11th_s0');
  globalThis.fetch = vi.fn((url, opts) => {
    const u = String(url);
    if (u.startsWith('/api/vl-queue?summary=true')) {
      return json({ cohorts: [{ school: 'Demo School', subject: 'Physics', gradeLevel: '11th', examName: 'Units test', testId: 't1', isCanonicalTest: true, totalQuestions: items.length, totalStudents: 3, pending: items.length, approved: 0 }], cohortStatuses: {} });
    }
    if (u.startsWith('/api/vl-queue?')) return json({ items });
    if (u.startsWith('/api/auth/features')) return json({ features: { review_focus_layout: true } });
    if (u.startsWith('/api/vl-review/')) { posted.push({ id: decodeURIComponent(u.split('/').pop()), body: JSON.parse(opts.body) }); return json({ ok: true }); }
    if (u.startsWith('/api/rechecks')) return json({ requests: [] });
    return json({});
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderReview() {
  await act(async () => { render(<BrowserRouter><VlReviewDashboard /></BrowserRouter>); });
  await screen.findByRole('group', { name: 'Review by' });
}

describe('reviewer focus layout', () => {
  it('opens on the deep-linked student with the marks rail beside the sheet', async () => {
    await renderReview();
    expect(screen.getByRole('region', { name: 'Answer sheet' })).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Grading' });
    expect(within(rail).getByLabelText('Marks')).toBeInTheDocument();
    expect(within(rail).getByText('1 of 3')).toBeInTheDocument();
    const picker = screen.getAllByRole('button', { name: /Asha Rao/ }).find((button) => button.getAttribute('aria-haspopup') === 'listbox');
    expect(picker).toHaveTextContent('1 of 3');
  });

  it('refuses marks above the maximum and keeps approve disabled', async () => {
    await renderReview();
    const marks = screen.getByLabelText('Marks');
    fireEvent.change(marks, { target: { value: '5' } });
    expect(screen.getByText("Can't be more than 1")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /& next/ })).toBeDisabled();
    fireEvent.change(marks, { target: { value: '0.5' } });
    expect(screen.queryByText("Can't be more than 1")).toBeNull();
    expect(screen.getByRole('button', { name: /& next/ })).not.toBeDisabled();
  });

  it('by question, approve and next walks the students in list order', async () => {
    await renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'By question' }));
    expect(await screen.findByText('Answers to question 1')).toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Grading' });
    const first = within(rail).getByText(/· answer 1 of 3/).textContent;
    await act(async () => { fireEvent.click(within(rail).getByRole('button', { name: /Approve & next/ })); });
    expect(posted).toHaveLength(1);
    const approved = items.find((item) => item.id === posted[0].id);
    expect(approved.questionNumber).toBe('1');
    // The next answer is the same question for a different student.
    const next = within(rail).getByText(/· answer 1 of 2/).textContent;
    expect(next).not.toBe(first);
    expect(within(rail).getByText('1', { selector: 'span.font-headline' })).toBeInTheDocument();
  });
});
