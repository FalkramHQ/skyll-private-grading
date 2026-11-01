// Public inquiry form and its settings on real SQLite (FLKRM-326 S6, D8, D9).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

const require = createRequire(import.meta.url);
const migrations = ['059_crm_access_audit', '060_crm_pipeline', '061_crm_contacts', '062_crm_leads', '064_crm_lost_reason_key', '065_crm_tasks', '066_crm_guardian_rules', '067_crm_pipeline_requirements', '068_crm_inquiry_settings']
  .flatMap((name) => require(`../../../scripts/migrations/${name}.cjs`).statements);

const state = vi.hoisted(() => ({ db: null, buckets: new Map() }));
const auth = vi.hoisted(() => ({ database: vi.fn(() => state.db), sessionForRequest: vi.fn() }));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
const limiter = vi.hoisted(() => ({
  checkRateLimit: vi.fn(async (key, { max }) => {
    const next = (state.buckets.get(key) || 0) + 1;
    state.buckets.set(key, next);
    return next > max;
  }),
}));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);
vi.mock('../../../api/_lib/rateLimit.js', () => limiter);

const { handleCrmRequest } = await import('../../../server/crm/router.js');

const admin = { user_id: 'usr_admin', username: 'a_admin', role: 'admin', school_id: 'sch_a', school: 'School A' };
const adminB = { user_id: 'usr_admin_b', username: 'b_admin', role: 'admin', school_id: 'sch_b', school: 'School B' };
const teacher = { user_id: 'usr_teacher', username: 'a_teacher', role: 'teacher', school_id: 'sch_a', school: 'School A' };
let dir;

async function call(actor, method, route, { body, query = {}, headers = {} } = {}) {
  auth.sessionForRequest.mockResolvedValue(actor);
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handleCrmRequest({ method, headers, query, body }, res, route.split('/'));
  return res;
}

const form = (overrides = {}) => ({
  parentName: 'Sunita Nair', parentPhone: '98200 11122', learnerName: 'Meera Nair', learnerGrade: '9',
  course: 'Grade 9 Maths', message: 'Weekend batches?', consent: true, whatsappOptIn: true, ...overrides,
});
const submit = (body = form(), { school = 'school-a', ip = '203.0.113.5' } = {}) => call(null, 'POST', 'public/inquiry', {
  query: { school }, body, headers: { 'x-forwarded-for': `1.1.1.1, ${ip}` },
});
const enable = async (actor = admin, body = {}) => {
  const current = (await call(actor, 'GET', 'settings/inquiry')).body;
  return call(actor, 'POST', 'settings/inquiry', { body: { enabled: true, defaultOwnerUserId: actor.user_id, expectedVersion: current.version, ...body } });
};
const rows = async (sql, args = []) => (await state.db.execute({ sql, args })).rows;

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-inquiry-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.buckets.clear();
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([
    'CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT)',
    "CREATE TABLE schools (id TEXT PRIMARY KEY, slug TEXT UNIQUE, display_name TEXT, status TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata')",
    'CREATE TABLE school_memberships (id TEXT PRIMARY KEY, school_id TEXT, user_id TEXT, role TEXT, status TEXT)',
    'CREATE TABLE school_feature_flags (school_id TEXT, feature_key TEXT, enabled INTEGER, PRIMARY KEY (school_id, feature_key))',
    ...migrations,
    `INSERT INTO schools (id, slug, display_name, status) VALUES ('sch_a', 'school-a', 'School A', 'active'), ('sch_b', 'school-b', 'School B', 'active'),
       ('sch_off', 'school-off', 'No CRM School', 'active')`,
    "INSERT INTO school_feature_flags VALUES ('sch_a', 'crm', 1), ('sch_b', 'crm', 1), ('sch_off', 'crm', 0)",
    "INSERT INTO users VALUES ('usr_admin', 'Admin A', 'active'), ('usr_admin_b', 'Admin B', 'active'), ('usr_teacher', 'Teacher A', 'active')",
    `INSERT INTO school_memberships VALUES ('m1', 'sch_a', 'usr_admin', 'school_admin', 'active'), ('m2', 'sch_b', 'usr_admin_b', 'school_admin', 'active'),
       ('m3', 'sch_a', 'usr_teacher', 'teacher', 'active')`,
  ], 'write');
});

describe('Inquiry form settings', () => {
  it('starts off, needs an eligible owner to turn on, checks the version and is audited', async () => {
    const initial = await call(admin, 'GET', 'settings/inquiry');
    expect(initial.body).toEqual(expect.objectContaining({ enabled: false, defaultOwnerUserId: null, version: 0, publicPath: '/inquire/school-a' }));
    expect(initial.body.owners.map((owner) => owner.userId)).toEqual(['usr_admin']);

    expect((await call(admin, 'POST', 'settings/inquiry', { body: { enabled: true, defaultOwnerUserId: null, expectedVersion: 0 } })).statusCode).toBe(422);
    // A teacher can't own leads, and another school's admin isn't a member here.
    expect((await call(admin, 'POST', 'settings/inquiry', { body: { enabled: true, defaultOwnerUserId: 'usr_teacher', expectedVersion: 0 } })).body.error.code).toBe('invalid_owner');
    expect((await call(admin, 'POST', 'settings/inquiry', { body: { enabled: true, defaultOwnerUserId: 'usr_admin_b', expectedVersion: 0 } })).body.error.code).toBe('invalid_owner');

    const on = await enable();
    expect(on.body).toEqual(expect.objectContaining({ enabled: true, defaultOwnerUserId: 'usr_admin', ownerEligible: true, version: 1 }));
    expect((await call(admin, 'POST', 'settings/inquiry', { body: { enabled: false, defaultOwnerUserId: null, expectedVersion: 0 } })).statusCode).toBe(409);
    const off = await call(admin, 'POST', 'settings/inquiry', { body: { enabled: false, defaultOwnerUserId: 'usr_admin', expectedVersion: 1 } });
    expect(off.body).toEqual(expect.objectContaining({ enabled: false, version: 2 }));

    const audit = await rows("SELECT school_id, entity_type, summary_json FROM crm_audit_events WHERE action = 'inquiry_form.changed' ORDER BY id");
    expect(audit.map((row) => [row.school_id, row.entity_type, JSON.parse(row.summary_json).enabled])).toEqual([['sch_a', 'school', true], ['sch_a', 'school', false]]);
    expect((await call(teacher, 'GET', 'settings/inquiry')).statusCode).toBe(403);
  });

  it('keeps each school’s settings separate', async () => {
    await enable();
    expect((await call(adminB, 'GET', 'settings/inquiry')).body).toEqual(expect.objectContaining({ enabled: false, version: 0, publicPath: '/inquire/school-b' }));
  });
});

describe('Public inquiry form', () => {
  it('answers the same 404 for an unknown school, a school without the CRM, a form that is off, and a bad slug', async () => {
    const responses = [
      await call(null, 'GET', 'public/inquiry', { query: { school: 'nope' } }),
      await call(null, 'GET', 'public/inquiry', { query: { school: 'school-off' } }),
      await call(null, 'GET', 'public/inquiry', { query: { school: 'school-a' } }),
      await call(null, 'GET', 'public/inquiry', { query: { school: '../school-a' } }),
      await call(null, 'GET', 'public/inquiry', {}),
      await submit(form()),
      await submit({ nonsense: true }),
    ];
    for (const res of responses) expect([res.statusCode, res.body]).toEqual([404, { error: { code: 'not_found', message: 'Not found' } }]);
    expect(auth.sessionForRequest).not.toHaveBeenCalledWith(expect.anything());
    expect(await rows('SELECT id FROM crm_leads')).toEqual([]);
  });

  it('turns a submission into a website lead with contact, note, owner task and audit', async () => {
    await enable();
    expect((await call(null, 'GET', 'public/inquiry', { query: { school: 'school-a' } })).body).toEqual({ school: { name: 'School A' } });
    const res = await submit();
    expect([res.statusCode, res.body]).toEqual([200, { received: true }]);

    const [lead] = await rows(`SELECT l.*, st.category, src.source_key FROM crm_leads l
      JOIN crm_pipeline_stages st ON st.id = l.stage_id LEFT JOIN crm_lead_sources src ON src.id = l.source_id`);
    expect(lead).toEqual(expect.objectContaining({
      school_id: 'sch_a', learner_name: 'Meera Nair', learner_grade: '9', category: 'open', source_key: 'website', owner_user_id: 'usr_admin', created_by: null,
    }));
    expect(JSON.parse(lead.interest_json)).toEqual({ course: 'Grade 9 Maths' });
    const [contact] = await rows('SELECT * FROM crm_contacts');
    expect(contact).toEqual(expect.objectContaining({ full_name: 'Sunita Nair', phone_e164: '+919820011122', whatsapp_opted_in: 1, consent_source: 'public_form' }));
    const [note] = await rows('SELECT body, author_user_id FROM crm_notes');
    expect(note.author_user_id).toBeNull();
    expect(note.body).toMatch(/^Inquiry from the website form\./);
    expect(note.body).toContain('Message: Weekend batches?');
    expect(note.body).toContain('Consent: the parent agreed to be contacted');
    const [task] = await rows('SELECT title, owner_user_id, related_id FROM crm_tasks');
    expect(task).toEqual({ title: 'Follow up with Meera Nair', owner_user_id: 'usr_admin', related_id: lead.id });
    const [audit] = await rows("SELECT actor_user_id, actor_role, summary_json FROM crm_audit_events WHERE action = 'lead.created'");
    expect(audit).toEqual(expect.objectContaining({ actor_user_id: null, actor_role: 'public' }));
    expect(JSON.parse(audit.summary_json)).toEqual(expect.objectContaining({ channel: 'public_form', sourceKey: 'website' }));

    // Staff see it like any other lead.
    const list = (await call(admin, 'GET', 'leads')).body.items;
    expect(list).toEqual([expect.objectContaining({ learnerName: 'Meera Nair', source: { key: 'website', label: 'Website' } })]);
  });

  it('adds a repeat inquiry to the open lead; a sibling becomes a new lead', async () => {
    await enable();
    await submit();
    const [lead] = await rows('SELECT id FROM crm_leads');
    const again = await submit(form({ learnerName: 'meera  NAIR', message: 'Still interested', whatsappOptIn: false }));
    expect(again.body).toEqual({ received: true });
    expect(await rows('SELECT id FROM crm_leads')).toHaveLength(1);
    const notes = await rows('SELECT body FROM crm_notes WHERE entity_id = ? ORDER BY created_at, rowid', [lead.id]);
    expect(notes.at(-1).body).toMatch(/^Re-submitted inquiry/);
    // Its follow-up task is still open, so no second one.
    expect(await rows('SELECT id FROM crm_tasks')).toHaveLength(1);
    // Consent given earlier is not withdrawn by a later form without the tick.
    expect((await rows('SELECT whatsapp_opted_in FROM crm_contacts'))[0].whatsapp_opted_in).toBe(1);

    await submit(form({ learnerName: 'Riya Nair' }));
    const leads = await rows('SELECT learner_name, primary_contact_id FROM crm_leads ORDER BY created_at, rowid');
    expect(leads.map((row) => row.learner_name)).toEqual(['Meera Nair', 'Riya Nair']);
    expect(new Set(leads.map((row) => row.primary_contact_id)).size).toBe(1);
  });

  it('gives a repeat inquiry a new task when the old one is done', async () => {
    await enable();
    await submit();
    await state.db.execute("UPDATE crm_tasks SET status = 'done'");
    await submit(form({ message: 'Hello again' }));
    expect((await rows("SELECT id FROM crm_tasks WHERE status = 'open'"))).toHaveLength(1);
  });

  it('never changes a contact already on file, so a stranger can’t opt someone in to WhatsApp', async () => {
    await enable();
    await submit(form({ whatsappOptIn: false, parentName: 'Sunita Nair' }));
    await submit(form({ learnerName: 'Riya Nair', parentName: 'Someone Else', whatsappOptIn: true }));
    expect(await rows('SELECT full_name, whatsapp_opted_in, consent_source FROM crm_contacts')).toEqual([
      expect.objectContaining({ full_name: 'Sunita Nair', whatsapp_opted_in: 0, consent_source: null }),
    ]);
    const notes = await rows('SELECT body FROM crm_notes ORDER BY created_at, rowid');
    expect(notes.at(-1).body).toContain('WhatsApp updates: yes');
  });

  it('saves nothing for a filled honeypot but answers the same, even for an invalid form', async () => {
    await enable();
    expect((await submit({ website: 'http://spam.example', anything: 1 })).body).toEqual({ received: true });
    const res = await submit(form({ website: 'http://spam.example' }));
    expect([res.statusCode, res.body]).toEqual([200, { received: true }]);
    expect(await rows('SELECT id FROM crm_leads')).toEqual([]);
    expect(await rows('SELECT id FROM crm_contacts')).toEqual([]);
  });

  it('rejects a body naming a school, missing consent or with a bad phone', async () => {
    await enable();
    const withSchool = await submit(form({ schoolId: 'sch_b' }));
    expect(withSchool.statusCode).toBe(422);
    expect((await submit(form({ consent: false }))).body.error.details).toEqual([expect.objectContaining({ path: 'consent' })]);
    expect((await submit(form({ parentPhone: '12' }))).statusCode).toBe(422);
    expect(await rows('SELECT id FROM crm_leads')).toEqual([]);
  });

  it('limits submissions per address and per school', async () => {
    await enable();
    for (let i = 0; i < 5; i += 1) expect((await submit(form({ learnerName: `Child ${i}` }))).statusCode).toBe(200);
    const blocked = await submit(form({ learnerName: 'Child 6' }));
    expect([blocked.statusCode, blocked.body.error.code]).toEqual([429, 'rate_limited']);
    // Spoofing the left of x-forwarded-for doesn't help: only the last hop counts.
    expect((await call(null, 'POST', 'public/inquiry', { query: { school: 'school-a' }, body: form(), headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.5' } })).statusCode).toBe(429);
    // A different address still gets through, until the school-wide cap.
    expect((await submit(form({ learnerName: 'Other family' }), { ip: '198.51.100.7' })).statusCode).toBe(200);
    const keys = [...state.buckets.keys()];
    expect(keys.some((key) => key.includes('203.0.113.5'))).toBe(false);
  });

  it('leaves form leads unowned when the chosen owner has left, and never writes to another school', async () => {
    await enable();
    await call(adminB, 'POST', 'settings/inquiry', { body: { enabled: true, defaultOwnerUserId: 'usr_admin_b', expectedVersion: 0 } });
    await state.db.execute("UPDATE school_memberships SET status = 'inactive' WHERE user_id = 'usr_admin'");
    await submit();
    await submit(form({ learnerName: 'Kabir Rao' }), { school: 'school-b' });
    const leads = await rows('SELECT school_id, learner_name, owner_user_id FROM crm_leads ORDER BY school_id');
    expect(leads).toEqual([
      expect.objectContaining({ school_id: 'sch_a', learner_name: 'Meera Nair', owner_user_id: null }),
      expect.objectContaining({ school_id: 'sch_b', learner_name: 'Kabir Rao', owner_user_id: 'usr_admin_b' }),
    ]);
    // The same phone in school B is a separate contact.
    expect((await rows('SELECT DISTINCT school_id FROM crm_contacts ORDER BY school_id')).map((row) => row.school_id)).toEqual(['sch_a', 'sch_b']);
  });
});
