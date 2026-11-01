// Students and guardians on real SQLite (migrations 059–065) over the
// canonical roster tables: list and profile, owner, guardian rules (primary,
// fee payer, remove), shared contacts and consent, timeline, and access
// (FLKRM-326 S4).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

const require = createRequire(import.meta.url);
const migrations = ['059_crm_access_audit', '060_crm_pipeline', '061_crm_contacts', '062_crm_leads', '064_crm_lost_reason_key', '065_crm_tasks', '066_crm_guardian_rules', '067_crm_pipeline_requirements']
  .flatMap((name) => require(`../../../scripts/migrations/${name}.cjs`).statements);

const state = vi.hoisted(() => ({ db: null }));
const auth = vi.hoisted(() => ({ database: vi.fn(() => state.db), sessionForRequest: vi.fn() }));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);

const { handleCrmRequest } = await import('../../../server/crm/router.js');

const admin = { user_id: 'usr_admin', username: 'a_admin', role: 'admin', school_id: 'sch_a', school: 'School A' };
const otherAdmin = { user_id: 'usr_admin_b', username: 'b_admin', role: 'admin', school_id: 'sch_b', school: 'School B' };
const teacher = { user_id: 'usr_teacher', username: 'a_teacher', role: 'teacher', school_id: 'sch_a', school: 'School A' };
const staff = { user_id: 'usr_staff', username: 'a_staff', role: 'staff', school_id: 'sch_a', school: 'School A' };

const T = '2026-06-01T00:00:00.000Z';
let dir;

async function call(actor, method, route, { body, query = {} } = {}) {
  auth.sessionForRequest.mockResolvedValue(actor);
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handleCrmRequest({ method, headers: {}, query, body }, res, route.split('/'));
  return res;
}

async function grant(userId, capabilities) {
  for (const capability of capabilities) {
    await state.db.execute({
      sql: 'INSERT INTO crm_capability_grants (id, school_id, user_id, capability, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [`g_${userId}_${capability}`, 'sch_a', userId, capability, 'usr_admin', T, T],
    });
  }
}

const addGuardian = (studentId, phone, extra = {}, actor = admin) => call(actor, 'POST', 'students/guardians', {
  body: { studentId, contact: { phone, name: extra.name, ...(extra.whatsappOptIn !== undefined ? { whatsappOptIn: extra.whatsappOptIn } : {}) }, relationship: extra.relationship || 'mother', ...(extra.isFeePayer !== undefined ? { isFeePayer: extra.isFeePayer } : {}) },
});
const guardians = async (studentId, actor = admin) => (await call(actor, 'GET', 'students/guardians', { query: { studentId } })).body.items;

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-students-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([
    'CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT)',
    "CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata')",
    'CREATE TABLE school_memberships (id TEXT PRIMARY KEY, school_id TEXT, user_id TEXT, role TEXT, status TEXT)',
    "CREATE TABLE students (id TEXT PRIMARY KEY, school_id TEXT, display_name TEXT, roster_key TEXT, user_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT)",
    "CREATE TABLE batches (id TEXT PRIMARY KEY, school_id TEXT, name TEXT, grade TEXT, academic_year TEXT, status TEXT DEFAULT 'active')",
    'CREATE TABLE batch_memberships (id TEXT PRIMARY KEY, batch_id TEXT, student_id TEXT, status TEXT, joined_at TEXT, left_at TEXT)',
    'CREATE TABLE academic_years (id TEXT PRIMARY KEY, school_id TEXT, label TEXT, starts_on TEXT, is_current INTEGER DEFAULT 0)',
    'CREATE TABLE student_enrollments (id TEXT PRIMARY KEY, student_id TEXT, academic_year_id TEXT, standard TEXT, status TEXT)',
    'CREATE TABLE subjects (id TEXT PRIMARY KEY, school_id TEXT, name TEXT)',
    'CREATE TABLE exams (id TEXT PRIMARY KEY, school_id TEXT, subject_id TEXT, name TEXT, exam_date TEXT)',
    'CREATE TABLE submissions (id TEXT PRIMARY KEY, exam_id TEXT, student_id TEXT, status TEXT, score REAL, max_marks REAL, review_status TEXT, created_at TEXT)',
    'CREATE TABLE report_versions (id TEXT PRIMARY KEY, submission_id TEXT, status TEXT)',
    ...migrations,
    "INSERT INTO schools (id, display_name, status) VALUES ('sch_a', 'School A', 'active'), ('sch_b', 'School B', 'active')",
    `INSERT INTO users VALUES ('usr_admin', 'Admin A', 'active'), ('usr_admin_b', 'Admin B', 'active'),
       ('usr_teacher', 'Teacher A', 'active'), ('usr_staff', 'Staff A', 'active')`,
    `INSERT INTO school_memberships VALUES ('m1', 'sch_a', 'usr_admin', 'school_admin', 'active'),
       ('m2', 'sch_b', 'usr_admin_b', 'school_admin', 'active'), ('m3', 'sch_a', 'usr_teacher', 'teacher', 'active'),
       ('m4', 'sch_a', 'usr_staff', 'staff', 'active')`,
    `INSERT INTO students VALUES ('stu_riya', 'sch_a', 'Riya Shah', 'riya01', 'usr_riya', 'active', '${T}'),
       ('stu_arjun', 'sch_a', 'Arjun Shah', NULL, NULL, 'active', '${T}'),
       ('stu_old', 'sch_a', 'Zoya Alumni', NULL, NULL, 'alumni', '${T}'),
       ('stu_gone', 'sch_a', 'Archived Kid', NULL, NULL, 'archived', '${T}'),
       ('stu_b', 'sch_b', 'Other School', NULL, NULL, 'active', '${T}')`,
    `INSERT INTO batches VALUES ('b_math', 'sch_a', 'Grade 9 Maths', '9', '2026-27', 'active'), ('b_old', 'sch_a', 'Grade 8 Science', '8', '2025-26', 'active'),
       ('b_other', 'sch_b', 'B Batch', '9', '2026-27', 'active')`,
    `INSERT INTO batch_memberships VALUES ('bm1', 'b_math', 'stu_riya', 'active', '2026-06-01T00:00:00.000Z', NULL),
       ('bm2', 'b_old', 'stu_riya', 'inactive', '2025-06-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'),
       ('bm3', 'b_math', 'stu_arjun', 'active', '2026-06-01T00:00:00.000Z', NULL)`,
    "INSERT INTO academic_years VALUES ('ay_26', 'sch_a', '2026-27', '2026-06-01', 1), ('ay_25', 'sch_a', '2025-26', '2025-06-01', 0)",
    "INSERT INTO student_enrollments VALUES ('e1', 'stu_riya', 'ay_26', '9', 'active'), ('e2', 'stu_riya', 'ay_25', '8', 'completed')",
    "INSERT INTO subjects VALUES ('sj_math', 'sch_a', 'Mathematics')",
    "INSERT INTO exams VALUES ('ex1', 'sch_a', 'sj_math', 'Unit test 1', '2026-07-10')",
    "INSERT INTO submissions VALUES ('sub1', 'ex1', 'stu_riya', 'graded', 34, 40, 'approved', '2026-07-11T00:00:00.000Z')",
    "INSERT INTO report_versions VALUES ('rv1', 'sub1', 'published')",
  ], 'write');
});

describe('CRM students (real SQLite)', () => {
  it('lists the school\'s own roster with batches, tags and (with contact access) the primary guardian', async () => {
    await addGuardian('stu_riya', '98200 11122', { name: 'Sunita Shah' });
    await call(admin, 'POST', 'tags/apply', { body: { entityType: 'student', entityId: 'stu_riya', label: 'Scholarship' } });
    const list = (await call(admin, 'GET', 'students')).body.items;
    expect(list.map((item) => item.name)).toEqual(['Arjun Shah', 'Riya Shah']);
    expect(list[1]).toEqual(expect.objectContaining({
      status: 'active', lifecycle: 'enrolled', standard: '9', hasLogin: true,
      batches: [{ id: 'b_math', name: 'Grade 9 Maths' }],
      tags: [expect.objectContaining({ label: 'Scholarship' })],
      primaryGuardian: { name: 'Sunita Shah', phone: '+919820011122' },
    }));
    expect((await call(admin, 'GET', 'students', { query: { status: 'alumni' } })).body.items.map((item) => item.name)).toEqual(['Zoya Alumni']);
    expect((await call(admin, 'GET', 'students', { query: { status: 'all' } })).body.items).toHaveLength(3);
    expect((await call(admin, 'GET', 'students', { query: { q: 'riya' } })).body.items.map((item) => item.id)).toEqual(['stu_riya']);
    expect((await call(admin, 'GET', 'students', { query: { batchId: 'b_old' } })).body.items).toEqual([]);

    const teacherList = (await call(teacher, 'GET', 'students')).body.items;
    expect(teacherList[1].primaryGuardian).toBeUndefined();
    expect(JSON.stringify(teacherList)).not.toContain('98200');
    expect((await call(otherAdmin, 'GET', 'students')).body.items.map((item) => item.id)).toEqual(['stu_b']);
  });

  it('shows the profile: current and past batches, enrollments, progress and report link', async () => {
    const detail = (await call(admin, 'GET', 'students/detail', { query: { studentId: 'stu_riya' } })).body;
    expect(detail.batches.map((b) => [b.name, b.status])).toEqual([['Grade 9 Maths', 'active'], ['Grade 8 Science', 'inactive']]);
    expect(detail.enrollments.map((e) => [e.academicYear, e.standard, e.isCurrent])).toEqual([['2026-27', '9', true], ['2025-26', '8', false]]);
    expect(detail.progress).toEqual([expect.objectContaining({ examName: 'Unit test 1', subject: 'Mathematics', score: 34, maxMarks: 40, reportPublished: true })]);
    expect(detail.reportUsername).toBe('riya01');
    expect((await call(admin, 'GET', 'students/detail', { query: { studentId: 'stu_arjun' } })).body.reportUsername).toBeNull();

    await grant('usr_staff', ['crm.access', 'crm.students.read']);
    expect((await call(staff, 'GET', 'students/detail', { query: { studentId: 'stu_riya' } })).body.progress).toBeNull();
    expect((await call(admin, 'GET', 'students/detail', { query: { studentId: 'stu_gone' } })).statusCode).toBe(404);
    expect((await call(admin, 'GET', 'students/detail', { query: { studentId: 'stu_b' } })).statusCode).toBe(404);
  });

  it('sets a CRM owner, creating the profile once, with version checks and audit', async () => {
    const first = await call(admin, 'POST', 'students/owner', { body: { studentId: 'stu_arjun', ownerUserId: 'usr_teacher', expectedVersion: 0 } });
    expect(first.body).toEqual(expect.objectContaining({ owner: { userId: 'usr_teacher', name: 'Teacher A' }, version: 1 }));
    expect((await call(admin, 'POST', 'students/owner', { body: { studentId: 'stu_arjun', ownerUserId: 'usr_admin', expectedVersion: 0 } })).statusCode).toBe(409);
    expect((await call(admin, 'POST', 'students/owner', { body: { studentId: 'stu_arjun', ownerUserId: 'usr_admin', expectedVersion: 1 } })).body.version).toBe(2);
    expect((await call(admin, 'POST', 'students/owner', { body: { studentId: 'stu_arjun', ownerUserId: 'usr_staff', expectedVersion: 2 } })).body.error.code).toBe('invalid_owner');
    expect((await call(teacher, 'POST', 'students/owner', { body: { studentId: 'stu_arjun', ownerUserId: 'usr_teacher', expectedVersion: 2 } })).statusCode).toBe(403);
    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'student.owner_changed' ORDER BY id");
    expect(audit.rows.map((row) => JSON.parse(row.summary_json).toOwnerUserId)).toEqual(['usr_teacher', 'usr_admin']);
  });
});

describe('CRM guardians (real SQLite)', () => {
  it('makes the first guardian primary and fee payer, and later ones neither', async () => {
    const mother = await addGuardian('stu_riya', '98200 11122', { name: 'Sunita Shah', whatsappOptIn: true });
    expect(mother.statusCode).toBe(201);
    expect(mother.body.guardian).toEqual(expect.objectContaining({ relationship: 'mother', isPrimary: true, isFeePayer: true, isEmergency: false }));
    expect(mother.body.guardian.contact).toEqual(expect.objectContaining({ whatsappOptIn: true, consentSource: 'staff', consentAt: expect.any(String) }));
    const father = (await addGuardian('stu_riya', '98200 33344', { name: 'Raj Shah', relationship: 'father' })).body.guardian;
    expect(father).toEqual(expect.objectContaining({ isPrimary: false, isFeePayer: false }));
    expect((await addGuardian('stu_riya', '9820011122')).body.error.code).toBe('already_guardian');
    expect((await guardians('stu_riya')).map((g) => g.contact.name)).toEqual(['Sunita Shah', 'Raj Shah']);
  });

  it('reuses one contact for siblings and says who else they look after', async () => {
    await addGuardian('stu_riya', '98200 11122', { name: 'Sunita Shah' });
    const sibling = await addGuardian('stu_arjun', '+91 98200 11122');
    expect(sibling.body.reusedContact).toEqual({ name: 'Sunita Shah' });
    expect((await state.db.execute('SELECT COUNT(*) AS n FROM crm_contacts')).rows).toEqual([{ n: 1 }]);
    expect((await guardians('stu_riya'))[0].alsoGuardianOf).toEqual([{ studentId: 'stu_arjun', name: 'Arjun Shah' }]);
  });

  it('swaps primary and fee payer atomically, and a stale swap changes nothing', async () => {
    const mother = (await addGuardian('stu_riya', '98200 11122')).body.guardian;
    const father = (await addGuardian('stu_riya', '98200 33344', { relationship: 'father' })).body.guardian;
    const stale = await call(admin, 'POST', 'students/guardians/primary', { body: { linkId: father.linkId, expectedVersion: 9 } });
    expect(stale.statusCode).toBe(409);
    expect((await guardians('stu_riya')).map((g) => g.isPrimary)).toEqual([true, false]);

    const swapped = await call(admin, 'POST', 'students/guardians/primary', { body: { linkId: father.linkId, expectedVersion: father.version } });
    expect(swapped.body.isPrimary).toBe(true);
    const after = await guardians('stu_riya');
    expect(after.filter((g) => g.isPrimary).map((g) => g.contact.phone)).toEqual(['+919820033344']);

    const fee = await call(admin, 'POST', 'students/guardians/update', { body: { linkId: father.linkId, expectedVersion: swapped.body.version, isFeePayer: true, isEmergency: true } });
    expect(fee.body).toEqual(expect.objectContaining({ isFeePayer: true, isEmergency: true }));
    expect((await guardians('stu_riya')).filter((g) => g.isFeePayer)).toHaveLength(1);
    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'guardian.changed' ORDER BY id");
    expect(audit.rows.map((row) => JSON.parse(row.summary_json).change)).toEqual(['added', 'added', 'primary_changed', 'updated']);
    expect(JSON.stringify(audit.rows)).not.toContain('98200');
    expect(mother.linkId).toBeTruthy();
  });

  it('refuses to remove the primary while others remain; removing keeps the contact; re-adding restores the link', async () => {
    const mother = (await addGuardian('stu_riya', '98200 11122')).body.guardian;
    const father = (await addGuardian('stu_riya', '98200 33344', { relationship: 'father' })).body.guardian;
    expect((await call(admin, 'POST', 'students/guardians/remove', { body: { linkId: mother.linkId, expectedVersion: mother.version } })).body.error.code).toBe('primary_required');
    expect((await call(admin, 'POST', 'students/guardians/remove', { body: { linkId: father.linkId, expectedVersion: father.version } })).body).toEqual({ linkId: father.linkId, removed: true });
    expect((await guardians('stu_riya'))).toHaveLength(1);
    expect((await state.db.execute('SELECT COUNT(*) AS n FROM crm_contacts')).rows).toEqual([{ n: 2 }]);

    const back = await addGuardian('stu_riya', '98200 33344', { relationship: 'father' });
    expect(back.body.guardian.linkId).toBe(father.linkId);
    // The last remaining guardian can be removed.
    await call(admin, 'POST', 'students/guardians/remove', { body: { linkId: back.body.guardian.linkId, expectedVersion: back.body.guardian.version } });
    const last = (await guardians('stu_riya'))[0];
    expect((await call(admin, 'POST', 'students/guardians/remove', { body: { linkId: last.linkId, expectedVersion: last.version } })).statusCode).toBe(200);
    expect(await guardians('stu_riya')).toEqual([]);
  });

  it('edits a shared contact once for every child, records consent, and refuses phone clashes', async () => {
    const mother = (await addGuardian('stu_riya', '98200 11122', { name: 'Sunita', whatsappOptIn: true })).body.guardian;
    await addGuardian('stu_arjun', '98200 11122');
    await addGuardian('stu_arjun', '98200 55566', { relationship: 'father' });
    const contact = mother.contact;
    const res = await call(admin, 'POST', 'contacts/update', {
      body: { contactId: contact.id, expectedVersion: contact.version, name: 'Sunita Shah', email: 'sunita@example.com', preferredChannel: 'call', whatsappOptIn: false },
    });
    expect(res.body.updated).toEqual(['name', 'email', 'preferredChannel', 'whatsappOptIn']);
    const seenOnSibling = (await guardians('stu_arjun'))[0].contact;
    expect(seenOnSibling).toEqual(expect.objectContaining({ name: 'Sunita Shah', email: 'sunita@example.com', preferredChannel: 'call', whatsappOptIn: false, consentAt: null, consentSource: 'staff' }));
    expect((await call(admin, 'POST', 'contacts/update', { body: { contactId: contact.id, expectedVersion: contact.version, name: 'Stale' } })).statusCode).toBe(409);
    expect((await call(admin, 'POST', 'contacts/update', { body: { contactId: contact.id, expectedVersion: seenOnSibling.version, phone: '98200 55566' } })).body.error.code).toBe('duplicate_contact');
    expect((await call(admin, 'POST', 'contacts/update', { body: { contactId: contact.id, expectedVersion: seenOnSibling.version, email: 'not-an-email' } })).statusCode).toBe(422);
    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'contact.updated'");
    expect(audit.rows[0].summary_json).not.toContain('sunita@');
  });

  it('keeps guardians behind contact access and inside the school', async () => {
    const mother = (await addGuardian('stu_riya', '98200 11122')).body.guardian;
    expect((await call(teacher, 'GET', 'students/guardians', { query: { studentId: 'stu_riya' } })).statusCode).toBe(403);
    await grant('usr_staff', ['crm.access', 'crm.students.read', 'crm.contacts.read']);
    expect((await guardians('stu_riya', staff))).toHaveLength(1);
    expect((await addGuardian('stu_riya', '98200 77788', {}, staff)).statusCode).toBe(403);
    expect((await call(staff, 'POST', 'contacts/update', { body: { contactId: mother.contact.id, expectedVersion: 1, name: 'X' } })).statusCode).toBe(403);
    expect((await call(otherAdmin, 'GET', 'students/guardians', { query: { studentId: 'stu_riya' } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'POST', 'students/guardians/remove', { body: { linkId: mother.linkId, expectedVersion: 1 } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'POST', 'contacts/update', { body: { contactId: mother.contact.id, expectedVersion: 1, name: 'X' } })).statusCode).toBe(404);
    expect((await addGuardian('stu_b', '98200 11122')).statusCode).toBe(404);
  });

  it('puts batches, guardians and owner changes on the student timeline, naming guardians only for contact access', async () => {
    await addGuardian('stu_riya', '98200 11122', { name: 'Sunita Shah' });
    await call(admin, 'POST', 'students/owner', { body: { studentId: 'stu_riya', ownerUserId: 'usr_teacher', expectedVersion: 0 } });
    const items = (await call(admin, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_riya' } })).body.items;
    expect(items.map((item) => item.kind)).toEqual(expect.arrayContaining(['guardian', 'owner', 'batch']));
    expect(items.find((item) => item.kind === 'guardian')).toEqual(expect.objectContaining({ change: 'added', guardianName: 'Sunita Shah' }));
    expect(items.filter((item) => item.kind === 'batch').map((item) => `${item.change} ${item.batchName}`)).toEqual([
      'joined Grade 9 Maths', 'left Grade 8 Science', 'joined Grade 8 Science',
    ]);
    const teacherItems = (await call(teacher, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_riya' } })).body.items;
    const guardianItem = teacherItems.find((item) => item.kind === 'guardian');
    expect(guardianItem.guardianName).toBeUndefined();
    expect(guardianItem.contactId).toBeUndefined();
    expect(JSON.stringify(teacherItems)).not.toContain('Sunita');
  });
});
