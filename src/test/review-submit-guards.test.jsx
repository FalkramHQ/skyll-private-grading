// Review page guards: Shift+Enter approves once even when the key repeats and
// never with an invalid mark; a refetch keeps the mark the reviewer typed; a
// cohort regrade is watched with backoff and only reloads the cohort on screen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import VlReviewDashboard, { REGRADE_POLL, regradeCohortKey, reviewMarksError, watchCohortRegrade } from '../pages/VlReviewDashboard';

const students = [['s0', 'Asha Rao'], ['s1', 'Kiran Patil']];
const questions = ['1', '2'];

function buildItems() {
  return students.flatMap(([sid, name], si) => questions.map((q, qi) => ({
    id: `i_${si}_${qi}`, testId: 't1', isCanonicalTest: true, testStudentId: `ts_${si}`,
    school: 'Demo School', subject: 'Physics', gradeLevel: '11th', examName: 'Units test',
    studentId: `11th_${sid}`, studentName: name, studentUsername: sid,
    questionNumber: q, questionText: `Question ${q}`, marksAllocated: 2, pageCount: 1,
    studentAnswer: { attempted: true, studentWrote: 'answer' },
    grade: { marks: 1, allocated: 2, status: 'partial' },
    reviewStatus: 'pending', overrideMarks: null,
  })));
}

let items;
let posted;
let queueFetches;
let holdReview;

function json(body) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => {
  items = buildItems();
  posted = [];
  queueFetches = 0;
  holdReview = null;
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
  globalThis.fetch = vi.fn((url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/vl-queue?summary=true')) {
      return json({ cohorts: [{ school: 'Demo School', subject: 'Physics', gradeLevel: '11th', examName: 'Units test', testId: 't1', isCanonicalTest: true, totalQuestions: items.length, totalStudents: 2, pending: items.length, approved: 0 }], cohortStatuses: {} });
    }
    if (u.startsWith('/api/vl-queue?')) { queueFetches += 1; return json({ items }); }
    if (u === '/api/vl-queue' && opts.method === 'POST') return json({ ok: true });
    if (u.startsWith('/api/auth/session')) return json({ user: { username: 'rev', role: 'admin', school: 'Demo School' } });
    if (u.startsWith('/api/auth/features')) return json({ features: { review_focus_layout: true } });
    if (u.startsWith('/api/vl-review/')) {
      posted.push({ id: decodeURIComponent(u.split('/').pop()), body: JSON.parse(opts.body) });
      if (holdReview) return holdReview.then(() => json({ ok: true }));
      return json({ ok: true });
    }
    if (u.startsWith('/api/rechecks')) return json({ requests: [] });
    return json({});
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The full review page is heavy to mount on a loaded CI box.
const PAGE_TIMEOUT = 20000;

async function renderReview() {
  await act(async () => { render(<BrowserRouter><VlReviewDashboard /></BrowserRouter>); });
  await screen.findByRole('group', { name: 'Review by' });
}

function shiftEnter() {
  fireEvent.keyDown(document.body, { key: 'Enter', shiftKey: true });
}

describe('Shift+Enter approve', () => {
  it('saves once when the shortcut fires again before the first save lands', async () => {
    await renderReview();
    let release;
    holdReview = new Promise((resolve) => { release = resolve; });
    await act(async () => { shiftEnter(); shiftEnter(); shiftEnter(); });
    await act(async () => { release(); await holdReview; });
    expect(posted).toHaveLength(1);
  }, PAGE_TIMEOUT);

  it('does not approve while the typed mark is invalid', async () => {
    await renderReview();
    fireEvent.change(screen.getByLabelText('Marks'), { target: { value: '5' } });
    expect(screen.getByText("Can't be more than 2")).toBeInTheDocument();
    await act(async () => { shiftEnter(); });
    expect(posted).toHaveLength(0);
  }, PAGE_TIMEOUT);
});

describe('typed marks across a refetch', () => {
  it('keeps an unsaved mark when the queue reloads the same answer', async () => {
    await renderReview();
    fireEvent.change(screen.getByLabelText('Marks'), { target: { value: '1.5' } });
    const before = queueFetches;
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Approve all/ })); });
    await waitFor(() => expect(queueFetches).toBeGreaterThan(before));
    expect(screen.getByLabelText('Marks')).toHaveValue(1.5);
  }, PAGE_TIMEOUT);
});

describe('reviewMarksError', () => {
  const item = { grade: { allocated: 2 }, marksMin: 0 };
  it('accepts blank and half marks in range, refuses the rest', () => {
    expect(reviewMarksError('', item)).toBeNull();
    expect(reviewMarksError('1.5', item)).toBeNull();
    expect(reviewMarksError('3', item)).toBe("Can't be more than 2");
    expect(reviewMarksError('-1', item)).toBe("Can't be less than 0");
    expect(reviewMarksError('0.3', item)).toBe('Use whole or half marks');
  });
});

describe('watchCohortRegrade', () => {
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
  }

  it('backs off from 1.2s to at most 5s and finishes on a terminal status', async () => {
    const c = clock();
    const delays = [];
    const statuses = ['running', 'running', 'running', 'running', 'running', 'published'];
    const progress = [];
    const { run, outcome } = await watchCohortRegrade({ id: 'r1', status: 'queued' }, {
      readRun: async (id) => ({ id, status: statuses.shift() }),
      onProgress: (next) => progress.push(next.status),
      isActive: () => true,
      sleep: async (ms) => { delays.push(ms); await c.sleep(ms); },
      now: c.now,
    });
    expect(outcome).toBe('done');
    expect(run.status).toBe('published');
    expect(delays).toEqual([1200, 1800, 2700, 4050, 5000, 5000]);
    expect(progress.at(-1)).toBe('published');
  });

  it('stops watching (without failing) after the time limit', async () => {
    const c = clock();
    const { run, outcome } = await watchCohortRegrade({ id: 'r1', status: 'queued' }, {
      readRun: async (id) => ({ id, status: 'running' }),
      onProgress: () => {},
      isActive: () => true,
      sleep: c.sleep,
      now: c.now,
    });
    expect(outcome).toBe('watch_expired');
    expect(run.status).toBe('running');
    expect(c.now()).toBeGreaterThanOrEqual(REGRADE_POLL.giveUpMs);
  });

  it('stops polling once the page is gone and never reports late progress', async () => {
    const c = clock();
    let active = true;
    const onProgress = vi.fn();
    const readRun = vi.fn(async (id) => { active = false; return { id, status: 'published' }; });
    const { outcome } = await watchCohortRegrade({ id: 'r1', status: 'queued' }, {
      readRun, onProgress, isActive: () => active, sleep: c.sleep, now: c.now,
    });
    expect(outcome).toBe('stopped');
    expect(readRun).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('tells a regraded cohort apart from the one now on screen', () => {
    const regraded = { school: 'Demo', testId: 't1', subject: 'Physics', grade: '11th' };
    expect(regradeCohortKey({ ...regraded })).toBe(regradeCohortKey(regraded));
    expect(regradeCohortKey({ ...regraded, testId: 't2' })).not.toBe(regradeCohortKey(regraded));
    expect(regradeCohortKey(null)).not.toBe(regradeCohortKey(regraded));
  });
});
