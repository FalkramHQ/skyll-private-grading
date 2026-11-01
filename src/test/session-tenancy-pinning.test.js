import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeClient = vi.hoisted(() => ({ execute: vi.fn() }));
const env = vi.hoisted(() => ({ tursoUrl: 'file:/tmp/session-pinning-test.db', tursoAuthToken: 'token' }));

vi.mock('@libsql/client/web', () => ({ createClient: vi.fn(() => fakeClient) }));
vi.mock('../../api/_lib/env.js', () => env);

function response() {
  const res = {
    headers: {},
    setHeader: vi.fn(function setHeader(name, value) { this.headers[name] = value; return this; }),
  };
  return res;
}

function sqlFrom(arg) {
  return typeof arg === 'string' ? arg : arg.sql;
}

// Feature gates probe schema_migrations once per module load. Tests that don't
// care about gating get "applied" for every gate; tests that withhold 070 use
// gateApplied({ pinned: false }).
function canonicalReady(sql) {
  return sql.includes('schema_migrations');
}

function sessionRow(overrides = {}) {
  return {
    user_id: 'u1',
    username: 'teacher_1',
    school_membership_id: 'mem_beta',
    role: 'teacher',
    school_id: 'sch_beta',
    school: 'Beta School',
    expires_at: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Rows as the canonical join returns them: two memberships, Alpha sorting first.
function membershipRows() {
  return [
    { user_id: 'u1', username: 'teacher_1', password_hash: 'h', school_membership_id: 'mem_alpha', role: 'teacher', school_id: 'sch_alpha', school: 'Alpha School', active: 1 },
    { user_id: 'u1', username: 'teacher_1', password_hash: 'h', school_membership_id: 'mem_beta', role: 'teacher', school_id: 'sch_beta', school: 'Beta School', active: 1 },
  ];
}

// The feature gates memoize per module, so each test imports a fresh copy of
// auth.js. The mock factory is stable across resetModules, so the fresh module
// still sees this test's fake DB.
async function loadAuth() {
  vi.resetModules();
  return import('../../api/_lib/auth.js');
}

function gateApplied(sql, { pinned }) {
  return canonicalReady(sql) && (pinned || !sql.includes('070_pin_session_membership'));
}

function insertCall() {
  return fakeClient.execute.mock.calls
    .map(([arg]) => arg)
    .find((arg) => typeof arg === 'object' && arg.sql.includes('INSERT INTO sessions'));
}

async function lookupSql({ pinned }) {
  const captured = [];
  fakeClient.execute.mockImplementation(async (arg) => {
    captured.push(arg);
    const sql = sqlFrom(arg);
    if (gateApplied(sql, { pinned })) return { rows: [{ id: 'x' }] };
    if (sql.includes('FROM sessions')) return { rows: [sessionRow()] };
    return { rows: [] };
  });
  const { sessionForRequest } = await loadAuth();
  const user = await sessionForRequest({ headers: { cookie: 'skyll_session=token' } });
  expect(user.school_id).toBe('sch_beta');
  return captured.find((arg) => typeof arg === 'object' && arg.sql.includes('FROM sessions')).sql;
}

describe('session tenancy pinning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every gate reports applied, including 070: the canonical, pinned path.
    fakeClient.execute.mockImplementation(async (arg) => {
      const sql = sqlFrom(arg);
      if (canonicalReady(sql)) return { rows: [{ id: 'x' }] };
      return { rows: [] };
    });
  });

  it('refuses to create a session without a pinned school', async () => {
    const { createSession } = await loadAuth();
    await expect(createSession(response(), { user_id: 'u1' })).rejects.toThrow('Pinned membership required');
    expect(fakeClient.execute).not.toHaveBeenCalledWith(expect.objectContaining({ sql: expect.stringContaining('INSERT INTO sessions') }));
  });

  it('persists the login membership and school on the session row', async () => {
    const { createSession } = await loadAuth();
    await createSession(response(), { user_id: 'u1', school_membership_id: 'mem_beta', school_id: 'sch_beta' });

    const insert = insertCall();
    expect(insert.sql).toContain('credential_id, school_membership_id');
    expect(insert.args[0]).toMatch(/^[0-9a-f]{64}$/); // token hash, never the raw token
    expect(insert.args.slice(1, 4)).toEqual(['u1', 'sch_beta', 'mem_beta']);
  });

  it('pins only the school before 070 has been applied', async () => {
    // 070 withheld: the membership column does not exist yet, so the insert must
    // not name it — but the school is still pinned, never omitted.
    fakeClient.execute.mockImplementation(async (arg) => ({ rows: gateApplied(sqlFrom(arg), { pinned: false }) ? [{ id: 'x' }] : [] }));
    const { createSession } = await loadAuth();

    await createSession(response(), { user_id: 'u1', school_membership_id: 'mem_beta', school_id: 'sch_beta' });

    const insert = insertCall();
    expect(insert.sql).not.toContain('school_membership_id');
    expect(insert.args.slice(1, 3)).toEqual(['u1', 'sch_beta']);
  });

  it('scopes the request to the membership pinned at login, not the alphabetically first', async () => {
    // The user is a member of both Beta and Alpha; the session was opened at Beta.
    const select = await lookupSql({ pinned: true });
    // Tenancy comes from the pinned membership, and there is no ordering fallback.
    expect(select).toContain('membership.id = s.school_membership_id');
    expect(select).not.toContain('ORDER BY');
    expect(select).not.toContain('LIMIT 20');
  });

  it('still fails closed on the pinned school before 070 has been applied', async () => {
    // Deploys land before migrations run; the interim lookup must keep 069's
    // school pin rather than reintroduce the ordering rule.
    const select = await lookupSql({ pinned: false });
    expect(select).toContain('membership.school_id = s.credential_id');
    expect(select).not.toContain('ORDER BY');
  });

  it('rejects a session whose pinned membership no longer resolves', async () => {
    // Covers revoked membership, deactivated school, and legacy sessions written
    // before tenancy was pinned (school_membership_id IS NULL): the join yields no
    // row and the request must fail closed instead of falling back to another school.
    fakeClient.execute.mockImplementation(async (arg) => {
      const sql = sqlFrom(arg);
      if (canonicalReady(sql)) return { rows: [{ id: 'x' }] };
      if (sql.includes('FROM sessions')) return { rows: [] };
      return { rows: [] };
    });

    const { sessionForRequest } = await loadAuth();
    expect(await sessionForRequest({ headers: { cookie: 'skyll_session=token' } })).toBeNull();
  });

  describe('authenticateUser tenancy resolution', () => {
    function withMemberships(rows) {
      fakeClient.execute.mockImplementation(async (arg) => {
        const sql = sqlFrom(arg);
        if (canonicalReady(sql)) return { rows: [{ id: 'x' }] };
        if (sql.includes('FROM user_credentials')) return { rows };
        // Portal names resolve to ids through the schools table (FLKRM-389).
        if (sql.includes('FROM schools')) {
          return { rows: [{ id: 'sch_alpha', slug: 'alpha', display_name: 'Alpha School' }, { id: 'sch_beta', slug: 'beta', display_name: 'Beta School' }] };
        }
        return { rows: [] };
      });
    }

    it('hands the session the membership for the school the portal declared', async () => {
      withMemberships(membershipRows());
      const { authenticateUser } = await loadAuth();

      const user = await authenticateUser('teacher_1', 'Beta School');
      expect(user.school_id).toBe('sch_beta');
      expect(user.school_membership_id).toBe('mem_beta');
      expect(user.needsSchoolPortal).toBeUndefined();
    });

    it('refuses a multi-school login that did not declare a school', async () => {
      withMemberships(membershipRows());
      const { authenticateUser, createSession } = await loadAuth();

      const user = await authenticateUser('teacher_1');
      expect(user.needsSchoolPortal).toBe(true);
      // The stub carries no membership, so a caller that ignores the flag cannot
      // silently pin the wrong tenant — createSession refuses it.
      await expect(createSession(response(), user)).rejects.toThrow('Pinned membership required');
    });

    it('returns null for a portal whose school does not match any membership', async () => {
      withMemberships(membershipRows());
      const { authenticateUser } = await loadAuth();

      expect(await authenticateUser('teacher_1', 'Gamma School')).toBeNull();
    });

    describe('two roles at one school (FLKRM-387)', () => {
      // admin + scanner at Beta: rows as the query returns them, admin first.
      const twoRoles = () => [
        { user_id: 'u1', username: 'beta_admin', password_hash: 'h', school_membership_id: 'mem_admin', role: 'school_admin', school_id: 'sch_beta', school: 'Beta School', active: 1 },
        { user_id: 'u1', username: 'beta_admin', password_hash: 'h', school_membership_id: 'mem_scan', role: 'scanner', school_id: 'sch_beta', school: 'Beta School', active: 1 },
      ];

      it("picks the membership the portal's allowed roles single out, not the first row", async () => {
        withMemberships(twoRoles());
        const { authenticateUser } = await loadAuth();
        const user = await authenticateUser('beta_admin', 'Beta School', { allowedRoles: ['scanner'] });
        expect(user).toMatchObject({ school_membership_id: 'mem_scan', role: 'scanner', school_id: 'sch_beta' });
      });

      it('honours an explicit expectedRole, in either naming', async () => {
        withMemberships(twoRoles());
        const { authenticateUser } = await loadAuth();
        expect((await authenticateUser('beta_admin', 'Beta School', { expectedRole: 'admin' })).school_membership_id).toBe('mem_admin');
        expect((await authenticateUser('beta_admin', 'Beta School', { expectedRole: 'school_admin' })).school_membership_id).toBe('mem_admin');
        expect((await authenticateUser('beta_admin', null, { expectedRole: 'scanner' })).school_membership_id).toBe('mem_scan');
      });

      it('refuses to pick when several roles fit, and the stub cannot open a session', async () => {
        withMemberships(twoRoles());
        const { authenticateUser, createSession } = await loadAuth();
        for (const user of [
          await authenticateUser('beta_admin', 'Beta School'),
          await authenticateUser('beta_admin', null),
          await authenticateUser('beta_admin', 'Beta School', { allowedRoles: ['admin', 'scanner'] }),
        ]) {
          expect(user).toMatchObject({ needsRole: true, school_membership_id: null, school_id: null });
          expect(user.roleChoices.sort()).toEqual(['admin', 'scanner']);
          expect(user.needsSchoolPortal).toBeUndefined();
          await expect(createSession(response(), user)).rejects.toThrow('Pinned membership required');
        }
      });

      it('flags no portal access when no membership fits the portal', async () => {
        withMemberships(twoRoles());
        const { authenticateUser } = await loadAuth();
        const user = await authenticateUser('beta_admin', 'Beta School', { allowedRoles: ['teacher'] });
        expect(user).toMatchObject({ noPortalAccess: true, school_membership_id: null });
      });
    });

    it('resolves a single-membership user without a declared portal', async () => {
      withMemberships([membershipRows()[0]]);
      const { authenticateUser } = await loadAuth();

      const user = await authenticateUser('teacher_1');
      expect(user.school_membership_id).toBe('mem_alpha');
      expect(user.school_id).toBe('sch_alpha');
      expect(user.needsSchoolPortal).toBeUndefined();
    });
  });
});
