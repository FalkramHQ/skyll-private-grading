// FLKRM-485: school billing profiles — validation, completeness, and the
// skyll_admin-only list/save endpoint against the production schema.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDatabase } from './helpers/schemaDatabase.js';

const state = vi.hoisted(() => ({ db: null, user: null }));
vi.mock('../../api/_lib/auth.js', () => ({
  database: () => state.db,
  ensureAuthTables: async () => {},
  requireUser: async (_req, res, roles) => {
    if (roles && !roles.includes(state.user.role)) { res.status(403).json({ error: 'forbidden' }); return null; }
    return state.user;
  },
}));

const { INDIAN_STATES, isBillingProfileComplete, getBillingProfile, validateBillingProfile } = await import('../../api/_lib/billingProfiles.js');
const { default: billingProfiles } = await import('../../server/billing/profiles.js');

const platform = { user_id: 'u_sky', username: 'sky_admin', role: 'skyll_admin', school_id: 'sch_p', school: 'Skyll HQ' };
const T = '2026-10-01T00:00:00.000Z';
const VALID = { legalName: 'Alpha Classes Pvt Ltd', address: 'Office 4, FC Road\nPune 411004', placeOfSupply: 'Maharashtra' };

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function call(method, body) {
  const res = response();
  await billingProfiles({ method, query: {}, body, headers: {} }, res);
  return res;
}

beforeEach(async () => {
  state.user = platform;
  state.db = await createSchemaDatabase();
  await state.db.batch([
    { sql: 'INSERT INTO schools (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', args: ['sch_a', 'alpha', 'Alpha Classes', 'active', T, T] },
    { sql: 'INSERT INTO schools (id, slug, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', args: ['sch_demo', 'demo', 'Skyll Demo School', 'active', T, T] },
  ], 'write');
});

describe('validateBillingProfile', () => {
  it('normalises the input and keeps the address line breaks', () => {
    const { profile } = validateBillingProfile({ ...VALID, legalName: '  Alpha   Classes  ', address: ' Office 4 \r\n\r\n Pune ', gstin: '27abcde1234f1z5 ', pan: 'abcde1234f' });
    expect(profile).toEqual({ legalName: 'Alpha Classes', address: 'Office 4\nPune', gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F', placeOfSupply: 'Maharashtra' });
  });

  it('allows empty GSTIN and PAN', () => {
    expect(validateBillingProfile({ ...VALID, gstin: '', pan: '  ' }).profile).toMatchObject({ gstin: null, pan: null });
  });

  it.each([
    [{ legalName: '' }, 'Legal name'],
    [{ address: ' \n ' }, 'Address'],
    [{ placeOfSupply: 'Maharastra' }, 'Place of supply'],
    [{ placeOfSupply: '' }, 'Place of supply'],
    [{ gstin: '27ABCDE1234F1X5' }, 'GSTIN'],
    [{ gstin: '27ABCDE1234F' }, 'GSTIN'],
    [{ pan: 'ABCD1234F' }, 'PAN'],
    [{ legalName: 'x'.repeat(201) }, 'Legal name'],
  ])('rejects %o', (override, message) => {
    expect(validateBillingProfile({ ...VALID, ...override }).error).toContain(message);
  });

  it('offers all 36 states and union territories', () => {
    expect(INDIAN_STATES).toHaveLength(36);
    expect(new Set(INDIAN_STATES).size).toBe(36);
  });
});

describe('isBillingProfileComplete', () => {
  it('needs legal name, address and a valid place of supply; GSTIN and PAN are optional', () => {
    expect(isBillingProfileComplete({ ...VALID, gstin: null, pan: null })).toBe(true);
    expect(isBillingProfileComplete(null)).toBe(false);
    expect(isBillingProfileComplete({ ...VALID, address: '' })).toBe(false);
    expect(isBillingProfileComplete({ ...VALID, placeOfSupply: 'Atlantis' })).toBe(false);
  });
});

describe('/api/auth/billing-profiles', () => {
  it('lists every school, with a null profile until one is saved', async () => {
    const res = await call('GET');
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(res.body.states).toEqual(INDIAN_STATES);
    expect(res.body.schools.map((school) => [school.id, school.profile, school.complete])).toEqual([
      ['sch_a', null, false],
      ['sch_demo', null, false],
    ]);
  });

  it('creates, then updates a profile, recording who saved it', async () => {
    const created = await call('PUT', { schoolId: 'sch_a', ...VALID, gstin: '27ABCDE1234F1Z5' });
    expect(created.statusCode).toBe(200);
    expect(created.body).toMatchObject({ complete: true, profile: { schoolId: 'sch_a', gstin: '27ABCDE1234F1Z5', pan: null, updatedBy: 'sky_admin' } });

    const updated = await call('PUT', { schoolId: 'sch_a', ...VALID, legalName: 'Alpha Classes LLP', gstin: '' });
    expect(updated.body.profile).toMatchObject({ legalName: 'Alpha Classes LLP', gstin: null });
    const rows = await state.db.execute('SELECT COUNT(*) AS n FROM school_billing_profiles');
    expect(Number(rows.rows[0].n)).toBe(1);

    expect(await getBillingProfile(state.db, 'sch_a')).toMatchObject({ legalName: 'Alpha Classes LLP', placeOfSupply: 'Maharashtra' });
    const list = await call('GET');
    expect(list.body.schools.find((school) => school.id === 'sch_a')).toMatchObject({ complete: true, profile: { legalName: 'Alpha Classes LLP' } });
  });

  it('rejects invalid input, unknown schools and a missing schoolId without writing', async () => {
    expect((await call('PUT', { schoolId: 'sch_a', ...VALID, pan: 'BAD' })).statusCode).toBe(400);
    expect((await call('PUT', { ...VALID })).statusCode).toBe(400);
    expect((await call('PUT', { schoolId: 'sch_missing', ...VALID })).statusCode).toBe(404);
    const rows = await state.db.execute('SELECT COUNT(*) AS n FROM school_billing_profiles');
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it('saves, returns, keeps and clears price bands with the profile (#311)', async () => {
    const saved = await call('PUT', { schoolId: 'sch_a', ...VALID, bands: [{ maxMarks: 80, pricePaise: 2000 }, { maxMarks: 40, pricePaise: 1000 }] });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.bands).toEqual([{ maxMarks: 40, pricePaise: 1000 }, { maxMarks: 80, pricePaise: 2000 }]);
    const listed = (await call('GET')).body.schools;
    expect(listed.find((school) => school.id === 'sch_a').bands).toHaveLength(2);
    expect(listed.find((school) => school.id === 'sch_demo').bands).toEqual([]);

    // A save without `bands` leaves them alone; `bands: []` clears them (back to ₹0.25/mark).
    expect((await call('PUT', { schoolId: 'sch_a', ...VALID, legalName: 'Renamed Ltd' })).body.bands).toHaveLength(2);
    expect((await call('PUT', { schoolId: 'sch_a', ...VALID, bands: [] })).body.bands).toEqual([]);
  });

  it('rejects bad bands without saving the profile either', async () => {
    const res = await call('PUT', { schoolId: 'sch_a', ...VALID, bands: [{ maxMarks: 40, pricePaise: 1000 }, { maxMarks: 40, pricePaise: 1200 }] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('share the limit');
    expect(Number((await state.db.execute('SELECT COUNT(*) AS n FROM school_billing_profiles')).rows[0].n)).toBe(0);
  });

  it('has no delete and refuses school admins', async () => {
    expect((await call('DELETE', { schoolId: 'sch_a' })).statusCode).toBe(405);
    state.user = { ...platform, role: 'admin', school_id: 'sch_a' };
    expect((await call('GET')).statusCode).toBe(403);
    expect((await call('PUT', { schoolId: 'sch_a', ...VALID })).statusCode).toBe(403);
  });
});
