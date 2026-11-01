import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { SCHOOL_SLUG_ALIASES, slugifySchoolName } from '../../server/schools/public.js';
import { uniqueStudentLoginId } from '../../server/schools/roster.js';

const require = createRequire(import.meta.url);
const { assertStudentCredential, createStudentPassword } = require('../../scripts/lib/credentialPolicy.cjs');

const mockDb = vi.hoisted(() => ({ execute: vi.fn() }));
const auth = vi.hoisted(() => ({
  database: vi.fn(() => mockDb),
  ensureAuthTables: vi.fn().mockResolvedValue(),
  requireUser: vi.fn(),
  hashPassword: vi.fn(() => 'hashed'),
}));

vi.mock('../../api/_lib/auth.js', () => auth);

import provisionHandler from '../../server/schools/provision.js';

function response() {
  return {
    headers: {},
    setHeader: vi.fn(function setHeader(name, value) { this.headers[name] = value; }),
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(body) { this.body = body; return this; }),
  };
}

describe('classes-first growth helpers', () => {
  it('keeps existing school portal slugs as aliases', () => {
    expect(SCHOOL_SLUG_ALIASES.partnerc).toBe('Partner Academy C');
    expect(SCHOOL_SLUG_ALIASES.partnerd).toBe('Partner Academy D');
    expect(slugifySchoolName("Partner Academy A")).toBe('partner-academy-a');
  });

  it('resolves the short partnerf portal path to its full DB slug', () => {
    // DB slug is `partner-academy-f`; the portal path /partnerf needs this alias
    // or DynamicSchoolLogin redirects home.
    expect(SCHOOL_SLUG_ALIASES.partnerf).toBe('Partner Academy F');
    expect(slugifySchoolName('Partner Academy F')).toBe('partner-academy-f');
  });

  it('generates unique 6-character student logins that match credential policy', async () => {
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ 1: 1 }] })
        .mockResolvedValue({ rows: [] }),
    };
    const loginId = await uniqueStudentLoginId(db);
    expect(loginId).toMatch(/^[a-z0-9]{6}$/);
    expect(() => assertStudentCredential({ username: loginId, password: createStudentPassword() })).not.toThrow();
    expect(db.execute).toHaveBeenCalledTimes(2);
  });
});

describe('provision authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.execute.mockResolvedValue({ rows: [] });
  });

  it('rejects unauthenticated school provision requests', async () => {
    auth.requireUser.mockImplementationOnce(async (_req, res) => {
      res.status(401).json({ error: 'Sign in required' });
      return null;
    });
    const res = response();
    await provisionHandler({ method: 'POST', body: { slug: 'demo', displayName: 'Demo' } }, res);
    expect(res.statusCode).toBe(401);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });
});
