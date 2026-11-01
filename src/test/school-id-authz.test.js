// FLKRM-385: school display names are not a safe tenant key. Two schools must
// never share a normalized name, an ambiguous name resolves to no school, and
// session-scoped reads use the pinned school_id. Real SQLite.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createClient } from '@libsql/client';

const { institutionSlug } = createRequire(import.meta.url)('../../scripts/lib/credentialPolicy.cjs');

const state = vi.hoisted(() => ({ db: null, user: null }));
vi.mock('../../api/_lib/auth.js', () => ({
  database: () => state.db,
  ensureAuthTables: async () => {},
  hashPassword: async () => 'hashed',
  requireUser: async (_req, res, roles) => {
    if (roles && !roles.includes(state.user.role)) { res.status(403).json({ error: 'forbidden' }); return null; }
    return state.user;
  },
}));

const { resolveSchoolId, resetSchoolCache } = await import('../../api/_lib/canonicalSubmissions.js');
const { default: provision } = await import('../../server/schools/provision.js');

const platform = { user_id: 'u_p', username: 'sky', role: 'skyll_admin', school_id: 'sch_p', school: 'Skyll' };
const PASSWORD = 'Abcdef123456';

function response() {
  return {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function provisionSchool(slug, displayName) {
  state.user = platform;
  const res = response();
  const adminUsername = `${institutionSlug(displayName)}_admin`;
  await provision({ method: 'POST', body: { slug, displayName, adminUsername, adminPassword: PASSWORD } }, res);
  return res;
}

beforeEach(async () => {
  resetSchoolCache();
  state.db = createClient({ url: ':memory:' });
  await state.db.batch([
    'CREATE TABLE schools (id TEXT PRIMARY KEY, slug TEXT, display_name TEXT, institution_type TEXT, status TEXT, timezone TEXT, created_at TEXT, updated_at TEXT)',
    'CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, created_at TEXT, updated_at TEXT)',
    'CREATE TABLE user_credentials (id TEXT PRIMARY KEY, user_id TEXT, login_id TEXT, password_hash TEXT, credential_type TEXT, is_primary INTEGER, status TEXT, created_at TEXT, updated_at TEXT)',
    'CREATE TABLE school_memberships (id TEXT PRIMARY KEY, school_id TEXT, user_id TEXT, role TEXT, status TEXT, created_at TEXT, updated_at TEXT)',
    "INSERT INTO schools (id, slug, display_name, status) VALUES ('sch_mary', 'st-marys', 'St. Mary''s', 'active')",
    "INSERT INTO schools (id, slug, display_name, status) VALUES ('sch_alpha', 'alpha', 'Alpha Academy', 'active')",
  ], 'write');
});

afterEach(() => state.db?.close());

describe('resolveSchoolId', () => {
  it('resolves an unambiguous name, slug, or punctuation variant', async () => {
    expect(await resolveSchoolId(state.db, "St. Mary's")).toBe('sch_mary');
    expect(await resolveSchoolId(state.db, 'st-marys')).toBe('sch_mary');
    expect(await resolveSchoolId(state.db, 'St Marys')).toBe('sch_mary');
    expect(await resolveSchoolId(state.db, 'Unknown School')).toBeNull();
  });

  it('resolves a punctuation variant shared by two schools to no school, not the last one loaded', async () => {
    // Pre-existing data the new provisioning check would now refuse.
    await state.db.execute("INSERT INTO schools (id, slug, display_name, status) VALUES ('sch_mary2', 'st-marys-2', 'St Marys', 'active')");
    resetSchoolCache();
    // Matches neither school exactly, and both once punctuation is ignored.
    expect(await resolveSchoolId(state.db, 'ST-MARYS!')).toBeNull();
    expect(await resolveSchoolId(state.db, 'stmarys')).toBeNull();
    // An exact name or slug still identifies one school.
    expect(await resolveSchoolId(state.db, "St. Mary's")).toBe('sch_mary');
    expect(await resolveSchoolId(state.db, 'St Marys')).toBe('sch_mary2');
    expect(await resolveSchoolId(state.db, 'st-marys-2')).toBe('sch_mary2');
  });

  it("treats one school's name equal to another's slug as ambiguous", async () => {
    await state.db.execute("INSERT INTO schools (id, slug, display_name, status) VALUES ('sch_x', 'x-school', 'alpha', 'active')");
    resetSchoolCache();
    expect(await resolveSchoolId(state.db, 'alpha')).toBeNull();
  });
});

describe('school provisioning', () => {
  it("refuses a display name that collides with an existing school's once punctuation is ignored", async () => {
    const res = await provisionSchool('st-marys-new', 'St Marys');
    expect(res.statusCode).toBe(409);
    expect((await state.db.execute('SELECT COUNT(*) AS n FROM schools')).rows[0].n).toBe(2);
  });

  it("refuses a slug that collides with an existing school's name", async () => {
    expect((await provisionSchool('alpha-academy', 'Brand New School')).statusCode).toBe(409);
  });

  it('still provisions a genuinely new school', async () => {
    const res = await provisionSchool('beta-school', 'Beta School');
    expect(res.statusCode).toBe(201);
    expect(await resolveSchoolId(state.db, 'Beta School')).toBe(res.body.schoolId);
  });
});
