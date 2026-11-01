// Leads foundation on real SQLite (migrations 059–062): creation into the first
// open stage, the stage-move contract, contact-data separation, and scope.
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
  const now = new Date().toISOString();
  for (const capability of capabilities) {
    await state.db.execute({
      sql: 'INSERT INTO crm_capability_grants (id, school_id, user_id, capability, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [`g_${capability}`, 'sch_a', userId, capability, 'usr_admin', now, now],
    });
  }
}

// Most tests reuse one family, so they acknowledge the duplicate warning;
// the duplicate tests below pass `acknowledgeDuplicates: undefined`.
async function newLead(body = {}, actor = admin) {
  return call(actor, 'POST', 'leads', { body: { learnerName: 'Meera', learnerGrade: '9', sourceKey: 'referral', contact: { name: 'Sunita', phone: '98200 11122' }, acknowledgeDuplicates: true, ...body } });
}

async function stages(actor = admin) {
  const pipeline = (await call(actor, 'GET', 'settings/pipeline')).body;
  return Object.fromEntries(pipeline.stages.map((stage) => [stage.key, stage]));
}

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-leads-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([
    'CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT)',
    "CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata')",
    'CREATE TABLE school_memberships (id TEXT PRIMARY KEY, school_id TEXT, user_id TEXT, role TEXT, status TEXT)',
    "CREATE TABLE students (id TEXT PRIMARY KEY, school_id TEXT, display_name TEXT, status TEXT NOT NULL DEFAULT 'active')",
    ...migrations,
    `INSERT INTO users VALUES ('usr_admin', 'Admin A', 'active'), ('usr_admin_b', 'Admin B', 'active'),
       ('usr_teacher', 'Teacher A', 'active'), ('usr_staff', 'Staff A', 'active'), ('usr_gone', 'Former A', 'active')`,
    `INSERT INTO school_memberships VALUES ('m1', 'sch_a', 'usr_admin', 'school_admin', 'active'),
       ('m2', 'sch_b', 'usr_admin_b', 'school_admin', 'active'), ('m3', 'sch_a', 'usr_teacher', 'teacher', 'active'),
       ('m4', 'sch_a', 'usr_staff', 'staff', 'active'), ('m5', 'sch_a', 'usr_gone', 'staff', 'disabled')`,
  ], 'write');
});

describe('CRM leads (real SQLite)', () => {
  it('creates a lead in the first open stage, owned by the creator, with its first stage event', async () => {
    const res = await newLead({ note: 'Asked about weekend batches' });
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      learnerName: 'Meera',
      lifecycle: 'lead',
      stage: expect.objectContaining({ name: 'New inquiry', category: 'open' }),
      source: { key: 'referral', label: 'Referral' },
      ownerUserId: 'usr_admin',
      contact: expect.objectContaining({ name: 'Sunita', phone: '+919820011122' }),
      version: 1,
    }));
    const events = await state.db.execute('SELECT from_stage_id, to_stage_id FROM crm_lead_stage_events');
    expect(events.rows).toEqual([{ from_stage_id: null, to_stage_id: res.body.stage.id }]);
    expect((await state.db.execute('SELECT entity_type, body FROM crm_notes')).rows).toEqual([{ entity_type: 'lead', body: 'Asked about weekend batches' }]);
  });

  it('requires a contact or a note, validates phones, and rejects unknown fields', async () => {
    expect((await call(admin, 'POST', 'leads', { body: { learnerName: 'Meera' } })).statusCode).toBe(422);
    expect((await newLead({ contact: { phone: '12345678' } })).statusCode).toBe(422);
    expect((await newLead({ schoolId: 'sch_b' })).statusCode).toBe(422);
    expect((await newLead({ stageId: 'anything' })).statusCode).toBe(422);
  });

  it('reuses the contact when the same parent enquires twice', async () => {
    await newLead();
    await newLead({ learnerName: 'Meera’s brother' });
    expect((await state.db.execute('SELECT COUNT(*) AS n FROM crm_contacts')).rows).toEqual([{ n: 1 }]);
  });

  it('moves through open → applicant → lost (reason required) → reopened, auditing each move', async () => {
    const s = await stages();
    let lead = (await newLead()).body;
    lead = (await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.contacted.id, expectedVersion: 1 } })).body;
    lead = (await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.application.id, expectedVersion: 2 } })).body;
    expect(lead.lifecycle).toBe('applicant');

    const noReason = await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.lost.id, reason: 'free text is not enough', expectedVersion: 3 } });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.body.error.code).toBe('reason_required');

    lead = (await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.lost.id, lostReasonKey: 'another_institute', reason: 'Chose another centre', expectedVersion: 3 } })).body;
    expect(lead).toEqual(expect.objectContaining({ lifecycle: 'lost', lostReasonKey: 'another_institute', lostReason: 'Chose another centre' }));
    lead = (await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.new_inquiry.id, expectedVersion: 4 } })).body;
    expect(lead).toEqual(expect.objectContaining({ lifecycle: 'lead', lostReasonKey: null, lostReason: null }));

    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'lead.stage_changed' ORDER BY id");
    expect(audit.rows.map((row) => JSON.parse(row.summary_json).toCategory)).toEqual(['open', 'applicant', 'lost', 'open']);
    const events = await state.db.execute('SELECT reason FROM crm_lead_stage_events ORDER BY created_at, rowid');
    expect(events.rows.map((row) => row.reason)).toEqual([null, null, null, 'Chose another institute: Chose another centre', null]);
  });

  it('never lets a stage move reach Enrolled; only conversion (CRM-011) may', async () => {
    const s = await stages();
    const lead = (await newLead()).body;
    const res = await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.enrolled.id, expectedVersion: 1 } });
    expect(res.statusCode).toBe(422);
    expect(res.body.error.code).toBe('invalid_transition');
    expect((await state.db.execute("SELECT COUNT(*) AS n FROM crm_audit_events WHERE action = 'lead.stage_changed'")).rows).toEqual([{ n: 0 }]);
  });

  it('returns 409 for a stale version and changes nothing', async () => {
    const s = await stages();
    const lead = (await newLead()).body;
    await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.contacted.id, expectedVersion: 1 } });
    const stale = await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.qualified.id, expectedVersion: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.body.error.details).toEqual({ currentVersion: 2 });
    expect((await state.db.execute('SELECT COUNT(*) AS n FROM crm_lead_stage_events')).rows).toEqual([{ n: 2 }]);
  });

  it('keeps leads inside their school', async () => {
    const lead = (await newLead()).body;
    const theirStages = await stages(otherAdmin);
    expect((await call(otherAdmin, 'GET', 'leads')).body.items).toEqual([]);
    expect((await call(otherAdmin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: theirStages.contacted.id, expectedVersion: 1 } })).statusCode).toBe(404);
    // Our lead cannot be moved into another school's stage either.
    expect((await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: theirStages.contacted.id, expectedVersion: 1 } })).statusCode).toBe(404);
  });

  it('separates contact data: lead access alone never shows or records phone numbers', async () => {
    await newLead();
    await grant('usr_staff', ['crm.access', 'crm.leads.read', 'crm.leads.write']);
    const list = await call(staff, 'GET', 'leads');
    expect(list.statusCode).toBe(200);
    expect(list.body.items[0]).toEqual(expect.objectContaining({ hasContact: true, contact: null }));
    expect(JSON.stringify(list.body)).not.toContain('98200');
    expect((await call(staff, 'POST', 'leads', { body: { learnerName: 'Kiran', contact: { phone: '9820000000' } } })).statusCode).toBe(403);
    // The duplicate check can't be used to probe phone numbers either.
    const probe = await call(staff, 'GET', 'leads/duplicates', { query: { phone: '98200 11122' } });
    expect(probe.body.matches).toEqual([]);
    expect((await call(staff, 'POST', 'leads', { body: { learnerName: 'Kiran', note: 'Walked in, will call back' } })).statusCode).toBe(201);
  });

  it('keeps teachers out of leads entirely', async () => {
    expect((await call(teacher, 'GET', 'leads')).statusCode).toBe(403);
    expect((await call(teacher, 'POST', 'leads', { body: { learnerName: 'X', note: 'y' } })).statusCode).toBe(403);
  });

  it('pages leads newest first and filters by stage', async () => {
    for (const name of ['A', 'B', 'C']) await newLead({ learnerName: name });
    const first = await call(admin, 'GET', 'leads', { query: { limit: '2' } });
    expect(first.body.items.map((lead) => lead.learnerName)).toEqual(['C', 'B']);
    const second = await call(admin, 'GET', 'leads', { query: { limit: '2', cursor: first.body.nextCursor } });
    expect(second.body).toEqual(expect.objectContaining({ nextCursor: null }));
    expect(second.body.items.map((lead) => lead.learnerName)).toEqual(['A']);
    const s = await stages();
    expect((await call(admin, 'GET', 'leads', { query: { stageId: s.lost.id } })).body.items).toEqual([]);
  });

  it('makes stage history append-only', async () => {
    await newLead();
    await expect(state.db.execute("UPDATE crm_lead_stage_events SET reason = 'x'")).rejects.toThrow(/append-only/);
    await expect(state.db.execute('DELETE FROM crm_lead_stage_events')).rejects.toThrow(/append-only/);
  });
});

describe('CRM leads workspace (FLKRM-326 S1)', () => {
  async function addStudent(id, name, school = 'sch_a', phone = null) {
    await state.db.execute({ sql: 'INSERT INTO students (id, school_id, display_name) VALUES (?, ?, ?)', args: [id, school, name] });
    if (phone) {
      const now = new Date().toISOString();
      await state.db.batch([
        { sql: 'INSERT INTO crm_contacts (id, school_id, phone_e164, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', args: [`ct_${id}`, school, phone, now, now] },
        { sql: 'INSERT INTO crm_guardian_links (id, school_id, student_id, contact_id, is_primary, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', args: [`gl_${id}`, school, id, `ct_${id}`, now, now] },
      ], 'write');
    }
  }

  it('warns about the same phone or exact name, and creates only when acknowledged', async () => {
    const first = (await newLead({ acknowledgeDuplicates: undefined })).body;
    await addStudent('stu_riya', 'Riya  Shah', 'sch_a', '+919820011122');

    const warned = await newLead({ learnerName: 'riya shah', acknowledgeDuplicates: undefined });
    expect(warned.statusCode).toBe(409);
    expect(warned.body.error.code).toBe('duplicate_warning');
    const matches = warned.body.error.details.matches;
    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'lead', id: first.id, reasons: ['phone'], stage: expect.objectContaining({ name: 'New inquiry' }) }),
      expect.objectContaining({ kind: 'student', id: 'stu_riya', reasons: ['phone', 'name'] }),
    ]));
    // Matches carry the reason only, never the phone number.
    expect(JSON.stringify(matches)).not.toContain('9820011122');
    expect((await state.db.execute('SELECT COUNT(*) AS n FROM crm_leads')).rows).toEqual([{ n: 1 }]);

    const created = await newLead({ learnerName: 'riya shah' });
    expect(created.statusCode).toBe(201);
    const audit = await state.db.execute("SELECT entity_id, summary_json FROM crm_audit_events WHERE action = 'lead.created' ORDER BY id");
    expect(audit.rows.map((row) => JSON.parse(row.summary_json).duplicateOverride)).toEqual([false, true]);
  });

  it('never treats similar names as duplicates, and ignores other schools', async () => {
    await addStudent('stu_1', 'Aarav Shah');
    await addStudent('stu_b', 'Meera', 'sch_b', '+919820011122');
    const check = await call(admin, 'GET', 'leads/duplicates', { query: { learnerName: 'Aarav Sha', phone: '9820011122' } });
    expect(check.body.matches).toEqual([]);
    const exact = await call(admin, 'GET', 'leads/duplicates', { query: { learnerName: 'AARAV-shah' } });
    expect(exact.body.matches).toEqual([expect.objectContaining({ kind: 'student', id: 'stu_1', reasons: ['name'] })]);
  });

  it('records lost reasons as keys; Other needs a note', async () => {
    const s = await stages();
    const lead = (await newLead()).body;
    const other = await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.lost.id, lostReasonKey: 'other', expectedVersion: 1 } });
    expect(other.statusCode).toBe(422);
    const wrongStage = await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.contacted.id, lostReasonKey: 'price', expectedVersion: 1 } });
    expect(wrongStage.statusCode).toBe(422);
    const lost = await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.lost.id, lostReasonKey: 'price', expectedVersion: 1 } });
    expect(lost.body).toEqual(expect.objectContaining({ lifecycle: 'lost', lostReasonKey: 'price', lostReason: null }));
    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'lead.stage_changed'");
    expect(JSON.parse(audit.rows[0].summary_json)).toEqual(expect.objectContaining({ toCategory: 'lost', lostReasonKey: 'price' }));
  });

  it('assigns owners only to active members who can work leads', async () => {
    const lead = (await newLead()).body;
    expect(lead.owner).toEqual({ userId: 'usr_admin', name: 'Admin A' });

    const owners = (await call(admin, 'GET', 'leads/owners')).body.items.map((item) => item.userId);
    expect(owners).toEqual(['usr_admin']);
    await grant('usr_staff', ['crm.access', 'crm.leads.read', 'crm.leads.write']);
    expect((await call(admin, 'GET', 'leads/owners')).body.items.map((item) => item.userId)).toEqual(['usr_admin', 'usr_staff']);

    for (const bad of ['usr_teacher', 'usr_gone', 'usr_admin_b', 'nobody']) {
      const res = await call(admin, 'POST', 'leads/owner', { body: { leadId: lead.id, ownerUserId: bad, expectedVersion: 1 } });
      expect(res.statusCode).toBe(422);
      expect(res.body.error.code).toBe('invalid_owner');
    }
    const moved = await call(admin, 'POST', 'leads/owner', { body: { leadId: lead.id, ownerUserId: 'usr_staff', expectedVersion: 1 } });
    expect(moved.body).toEqual(expect.objectContaining({ owner: { userId: 'usr_staff', name: 'Staff A' }, version: 2 }));
    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'lead.owner_changed'");
    expect(JSON.parse(audit.rows[0].summary_json)).toEqual({ fromOwnerUserId: 'usr_admin', toOwnerUserId: 'usr_staff' });

    // A disabled owner shows as unowned until reassigned.
    await state.db.execute("UPDATE school_memberships SET status = 'disabled' WHERE user_id = 'usr_staff'");
    expect((await call(admin, 'GET', 'leads/detail', { query: { leadId: lead.id } })).body.owner).toBeNull();

    expect((await newLead({ learnerName: 'Tanvi', ownerUserId: 'usr_teacher' })).statusCode).toBe(422);
  });

  it('edits lead details with a field-only audit, and shows history and notes on the profile', async () => {
    const s = await stages();
    const lead = (await newLead({ note: 'Prefers mornings', interest: { course: 'JEE foundation' } })).body;
    expect(lead.interest).toEqual({ course: 'JEE foundation', schedule: null });
    await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: s.contacted.id, expectedVersion: 1 } });

    const updated = await call(admin, 'POST', 'leads/update', { body: { leadId: lead.id, expectedVersion: 2, learnerGrade: '10', interest: { course: 'JEE', schedule: 'Weekends' } } });
    expect(updated.body).toEqual(expect.objectContaining({ learnerGrade: '10', interest: { course: 'JEE', schedule: 'Weekends' }, version: 3 }));
    expect((await call(admin, 'POST', 'leads/update', { body: { leadId: lead.id, expectedVersion: 2, learnerGrade: '11' } })).statusCode).toBe(409);
    const audit = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'lead.updated'");
    expect(JSON.parse(audit.rows[0].summary_json)).toEqual({ fields: ['learnerGrade', 'interest'] });

    // History and notes moved to the timeline and notes endpoints in S3.
    const timeline = (await call(admin, 'GET', 'timeline', { query: { entityType: 'lead', entityId: lead.id } })).body.items;
    const moves = timeline.filter((item) => item.kind === 'stage' || item.kind === 'created');
    expect(moves.map((item) => item.to.name)).toEqual(['Contacted', 'New inquiry']);
    expect(moves[0]).toEqual(expect.objectContaining({ from: { name: 'New inquiry', category: 'open' }, actorName: 'Admin A' }));
    const notes = (await call(admin, 'GET', 'notes', { query: { entityType: 'lead', entityId: lead.id } })).body.items;
    expect(notes).toEqual([expect.objectContaining({ body: 'Prefers mornings', author: { userId: 'usr_admin', name: 'Admin A' } })]);
  });

  it('searches by learner name', async () => {
    await newLead({ learnerName: 'Ishaan' });
    await newLead({ learnerName: 'Kabir' });
    const res = await call(admin, 'GET', 'leads', { query: { q: 'shaa' } });
    expect(res.body.items.map((lead) => lead.learnerName)).toEqual(['Ishaan']);
    expect((await call(admin, 'GET', 'leads', { query: { q: '%' } })).body.items).toEqual([]);
  });

  it('keeps every new lead route inside its school', async () => {
    const lead = (await newLead()).body;
    expect((await call(otherAdmin, 'GET', 'leads/detail', { query: { leadId: lead.id } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'POST', 'leads/update', { body: { leadId: lead.id, expectedVersion: 1, learnerGrade: '1' } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'POST', 'leads/owner', { body: { leadId: lead.id, ownerUserId: 'usr_admin_b', expectedVersion: 1 } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'GET', 'leads/duplicates', { query: { learnerName: 'Meera', phone: '9820011122' } })).body.matches).toEqual([]);
    expect((await call(otherAdmin, 'GET', 'leads/owners')).body.items.map((item) => item.userId)).toEqual(['usr_admin_b']);
    expect((await call(teacher, 'GET', 'leads/detail', { query: { leadId: lead.id } })).statusCode).toBe(403);
  });
});
