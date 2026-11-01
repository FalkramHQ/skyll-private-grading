import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeClient = vi.hoisted(() => ({ execute: vi.fn() }));

const env = vi.hoisted(() => ({ tursoUrl: 'file:/tmp/vl-review-test.db', tursoAuthToken: 'token' }));

const auth = vi.hoisted(() => ({
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
}));

const reviewerEdit = vi.hoisted(() => ({ saveReviewDecision: vi.fn() }));

const RecheckContractError = vi.hoisted(() => {
  class RecheckContractError extends Error {
    constructor(message, status = 400, details = {}) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  return { RecheckContractError };
});

vi.mock('@libsql/client/web', () => ({ createClient: vi.fn(() => fakeClient) }));
vi.mock('../../api/_lib/env.js', () => env);
vi.mock('../../api/_lib/auth.js', () => auth);
vi.mock('../../api/_lib/reviewerEditService.js', () => reviewerEdit);
vi.mock('../../api/_lib/recheckCollectionService.js', () => RecheckContractError);

import handler from '../../api/vl-review/[id].js';

function response() {
  const res = {
    statusCode: null,
    body: null,
    setHeader: vi.fn(function setHeader(k, v) { this.headers = this.headers || {}; this.headers[k] = v; return this; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(data) { this.body = data; return this; }),
    end: vi.fn(),
  };
  return res;
}

describe('vl-review HTTP handler authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewerEdit.saveReviewDecision.mockResolvedValue({ changed: false, reviewRevision: 0 });
  });

  it('answers OPTIONS preflight without authentication', async () => {
    const res = response();
    await handler({ method: 'OPTIONS' }, res);
    expect(res.statusCode).toBe(204);
    expect(auth.requireUser).not.toHaveBeenCalled();
  });

  it('stops when authentication fails with 401', async () => {
    auth.requireUser.mockImplementationOnce(async (_req, res) => {
      res.status(401).json({ error: 'Sign in required' });
      return null;
    });
    const res = response();
    await handler({ method: 'POST', query: { id: 'question_a' }, body: {} }, res);
    expect(res.statusCode).toBe(401);
    expect(reviewerEdit.saveReviewDecision).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods with 405', async () => {
    const res = response();
    await handler({ method: 'GET', query: { id: 'question_a' } }, res);
    expect(res.statusCode).toBe(405);
  });

  it('requires an item id with 400', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_a', role: 'admin', school: 'Alpha School' });
    const res = response();
    await handler({ method: 'POST', query: {}, body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(reviewerEdit.saveReviewDecision).not.toHaveBeenCalled();
  });

  it('passes the authenticated actor and item to the review service', async () => {
    const actor = { username: 'admin_a', role: 'admin', school: 'Alpha School' };
    auth.requireUser.mockResolvedValueOnce(actor);
    reviewerEdit.saveReviewDecision.mockResolvedValueOnce({ changed: true, marks: 3, reviewRevision: 1 });

    const res = response();
    await handler({ method: 'POST', query: { id: 'question_a' }, body: { overrideMarks: 3 } }, res);

    expect(reviewerEdit.saveReviewDecision).toHaveBeenCalledWith(fakeClient, actor, 'question_a', { overrideMarks: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 'question_a', changed: true, marks: 3 });
  });

  it('maps a cross-school contract rejection to its status code', async () => {
    auth.requireUser.mockResolvedValueOnce({ username: 'admin_b', role: 'admin', school: 'Beta School' });
    reviewerEdit.saveReviewDecision.mockRejectedValueOnce(
      new RecheckContractError.RecheckContractError('School access denied', 403, {}),
    );

    const res = response();
    await handler({ method: 'POST', query: { id: 'question_a' }, body: { overrideMarks: 5 } }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'School access denied' });
  });
});
