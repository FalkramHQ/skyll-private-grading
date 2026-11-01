// Notes, tags and the activity timeline on real SQLite (migrations 059–064):
// who may add, edit and remove; inline tag creation and settings; the merged
// timeline and what it hides; school isolation (FLKRM-326 S3).
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
let lead;

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
      args: [`g_${userId}_${capability}`, 'sch_a', userId, capability, 'usr_admin', now, now],
    });
  }
}

const onLead = (extra = {}) => ({ entityType: 'lead', entityId: lead.id, ...extra });
const addNote = (actor, body, ref = onLead()) => call(actor, 'POST', 'notes', { body: { ...ref, body } });
const notes = async (actor = admin, ref = onLead()) => (await call(actor, 'GET', 'notes', { query: ref })).body.items;
const timeline = async (actor = admin, ref = onLead()) => (await call(actor, 'GET', 'timeline', { query: ref })).body.items;

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-notes-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([
    'CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT, status TEXT)',
    "CREATE TABLE schools (id TEXT PRIMARY KEY, display_name TEXT, status TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata')",
    'CREATE TABLE school_memberships (id TEXT PRIMARY KEY, school_id TEXT, user_id TEXT, role TEXT, status TEXT)',
    "CREATE TABLE students (id TEXT PRIMARY KEY, school_id TEXT, display_name TEXT, status TEXT NOT NULL DEFAULT 'active')",
    'CREATE TABLE batches (id TEXT PRIMARY KEY, school_id TEXT, name TEXT)',
    'CREATE TABLE batch_memberships (id TEXT PRIMARY KEY, batch_id TEXT, student_id TEXT, status TEXT, joined_at TEXT, left_at TEXT)',
    ...migrations,
    "INSERT INTO schools (id, display_name, status) VALUES ('sch_a', 'School A', 'active'), ('sch_b', 'School B', 'active')",
    `INSERT INTO users VALUES ('usr_admin', 'Admin A', 'active'), ('usr_admin_b', 'Admin B', 'active'),
       ('usr_teacher', 'Teacher A', 'active'), ('usr_staff', 'Staff A', 'active')`,
    `INSERT INTO school_memberships VALUES ('m1', 'sch_a', 'usr_admin', 'school_admin', 'active'),
       ('m2', 'sch_b', 'usr_admin_b', 'school_admin', 'active'), ('m3', 'sch_a', 'usr_teacher', 'teacher', 'active'),
       ('m4', 'sch_a', 'usr_staff', 'staff', 'active')`,
    "INSERT INTO students (id, school_id, display_name) VALUES ('stu_a', 'sch_a', 'Riya'), ('stu_b', 'sch_b', 'Other')",
  ], 'write');
  lead = (await call(admin, 'POST', 'leads', { body: { learnerName: 'Meera', note: 'Walked in on Monday' } })).body;
});

describe('CRM notes (real SQLite)', () => {
  it('adds notes with write access only, audits without the text, and marks the lead active', async () => {
    await state.db.execute({ sql: "UPDATE crm_leads SET last_activity_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", args: [lead.id] });
    const res = await addNote(admin, 'Called, asked about fees');
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ body: 'Called, asked about fees', edited: false, canEdit: true, canRemove: true, author: { userId: 'usr_admin', name: 'Admin A' } }));
    const audit = await state.db.execute("SELECT entity_type, entity_id, summary_json FROM crm_audit_events WHERE action = 'note.changed'");
    expect(audit.rows).toEqual([{ entity_type: 'lead', entity_id: lead.id, summary_json: JSON.stringify({ change: 'added', noteId: res.body.id }) }]);
    const touched = await state.db.execute({ sql: 'SELECT last_activity_at FROM crm_leads WHERE id = ?', args: [lead.id] });
    expect(touched.rows[0].last_activity_at > '2020').toBe(true);
    expect((await addNote(admin, '   ')).statusCode).toBe(422);

    await grant('usr_staff', ['crm.access', 'crm.leads.read']);
    expect((await addNote(staff, 'Read-only staff')).statusCode).toBe(403);
    expect((await notes(staff)).map((note) => note.body)).toEqual(['Called, asked about fees', 'Walked in on Monday']);
    expect((await addNote(teacher, 'No lead access')).statusCode).toBe(403);
  });

  it('lets only the author edit, and flags the note as edited', async () => {
    await grant('usr_staff', ['crm.access', 'crm.leads.read', 'crm.leads.write']);
    const note = (await addNote(staff, 'Parent prefers evenings')).body;
    expect((await call(admin, 'POST', 'notes/update', { body: { noteId: note.id, body: 'Rewritten by admin', expectedVersion: 1 } })).statusCode).toBe(403);
    const edited = await call(staff, 'POST', 'notes/update', { body: { noteId: note.id, body: 'Parent prefers weekday evenings', expectedVersion: 1 } });
    expect(edited.body).toEqual(expect.objectContaining({ body: 'Parent prefers weekday evenings', edited: true, version: 2 }));
    expect((await call(staff, 'POST', 'notes/update', { body: { noteId: note.id, body: 'Stale', expectedVersion: 1 } })).statusCode).toBe(409);
    // Admins see the note but can't edit it; they can remove it.
    expect((await notes(admin)).find((item) => item.id === note.id)).toEqual(expect.objectContaining({ canEdit: false, canRemove: true }));
  });

  it('removes softly: the author or an admin, and the timeline says a note was removed', async () => {
    await grant('usr_staff', ['crm.access', 'crm.leads.read', 'crm.leads.write']);
    const staffNote = (await addNote(staff, 'Staff note')).body;
    const adminNote = (await addNote(admin, 'Admin note')).body;
    expect((await call(staff, 'POST', 'notes/remove', { body: { noteId: adminNote.id, expectedVersion: 1 } })).statusCode).toBe(403);
    expect((await call(admin, 'POST', 'notes/remove', { body: { noteId: staffNote.id, expectedVersion: 1 } })).body).toEqual({ id: staffNote.id, removed: true });
    expect((await call(admin, 'POST', 'notes/remove', { body: { noteId: adminNote.id, expectedVersion: 1 } })).statusCode).toBe(200);

    expect((await notes()).map((note) => note.body)).toEqual(['Walked in on Monday']);
    const rows = await state.db.execute({ sql: 'SELECT COUNT(*) AS n FROM crm_notes WHERE entity_id = ? AND archived_at IS NOT NULL', args: [lead.id] });
    expect(rows.rows).toEqual([{ n: 2 }]);
    const items = await timeline();
    expect(items.filter((item) => item.kind === 'note_removed')).toHaveLength(2);
    expect(JSON.stringify(items)).not.toContain('Staff note');
    expect((await call(admin, 'POST', 'notes/remove', { body: { noteId: staffNote.id, expectedVersion: 2 } })).statusCode).toBe(404);
  });

  it('lets anyone who can see a student add notes (D14a), and never across schools', async () => {
    const ref = { entityType: 'student', entityId: 'stu_a' };
    const adminNote = (await addNote(admin, 'Needs extra maths help', ref)).body;
    // A default teacher has student read only: notes yes, tags and owner no.
    const mine = await addNote(teacher, 'Struggles with fractions; paired with a buddy', ref);
    expect(mine.statusCode).toBe(201);
    expect(mine.body).toEqual(expect.objectContaining({ canEdit: true, canRemove: true }));
    const edited = await call(teacher, 'POST', 'notes/update', { body: { noteId: mine.body.id, body: 'Struggles with fractions; paired with Riya', expectedVersion: 1 } });
    expect(edited.body.edited).toBe(true);
    expect((await call(teacher, 'POST', 'notes/update', { body: { noteId: adminNote.id, body: 'Not mine', expectedVersion: 1 } })).statusCode).toBe(403);
    expect((await call(teacher, 'POST', 'notes/remove', { body: { noteId: adminNote.id, expectedVersion: 1 } })).statusCode).toBe(403);
    expect((await call(teacher, 'POST', 'tags/apply', { body: { ...ref, label: 'VIP' } })).statusCode).toBe(403);
    expect((await notes(teacher, ref)).map((note) => note.body)).toEqual(['Struggles with fractions; paired with Riya', 'Needs extra maths help']);
    // Lead notes still need lead write access.
    await grant('usr_staff', ['crm.access', 'crm.leads.read', 'crm.students.read']);
    expect((await addNote(staff, 'Read-only on leads')).statusCode).toBe(403);
    expect((await addNote(staff, 'Front desk: mother called about timings', ref)).statusCode).toBe(201);
    expect((await addNote(admin, 'Other school', { entityType: 'student', entityId: 'stu_b' })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'GET', 'notes', { query: onLead() })).statusCode).toBe(404);
    expect((await addNote(otherAdmin, 'Sneaky')).statusCode).toBe(404);
  });
});

describe('CRM tags (real SQLite)', () => {
  const apply = (actor, extra, ref = onLead()) => call(actor, 'POST', 'tags/apply', { body: { ...ref, ...extra } });

  it('creates a tag inline once, reuses it whatever the case, and audits real changes only', async () => {
    const first = await apply(admin, { label: '  Hot   lead ' });
    expect(first.body.items).toEqual([{ id: expect.any(String), label: 'Hot lead', color: 'gray', archived: false }]);
    const again = await apply(admin, { label: 'HOT LEAD' });
    expect(again.body.items).toHaveLength(1);
    expect((await state.db.execute('SELECT COUNT(*) AS n FROM crm_tags')).rows).toEqual([{ n: 1 }]);
    const audit = await state.db.execute("SELECT action, entity_type, summary_json FROM crm_audit_events WHERE action IN ('record.tagged', 'tag.changed') ORDER BY id");
    expect(audit.rows.map((row) => [row.action, row.entity_type, JSON.parse(row.summary_json).change])).toEqual([
      ['tag.changed', 'tag', 'created'], ['record.tagged', 'lead', 'added'],
    ]);

    const tagId = first.body.items[0].id;
    expect((await call(admin, 'GET', 'leads/detail', { query: { leadId: lead.id } })).body.tags.map((tag) => tag.label)).toEqual(['Hot lead']);
    expect((await call(admin, 'GET', 'leads')).body.items[0].tags.map((tag) => tag.label)).toEqual(['Hot lead']);
    const removed = await call(admin, 'POST', 'tags/remove', { body: onLead({ tagId }) });
    expect(removed.body.items).toEqual([]);
    expect((await call(admin, 'GET', 'tags')).body.items).toEqual([{ id: tagId, label: 'Hot lead', color: 'gray', archived: false, usage: 0 }]);
  });

  it('needs write access on the record to tag it', async () => {
    await grant('usr_staff', ['crm.access', 'crm.leads.read']);
    expect((await apply(staff, { label: 'VIP' })).statusCode).toBe(403);
    expect((await apply(teacher, { label: 'VIP' })).statusCode).toBe(403);
    expect((await apply(admin, { label: 'VIP' }, { entityType: 'student', entityId: 'stu_b' })).statusCode).toBe(404);
    expect((await apply(admin, { label: 'VIP', tagId: 'x' })).statusCode).toBe(422);
  });

  it('manages tags in settings: rename, recolour, archive keeps them on records, restore', async () => {
    const tag = (await call(admin, 'POST', 'settings/tags', { body: { label: 'Sibling discount', color: 'green' } })).body;
    expect(tag).toEqual(expect.objectContaining({ label: 'Sibling discount', color: 'green', usage: 0 }));
    expect((await call(admin, 'POST', 'settings/tags', { body: { label: 'sibling DISCOUNT' } })).statusCode).toBe(422);
    await apply(admin, { tagId: tag.id });
    const other = (await call(admin, 'POST', 'settings/tags', { body: { label: 'Scholarship' } })).body;

    expect((await call(admin, 'POST', 'settings/tags/update', { body: { tagId: other.id, label: 'SIBLING discount' } })).body.error.code).toBe('duplicate_name');
    expect((await call(admin, 'POST', 'settings/tags/update', { body: { tagId: tag.id, label: 'Sibling offer', color: 'teal' } })).body)
      .toEqual({ id: tag.id, label: 'Sibling offer', color: 'teal', archived: false });

    expect((await call(admin, 'POST', 'settings/tags/archive', { body: { tagId: tag.id, archived: true } })).body.archived).toBe(true);
    expect((await call(admin, 'GET', 'leads/detail', { query: { leadId: lead.id } })).body.tags).toEqual([expect.objectContaining({ label: 'Sibling offer', archived: true })]);
    expect((await apply(admin, { tagId: tag.id })).body.error.code).toBe('tag_archived');
    expect((await call(admin, 'GET', 'tags')).body.items.map((item) => item.label)).toEqual(['Scholarship']);
    expect((await call(admin, 'GET', 'tags', { query: { includeArchived: 'true' } })).body.items.map((item) => item.label)).toEqual(['Scholarship', 'Sibling offer']);

    // A new active tag with the archived name blocks restoring the old one.
    await call(admin, 'POST', 'settings/tags', { body: { label: 'Sibling offer' } });
    expect((await call(admin, 'POST', 'settings/tags/archive', { body: { tagId: tag.id, archived: false } })).body.error.code).toBe('duplicate_name');

    const changes = await state.db.execute("SELECT summary_json FROM crm_audit_events WHERE action = 'tag.changed' AND entity_id = ? ORDER BY id", [tag.id]);
    expect(changes.rows.map((row) => JSON.parse(row.summary_json).change)).toEqual(['created', 'renamed', 'recolored', 'archived']);

    await grant('usr_staff', ['crm.access', 'crm.leads.read', 'crm.leads.write']);
    expect((await call(staff, 'POST', 'settings/tags/update', { body: { tagId: other.id, color: 'red' } })).statusCode).toBe(403);
    expect((await call(otherAdmin, 'POST', 'settings/tags/update', { body: { tagId: other.id, color: 'red' } })).statusCode).toBe(404);
    expect((await call(otherAdmin, 'GET', 'tags')).body.items).toEqual([]);
  });
});

describe('CRM timeline (real SQLite)', () => {
  it('merges creation, notes, stage moves, tags, owner changes, edits and tasks, newest first', async () => {
    await grant('usr_staff', ['crm.access', 'crm.leads.read', 'crm.leads.write', 'crm.tasks.read', 'crm.tasks.write']);
    const pipeline = (await call(admin, 'GET', 'settings/pipeline')).body.stages;
    const contacted = pipeline.find((stage) => stage.key === 'contacted');
    await call(admin, 'POST', 'leads/stage', { body: { leadId: lead.id, toStageId: contacted.id, expectedVersion: 1 } });
    await call(admin, 'POST', 'tags/apply', { body: onLead({ label: 'Hot lead' }) });
    await call(admin, 'POST', 'leads/update', { body: { leadId: lead.id, expectedVersion: 2, learnerGrade: '9' } });
    await call(admin, 'POST', 'leads/owner', { body: { leadId: lead.id, ownerUserId: 'usr_staff', expectedVersion: 3, moveOpenTasks: true } });

    const items = await timeline();
    const kinds = items.map((item) => item.kind);
    expect(kinds).toEqual(expect.arrayContaining(['created', 'note', 'stage', 'tag', 'updated', 'owner', 'task']));
    expect(items.map((item) => item.at)).toEqual([...items.map((item) => item.at)].sort().reverse());
    expect(items.find((item) => item.kind === 'owner')).toEqual(expect.objectContaining({ fromName: 'Admin A', toName: 'Staff A', actorName: 'Admin A' }));
    expect(items.find((item) => item.kind === 'tag')).toEqual(expect.objectContaining({ change: 'added', label: 'Hot lead' }));
    expect(items.find((item) => item.kind === 'updated').fields).toEqual(['learnerGrade']);
    expect(items.filter((item) => item.kind === 'task').map((item) => item.event).sort()).toEqual(['created', 'reassigned']);
    expect(items.find((item) => item.kind === 'note')).toEqual(expect.objectContaining({ body: 'Walked in on Monday', actorName: 'Admin A' }));
  });

  it('leaves out task activity for people who cannot see those tasks', async () => {
    await grant('usr_staff', ['crm.access', 'crm.leads.read']);
    const items = await timeline(staff);
    expect(items.some((item) => item.kind === 'task')).toBe(false);
    expect(items.some((item) => item.kind === 'note')).toBe(true);
    expect((await call(teacher, 'GET', 'timeline', { query: onLead() })).statusCode).toBe(403);
    expect((await call(otherAdmin, 'GET', 'timeline', { query: onLead() })).statusCode).toBe(404);
  });

  it('shows a student timeline with notes, tags and tasks', async () => {
    const ref = { entityType: 'student', entityId: 'stu_a' };
    await addNote(admin, 'Joined the weekend batch', ref);
    await call(admin, 'POST', 'tags/apply', { body: { ...ref, label: 'Scholarship' } });
    await call(admin, 'POST', 'tasks', { body: { title: 'Share timetable', dueAt: new Date(Date.now() + 3_600_000).toISOString(), related: { type: 'student', id: 'stu_a' } } });
    expect((await timeline(admin, ref)).map((item) => item.kind).sort()).toEqual(['note', 'tag', 'task']);
  });
});
