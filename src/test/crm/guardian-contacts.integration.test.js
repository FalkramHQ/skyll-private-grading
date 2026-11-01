// Parent phones moved from students.parent_* to CRM guardian contacts
// (migration 061). Real SQLite: roster import writes contacts without implying
// WhatsApp consent, and never crosses schools.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

const require = createRequire(import.meta.url);
const migration061 = require('../../../scripts/migrations/061_crm_contacts.cjs');
const migration065 = require('../../../scripts/migrations/066_crm_guardian_rules.cjs');

const state = vi.hoisted(() => ({ db: null, user: null }));
const auth = vi.hoisted(() => ({
  database: vi.fn(() => state.db),
  ensureAuthTables: vi.fn(async () => {}),
  hashPassword: vi.fn(async () => 'hashed'),
  requireUser: vi.fn(async (_req, res, roles) => {
    if (!state.user) { res.status(401).json({ error: 'Sign in required' }); return null; }
    if (roles && !roles.includes(state.user.role)) { res.status(403).json({ error: 'forbidden' }); return null; }
    return state.user;
  }),
}));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/intake.js', () => ({ ensureIntakeTables: vi.fn(async () => {}) }));

const { default: rosterHandler } = await import('../../../server/schools/roster.js');
const { resolveParentContact } = await import('../../../server/parent/contact.js');

const adminA = { user_id: 'usr_admin_a', role: 'admin', school_id: 'sch_a', school: 'School A' };

let dir;

function response() {
  return {
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function as(user, handler, body) {
  state.user = user;
  const res = response();
  await handler({ method: 'POST', headers: {}, query: {}, body }, res);
  return res;
}

async function rows(sql) {
  return (await state.db.execute(sql)).rows;
}

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-contacts-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  vi.clearAllMocks();
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([
    'CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, created_at TEXT, updated_at TEXT)',
    "CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata')",
    'CREATE TABLE user_credentials (id TEXT PRIMARY KEY, user_id TEXT, login_id TEXT, password_hash TEXT, credential_type TEXT, is_primary INTEGER, status TEXT, created_at TEXT, updated_at TEXT)',
    'CREATE TABLE school_memberships (id TEXT PRIMARY KEY, school_id TEXT, user_id TEXT, role TEXT, status TEXT, created_at TEXT, updated_at TEXT)',
    `CREATE TABLE students (id TEXT PRIMARY KEY, school TEXT NOT NULL, display_name TEXT NOT NULL, roster_key TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, school_id TEXT, user_id TEXT, parent_phone TEXT, parent_name TEXT, parent_whatsapp_opted_in INTEGER NOT NULL DEFAULT 0)`,
    'CREATE TABLE student_user_links (student_id TEXT PRIMARY KEY, user_id TEXT, school_id TEXT, link_status TEXT, linked_by TEXT, linked_at TEXT)',
    'CREATE TABLE batches (id TEXT PRIMARY KEY, school TEXT, name TEXT, grade TEXT, board TEXT, stream TEXT, academic_year TEXT, school_id TEXT, status TEXT, created_at TEXT, updated_at TEXT)',
    'CREATE TABLE batch_memberships (id TEXT PRIMARY KEY, batch_id TEXT, student_id TEXT, status TEXT, joined_at TEXT, created_at TEXT, updated_at TEXT)',
    'CREATE TABLE submissions (id TEXT PRIMARY KEY, student_id TEXT)',
    'CREATE TABLE report_versions (id TEXT PRIMARY KEY, submission_id TEXT, student_id TEXT, school TEXT, version INTEGER)',
    ...migration061.statements,
    ...migration065.statements,
  ], 'write');
});

async function importRoster(students) {
  return as(adminA, rosterHandler, { batches: [{ label: 'Grade 10' }], students: students.map((student) => ({ batchLabel: 'Grade 10', ...student })) });
}

describe('roster import writes guardian contacts', () => {
  it('stores the parent phone as a primary guardian and never in students.parent_*, without implying consent', async () => {
    const res = await importRoster([{ displayName: 'Asha', parentPhone: '98123 45621', parentName: 'Ravi', parentOptedIn: true }]);
    expect(res.statusCode).toBe(201);
    const [student] = await rows('SELECT id, parent_phone, parent_name, parent_whatsapp_opted_in FROM students');
    expect([student.parent_phone, student.parent_name, Number(student.parent_whatsapp_opted_in)]).toEqual([null, null, 0]);
    const [contact] = await rows('SELECT school_id, full_name, phone_e164, whatsapp_opted_in, consent_at FROM crm_contacts');
    // A roster file is not the parent's consent (CRM M2 phase 2, D4).
    expect(contact).toEqual(expect.objectContaining({ school_id: 'sch_a', full_name: 'Ravi', phone_e164: '+919812345621', whatsapp_opted_in: 0 }));
    expect(contact.consent_at).toBeNull();
    const [link] = await rows('SELECT student_id, is_primary, status FROM crm_guardian_links');
    expect(link).toEqual({ student_id: student.id, is_primary: 1, status: 'active' });
  });

  it('reuses one contact for siblings sharing a parent phone', async () => {
    await importRoster([{ displayName: 'Asha', parentPhone: '+91 98123 45621' }, { displayName: 'Arjun', parentPhone: '09812345621' }]);
    expect(await rows('SELECT COUNT(*) AS n FROM crm_contacts')).toEqual([{ n: 1 }]);
    expect(await rows('SELECT COUNT(*) AS n FROM crm_guardian_links WHERE is_primary = 1')).toEqual([{ n: 2 }]);
  });

  it('creates no contact for a missing or invalid phone', async () => {
    await importRoster([{ displayName: 'Asha' }, { displayName: 'Arjun', parentPhone: '123' }]);
    expect(await rows('SELECT COUNT(*) AS n FROM crm_contacts')).toEqual([{ n: 0 }]);
    expect(await rows('SELECT COUNT(*) AS n FROM students')).toEqual([{ n: 2 }]);
  });

  it('allows only one active primary guardian per student, and removing a link keeps the contact', async () => {
    await importRoster([{ displayName: 'Asha', parentPhone: '9812345621' }]);
    const [{ id: studentId }] = await rows('SELECT id FROM students');
    await state.db.execute({ sql: "INSERT INTO crm_contacts (id, school_id, phone_e164, created_at, updated_at) VALUES ('ct_2', 'sch_a', '+919000000000', 'x', 'x')" });
    await expect(state.db.execute({
      sql: "INSERT INTO crm_guardian_links (id, school_id, student_id, contact_id, is_primary, created_at, updated_at) VALUES ('gl_2', 'sch_a', ?, 'ct_2', 1, 'x', 'x')",
      args: [studentId],
    })).rejects.toThrow(/UNIQUE/);
    await state.db.execute("UPDATE crm_guardian_links SET status = 'removed'");
    expect(await rows('SELECT COUNT(*) AS n FROM crm_contacts')).toEqual([{ n: 2 }]);
  });
});

describe('migration 061 backfill of legacy students.parent_*', () => {
  it('copies legacy values once and is safe to re-run', async () => {
    await state.db.execute(`INSERT INTO students (id, school, display_name, school_id, parent_phone, parent_name, parent_whatsapp_opted_in, created_at, updated_at)
      VALUES ('stu_legacy', 'School A', 'Old', 'sch_a', '+919811111111', 'Legacy Parent', 1, 'x', 'x'),
             ('stu_none', 'School A', 'No phone', 'sch_a', NULL, NULL, 0, 'x', 'x')`);
    await state.db.batch(migration061.backfillStatements('2026-09-25T00:00:00.000Z'), 'write');
    await state.db.batch(migration061.backfillStatements('2026-09-26T00:00:00.000Z'), 'write');
    expect(await rows('SELECT id, full_name, phone_e164, whatsapp_opted_in FROM crm_contacts')).toEqual([
      { id: 'ct_legacy_stu_legacy', full_name: 'Legacy Parent', phone_e164: '+919811111111', whatsapp_opted_in: 1 },
    ]);
    expect(await rows('SELECT student_id, is_primary FROM crm_guardian_links')).toEqual([{ student_id: 'stu_legacy', is_primary: 1 }]);
    const contact = await resolveParentContact({ studentId: 'stu_legacy', schoolId: 'sch_a' });
    expect(contact).toEqual(expect.objectContaining({ parentPhone: '+919811111111', optedIn: true }));
  });
});
