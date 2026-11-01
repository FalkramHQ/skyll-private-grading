import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb = vi.hoisted(() => ({ execute: vi.fn() }));
const auth = vi.hoisted(() => ({
  database: vi.fn(() => mockDb),
  sessionForRequest: vi.fn(),
}));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn() }));

vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);

const { handleCrmRequest } = await import('../../../server/crm/router.js');

const SCHOOL_A = 'sch_a';
const SCHOOL_B = 'sch_b';
const actors = {
  admin: { user_id: 'usr_admin', username: 'a_admin', role: 'admin', school_id: SCHOOL_A, school: 'School A' },
  teacher: { user_id: 'usr_teacher', username: 'a_teacher', role: 'teacher', school_id: SCHOOL_A, school: 'School A' },
  student: { user_id: 'usr_student', username: 'a_stud', role: 'student', school_id: SCHOOL_A, school: 'School A' },
  staff: { user_id: 'usr_staff', username: 'a_staff', role: 'staff', school_id: SCHOOL_A, school: 'School A' },
  platform: { user_id: 'usr_platform', username: 'skyll', role: 'skyll_admin', school_id: 'sch_platform', school: null },
};

function response() {
  return {
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(body) { this.body = body; return this; }),
  };
}

async function call({ actor = null, method = 'GET', segments = ['me'], headers = {}, query = {} } = {}) {
  auth.sessionForRequest.mockResolvedValue(actor);
  const res = response();
  await handleCrmRequest({ method, headers, query }, res, segments);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isSchoolFeatureEnabled.mockResolvedValue(true);
  mockDb.execute.mockImplementation(async ({ args = [] } = {}) => {
    if (args[0] === SCHOOL_B) return { rows: [{ id: SCHOOL_B, display_name: 'School B' }] };
    return { rows: [] };
  });
});

describe('CRM API chain', () => {
  it('returns 401 before anything else when signed out', async () => {
    const res = await call({ actor: null, segments: ['does-not-exist'] });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: { code: 'unauthenticated', message: 'Sign in required' } });
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown resources and 405 for wrong methods', async () => {
    expect((await call({ actor: actors.admin, segments: ['nope'] })).statusCode).toBe(404);
    expect((await call({ actor: actors.admin, method: 'DELETE', segments: ['me'] })).statusCode).toBe(405);
  });

  it('hides the CRM with 404 when the school flag is off', async () => {
    flags.isSchoolFeatureEnabled.mockResolvedValue(false);
    const res = await call({ actor: actors.admin });
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('scopes school users to their own school and ignores X-Skyll-School', async () => {
    const res = await call({ actor: actors.admin, headers: { 'x-skyll-school': SCHOOL_B }, query: { schoolId: SCHOOL_B } });
    expect(res.statusCode).toBe(200);
    expect(res.body.school).toEqual({ id: SCHOOL_A, name: 'School A', timezone: 'Asia/Kolkata' });
    expect(res.body.support).toBe(false);
    expect(flags.isSchoolFeatureEnabled).toHaveBeenCalledWith(actors.admin, 'crm');
  });

  it('shows teachers roster and progress but no leads, fees, or settings', async () => {
    const res = await call({ actor: actors.teacher });
    expect(res.statusCode).toBe(200);
    expect(res.body.sections).toEqual(['overview', 'tasks', 'students', 'classes', 'attendance']);
    // Teachers see only their own tasks by default (D11).
    expect(res.body.taskScope).toBe('own');
    expect(res.body.capabilities).not.toContain('crm.contacts.read');
    expect(res.body.capabilities).not.toContain('crm.finance.read');
  });

  it('refuses students and grant-less staff with 403 even when the flag is on', async () => {
    expect((await call({ actor: actors.student })).statusCode).toBe(403);
    expect((await call({ actor: actors.staff })).statusCode).toBe(403);
  });

  it('requires platform staff to choose a school, which must exist', async () => {
    expect((await call({ actor: actors.platform })).body.error.code).toBe('school_required');
    expect((await call({ actor: actors.platform, headers: { 'x-skyll-school': 'sch_missing' } })).statusCode).toBe(404);
    expect((await call({ actor: actors.platform, headers: { 'x-skyll-school': "x' OR 1=1" } })).statusCode).toBe(404);
  });

  it('lets platform staff open any school, bypassing the flag, marked as support', async () => {
    flags.isSchoolFeatureEnabled.mockResolvedValue(false);
    const res = await call({ actor: actors.platform, headers: { 'x-skyll-school': SCHOOL_B } });
    expect(res.statusCode).toBe(200);
    expect(res.body.school).toEqual({ id: SCHOOL_B, name: 'School B', timezone: 'Asia/Kolkata' });
    expect(res.body.support).toBe(true);
    expect(res.body.sections).toHaveLength(10);
  });

  it('keeps the school picker for platform staff only', async () => {
    expect((await call({ actor: actors.admin, segments: ['schools'] })).statusCode).toBe(403);
    mockDb.execute.mockResolvedValueOnce({ rows: [{ id: SCHOOL_A, slug: 'a', display_name: 'School A', crm_enabled: 1 }] });
    const res = await call({ actor: actors.platform, segments: ['schools'] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ items: [{ id: SCHOOL_A, slug: 'a', name: 'School A', crmEnabled: true }], nextCursor: null });
  });

  it('hides internal errors behind a reference', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    auth.sessionForRequest.mockRejectedValue(new Error('boom'));
    const res = response();
    await handleCrmRequest({ method: 'GET', headers: {}, query: {} }, res, ['me']);
    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe('internal');
    expect(res.body.error.message).not.toContain('boom');
    spy.mockRestore();
  });
});

describe('CRM routing through the auth catch-all', () => {
  it.each([
    ['array', { route: ['crm', 'me'] }],
    ['string', { route: 'crm/me' }],
  ])('dispatches %s route params to the CRM router', async (_kind, query) => {
    const { default: authCatchAll } = await import('../../../api/auth/[...route].js');
    auth.sessionForRequest.mockResolvedValue(actors.admin);
    const res = { ...response(), setHeader: vi.fn(), end: vi.fn() };
    await authCatchAll({ method: 'GET', headers: {}, query, url: '/api/auth/crm/me' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.school.id).toBe(SCHOOL_A);
  });

  it('adds no serverless function (Vercel Hobby cap is 12)', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../api');
    const functions = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('_') || entry.name === '__tests__') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) functions.push(full);
      }
    };
    walk(root);
    expect(functions.length).toBeLessThanOrEqual(12);
  });
});
