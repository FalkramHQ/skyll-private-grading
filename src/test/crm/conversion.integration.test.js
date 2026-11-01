// Pipeline settings and lead → student conversion on real SQLite (migrations
// 059–062 and 064–067) over the canonical roster tables (FLKRM-326 S5).
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

const pipeline = async (actor = admin) => (await call(actor, 'GET', 'settings/pipeline')).body;
const stageByKey = async (key) => (await pipeline()).stages.find((stage) => stage.key === key);
const newLead = async (body = {}) => (await call(admin, 'POST', 'leads', {
  body: { learnerName: 'Meera Nair', learnerGrade: '9', contact: { name: 'Sunita Nair', phone: '98200 11122' }, interest: { course: 'Grade 9 Maths' }, acknowledgeDuplicates: true, ...body },
})).body;
const preview = async (leadId, actor = admin) => call(actor, 'GET', 'leads/conversion', { query: { leadId } });
const convert = async (lead, body = {}, actor = admin) => call(actor, 'POST', 'leads/convert', {
  body: { leadId: lead.id, expectedVersion: lead.version, mode: 'create', batchIds: ['b_math9'], relationship: 'mother', ...body },
});
const count = async (sql, args = []) => Number((await state.db.execute({ sql, args })).rows[0].n);

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-convert-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([
    'CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT)',
    "CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata')",
    'CREATE TABLE school_memberships (id TEXT PRIMARY KEY, school_id TEXT, user_id TEXT, role TEXT, status TEXT)',
    "CREATE TABLE students (id TEXT PRIMARY KEY, school TEXT, school_id TEXT, display_name TEXT, roster_key TEXT, user_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT, updated_at TEXT)",
    "CREATE TABLE batches (id TEXT PRIMARY KEY, school_id TEXT, name TEXT, grade TEXT, academic_year TEXT, academic_year_id TEXT, status TEXT DEFAULT 'active')",
    'CREATE TABLE batch_memberships (id TEXT PRIMARY KEY, batch_id TEXT, student_id TEXT, status TEXT, joined_at TEXT, left_at TEXT, created_at TEXT, updated_at TEXT)',
    'CREATE TABLE academic_years (id TEXT PRIMARY KEY, school_id TEXT, label TEXT, starts_on TEXT, is_current INTEGER DEFAULT 0)',
    'CREATE TABLE student_enrollments (id TEXT PRIMARY KEY, student_id TEXT, academic_year_id TEXT, standard TEXT NOT NULL, status TEXT, created_at TEXT, updated_at TEXT, UNIQUE(student_id, academic_year_id))',
    // Progress tables the student profile reads (empty here).
    'CREATE TABLE subjects (id TEXT PRIMARY KEY, school_id TEXT, name TEXT)',
    'CREATE TABLE exams (id TEXT PRIMARY KEY, school_id TEXT, subject_id TEXT, name TEXT, exam_date TEXT)',
    'CREATE TABLE submissions (id TEXT PRIMARY KEY, exam_id TEXT, student_id TEXT, status TEXT, score REAL, max_marks REAL, review_status TEXT, created_at TEXT)',
    'CREATE TABLE report_versions (id TEXT PRIMARY KEY, submission_id TEXT, status TEXT)',
    ...migrations,
    "INSERT INTO schools (id, display_name, status) VALUES ('sch_a', 'School A', 'active'), ('sch_b', 'School B', 'active')",
    "INSERT INTO users VALUES ('usr_admin', 'Admin A', 'active'), ('usr_admin_b', 'Admin B', 'active'), ('usr_teacher', 'Teacher A', 'active'), ('usr_staff', 'Staff A', 'active')",
    `INSERT INTO school_memberships VALUES ('m1', 'sch_a', 'usr_admin', 'school_admin', 'active'), ('m2', 'sch_b', 'usr_admin_b', 'school_admin', 'active'),
       ('m3', 'sch_a', 'usr_teacher', 'teacher', 'active'), ('m4', 'sch_a', 'usr_staff', 'staff', 'active')`,
    "INSERT INTO academic_years VALUES ('ay_26', 'sch_a', '2026-27', '2026-06-01', 1)",
    `INSERT INTO batches VALUES ('b_math9', 'sch_a', 'Grade 9 Maths', '9', '2026-27', 'ay_26', 'active'),
       ('b_sci9', 'sch_a', 'Grade 9 Science', '9', '2026-27', 'ay_26', 'active'),
       ('b_noyear', 'sch_a', 'Summer camp', NULL, NULL, NULL, 'active'),
       ('b_other', 'sch_b', 'Other school batch', '9', '2026-27', 'ay_b', 'active')`,
    `INSERT INTO students (id, school, school_id, display_name, status, created_at, updated_at) VALUES
       ('stu_riya', 'School A', 'sch_a', 'Riya Nair', 'active', '${T}', '${T}'),
       ('stu_meera_old', 'School A', 'sch_a', 'MEERA  nair', 'inactive', '${T}', '${T}')`,
  ], 'write');
});

describe('CRM pipeline settings (S5)', () => {
  it('adds lead and applicant stages in the right place, never won or lost, with name and version checks', async () => {
    const before = await pipeline();
    const added = await call(admin, 'POST', 'settings/pipeline/stages', { body: { name: 'Demo class booked', category: 'open', expectedVersion: before.version } });
    expect(added.statusCode).toBe(200);
    const names = added.body.stages.map((stage) => stage.name);
    expect(names.indexOf('Demo class booked')).toBe(names.indexOf('Trial scheduled') + 1);
    const applicant = await call(admin, 'POST', 'settings/pipeline/stages', { body: { name: 'Documents pending', category: 'applicant', expectedVersion: added.body.version } });
    const after = applicant.body.stages.map((stage) => stage.name);
    expect(after.indexOf('Documents pending')).toBe(after.indexOf('Payment pending') + 1);
    expect(after.slice(-2)).toEqual(['Enrolled', 'Lost']);

    expect((await call(admin, 'POST', 'settings/pipeline/stages', { body: { name: 'Won again', category: 'won', expectedVersion: applicant.body.version } })).statusCode).toBe(422);
    expect((await call(admin, 'POST', 'settings/pipeline/stages', { body: { name: 'contacted', category: 'open', expectedVersion: applicant.body.version } })).body.error.code).toBe('duplicate_name');
    expect((await call(admin, 'POST', 'settings/pipeline/stages', { body: { name: 'Late', category: 'open', expectedVersion: before.version } })).statusCode).toBe(409);
    expect((await call(teacher, 'POST', 'settings/pipeline/stages', { body: { name: 'X', category: 'open', expectedVersion: applicant.body.version } })).statusCode).toBe(403);
    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'pipeline.changed' ORDER BY id");
    expect(audit.rows.map((row) => JSON.parse(row.summary_json).change)).toEqual(['stage_added', 'stage_added']);
  });

  it('archives a stage, moving its leads with a stage event each; won, lost and the last lead stage stay', async () => {
    const lead = await newLead();
    const contacted = await stageByKey('contacted');
    await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: contacted.id, expectedVersion: 1 } });
    let current = await pipeline();
    expect(current.stages.find((stage) => stage.key === 'contacted').leadCount).toBe(1);

    const noDestination = await call(admin, 'POST', 'settings/pipeline/archive', { body: { stageId: contacted.id, expectedVersion: current.version } });
    expect(noDestination.statusCode).toBe(422);
    const qualified = current.stages.find((stage) => stage.key === 'qualified');
    const archived = await call(admin, 'POST', 'settings/pipeline/archive', { body: { stageId: contacted.id, destinationStageId: qualified.id, expectedVersion: current.version } });
    expect(archived.body.stages.map((stage) => stage.key)).not.toContain('contacted');
    const moved = (await call(admin, 'GET', 'leads/detail', { query: { leadId: lead.id } })).body;
    expect(moved).toEqual(expect.objectContaining({ stage: expect.objectContaining({ name: 'Qualified' }), version: 3 }));
    const events = await state.db.execute({ sql: 'SELECT reason FROM crm_lead_stage_events WHERE lead_id = ? ORDER BY created_at, rowid', args: [lead.id] });
    expect(events.rows.at(-1).reason).toBe('Stage archived: Contacted');
    expect((await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: contacted.id, expectedVersion: 3 } })).statusCode).toBe(404);

    current = await pipeline();
    const won = current.stages.find((stage) => stage.category === 'won');
    expect((await call(admin, 'POST', 'settings/pipeline/archive', { body: { stageId: won.id, expectedVersion: current.version } })).body.error.code).toBe('stage_locked');
    // Archive every lead stage but one; the last can't go.
    const open = current.stages.filter((stage) => stage.category === 'open' && stage.leadCount === 0);
    let version = current.version;
    for (const stage of open.slice(0, -1)) {
      version = (await call(admin, 'POST', 'settings/pipeline/archive', { body: { stageId: stage.id, expectedVersion: version } })).body.version;
    }
    const remaining = (await pipeline()).stages.filter((stage) => stage.category === 'open');
    expect(remaining).toHaveLength(2);
    const emptyOne = remaining.find((stage) => stage.leadCount === 0);
    const qualifiedNow = remaining.find((stage) => stage.leadCount === 1);
    version = (await call(admin, 'POST', 'settings/pipeline/archive', { body: { stageId: emptyOne.id, expectedVersion: version } })).body.version;
    expect((await call(admin, 'POST', 'settings/pipeline/archive', { body: { stageId: qualifiedNow.id, destinationStageId: won.id, expectedVersion: version } })).body.error.code).toBe('last_open_stage');
  });

  it('stores conversion requirements with a version check', async () => {
    const current = await pipeline();
    expect(current.requirements).toEqual({ guardianPhone: false, learnerGrade: false, source: false, applicantStage: false });
    const saved = await call(admin, 'POST', 'settings/pipeline/requirements', { body: { requirements: { guardianPhone: true, learnerGrade: false, source: true, applicantStage: false }, expectedVersion: current.version } });
    expect(saved.body.requirements).toEqual({ guardianPhone: true, learnerGrade: false, source: true, applicantStage: false });
    expect((await call(admin, 'POST', 'settings/pipeline/requirements', { body: { requirements: saved.body.requirements, expectedVersion: current.version } })).statusCode).toBe(409);
    expect((await call(admin, 'POST', 'settings/pipeline/requirements', { body: { requirements: { guardianPhone: true }, expectedVersion: saved.body.version } })).statusCode).toBe(422);
  });
});

describe('CRM conversion (S5)', () => {
  it('previews exact-match candidates, requirements and a suggested batch', async () => {
    // Riya's mother is the lead's contact: a sibling, so a phone match.
    await call(admin, 'POST', 'students/guardians', { body: { studentId: 'stu_riya', contact: { phone: '98200 11122' }, relationship: 'mother' } });
    const lead = await newLead();
    const res = (await preview(lead.id)).body;
    expect(res.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: 'stu_riya', reasons: ['phone'] }),
      expect.objectContaining({ studentId: 'stu_meera_old', reasons: ['name'], status: 'inactive' }),
    ]));
    expect(res.candidates.some((c) => c.name === 'Meera Nair' && c.studentId !== 'stu_meera_old')).toBe(false);
    expect(res.suggestedBatchIds).toEqual(['b_math9']);
    expect(res.batches.find((batch) => batch.id === 'b_noyear')).toEqual(expect.objectContaining({ hasAcademicYear: false }));
    expect(res.batches.some((batch) => batch.id === 'b_other')).toBe(false);
    expect(res).toEqual(expect.objectContaining({ canConvert: true, hasContact: true, requirements: [] }));
  });

  it('creates a new roster-only student only after "no match" is confirmed, with batch, enrollment, guardian and history', async () => {
    const lead = await newLead();
    const blocked = await convert(lead);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body.error.code).toBe('possible_match');
    expect(await count('SELECT COUNT(*) AS n FROM students')).toBe(2);

    const done = await convert(lead, { confirmNoMatch: true });
    expect(done.body).toEqual({ studentId: expect.any(String), mode: 'created', alreadyConverted: false });
    const studentId = done.body.studentId;
    const student = (await state.db.execute({ sql: 'SELECT display_name, user_id, roster_key, status FROM students WHERE id = ?', args: [studentId] })).rows[0];
    expect(student).toEqual({ display_name: 'Meera Nair', user_id: null, roster_key: null, status: 'active' });
    expect(await count("SELECT COUNT(*) AS n FROM batch_memberships WHERE student_id = ? AND batch_id = 'b_math9' AND status = 'active'", [studentId])).toBe(1);
    expect((await state.db.execute({ sql: 'SELECT academic_year_id, standard FROM student_enrollments WHERE student_id = ?', args: [studentId] })).rows)
      .toEqual([{ academic_year_id: 'ay_26', standard: '9' }]);
    const guardians = (await call(admin, 'GET', 'students/guardians', { query: { studentId } })).body.items;
    expect(guardians).toEqual([expect.objectContaining({ relationship: 'mother', isPrimary: true, isFeePayer: true })]);

    const detail = (await call(admin, 'GET', 'students/detail', { query: { studentId } })).body;
    expect(detail).toEqual(expect.objectContaining({ owner: { userId: 'usr_admin', name: 'Admin A' }, convertedFromLead: { id: lead.id, name: 'Meera Nair' }, hasLogin: false }));
    const convertedLead = (await call(admin, 'GET', 'leads/detail', { query: { leadId: lead.id } })).body;
    expect(convertedLead).toEqual(expect.objectContaining({ lifecycle: 'converted', convertedStudentId: studentId, stage: expect.objectContaining({ category: 'won' }) }));
    const timeline = (await call(admin, 'GET', 'timeline', { query: { entityType: 'lead', entityId: lead.id } })).body.items;
    expect(timeline.map((item) => item.kind)).toEqual(expect.arrayContaining(['converted', 'stage', 'created']));
    const audit = await state.db.execute("SELECT action, summary_json FROM crm_audit_events WHERE action IN ('lead.converted', 'guardian.changed')");
    expect(audit.rows.map((row) => [row.action, JSON.parse(row.summary_json).mode || JSON.parse(row.summary_json).change])).toEqual([['lead.converted', 'created'], ['guardian.changed', 'added']]);
  });

  it('is safe to repeat: the same student returns the same result, anything else is refused', async () => {
    const lead = await newLead({ learnerName: 'Tara Nair', contact: { phone: '98200 55566' } });
    const first = await convert(lead, { mode: 'link', studentId: 'stu_riya', batchIds: ['b_sci9'] });
    expect(first.body).toEqual({ studentId: 'stu_riya', mode: 'linked', alreadyConverted: false });
    const again = await convert(lead, { mode: 'link', studentId: 'stu_riya', batchIds: ['b_sci9'] });
    expect(again.body).toEqual({ studentId: 'stu_riya', mode: 'linked', alreadyConverted: true });
    expect((await convert(lead, { confirmNoMatch: true })).body.error).toEqual(expect.objectContaining({ code: 'already_converted', details: { studentId: 'stu_riya' } }));
    expect((await convert(lead, { mode: 'link', studentId: 'stu_meera_old' })).statusCode).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM batch_memberships WHERE student_id = 'stu_riya'")).toBe(1);

    // A student can come from only one lead.
    const other = await newLead({ learnerName: 'Another Nair', contact: { phone: '98200 77788' } });
    expect((await convert(other, { mode: 'link', studentId: 'stu_riya' })).body.error.code).toBe('student_already_linked');
  });

  it('links an existing student: adds batches, keeps the year\'s enrollment, re-admits, and never replaces the primary guardian', async () => {
    await state.db.execute("INSERT INTO student_enrollments VALUES ('e_old', 'stu_meera_old', 'ay_26', '8', 'active', '2026-06-01', '2026-06-01')");
    await call(admin, 'POST', 'students/guardians', { body: { studentId: 'stu_meera_old', contact: { phone: '98200 99900', name: 'Existing Parent' }, relationship: 'father' } });
    const lead = await newLead();
    const res = await convert(lead, { mode: 'link', studentId: 'stu_meera_old', batchIds: ['b_math9', 'b_sci9'] });
    expect(res.body.mode).toBe('linked');
    expect((await state.db.execute("SELECT status FROM students WHERE id = 'stu_meera_old'")).rows[0].status).toBe('active');
    expect(await count("SELECT COUNT(*) AS n FROM batch_memberships WHERE student_id = 'stu_meera_old' AND status = 'active'")).toBe(2);
    expect((await state.db.execute("SELECT standard FROM student_enrollments WHERE student_id = 'stu_meera_old'")).rows).toEqual([{ standard: '8' }]);
    const guardians = (await call(admin, 'GET', 'students/guardians', { query: { studentId: 'stu_meera_old' } })).body.items;
    expect(guardians.map((g) => [g.contact.name, g.isPrimary, g.isFeePayer])).toEqual([['Existing Parent', true, true], ['Sunita Nair', false, false]]);
  });

  it('enforces the school\'s requirements, the batch year, and the version the dialog saw', async () => {
    const current = await pipeline();
    await call(admin, 'POST', 'settings/pipeline/requirements', { body: { requirements: { guardianPhone: true, learnerGrade: false, source: true, applicantStage: true }, expectedVersion: current.version } });
    let lead = await newLead({ learnerName: 'Zoya Khan', contact: { phone: '98200 44455' } });
    expect((await preview(lead.id)).body.requirements.map((item) => [item.key, item.met])).toEqual([['guardianPhone', true], ['source', false], ['applicantStage', false]]);
    const refused = await convert(lead);
    expect(refused.body.error).toEqual(expect.objectContaining({ code: 'requirements_not_met', details: { missing: ['source', 'applicantStage'] } }));

    lead = (await call(admin, 'POST', 'leads/update', { body: { leadId: lead.id, expectedVersion: lead.version, sourceKey: 'referral' } })).body;
    const application = await stageByKey('application');
    lead = (await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: application.id, expectedVersion: lead.version } })).body;
    expect((await convert(lead, { batchIds: ['b_noyear'] })).body.error.code).toBe('academic_year_required');
    expect((await convert(lead, { batchIds: ['b_other'] })).statusCode).toBe(422);
    expect((await convert({ ...lead, version: 1 })).statusCode).toBe(409);
    expect(await count('SELECT COUNT(*) AS n FROM students')).toBe(2);
    expect((await convert(lead)).body.mode).toBe('created');
  });

  it('refuses lost leads, needs both convert and student access, and stays inside the school', async () => {
    const lead = await newLead({ learnerName: 'Kabir Das', contact: { phone: '98200 33344' } });
    await grant('usr_staff', ['crm.access', 'crm.leads.read', 'crm.leads.write', 'crm.leads.convert']);
    expect((await preview(lead.id, staff)).statusCode).toBe(403);
    expect((await convert(lead, {}, staff)).statusCode).toBe(403);
    expect((await convert(lead, {}, teacher)).statusCode).toBe(403);
    expect((await preview(lead.id, otherAdmin)).statusCode).toBe(404);
    expect((await convert(lead, {}, otherAdmin)).statusCode).toBe(404);

    const lost = await stageByKey('lost');
    const lostLead = (await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: lost.id, lostReasonKey: 'price', expectedVersion: lead.version } })).body;
    expect((await preview(lostLead.id)).body.canConvert).toBe(false);
    expect((await convert(lostLead)).body.error.code).toBe('invalid_transition');
  });
});
