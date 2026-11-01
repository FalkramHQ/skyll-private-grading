// @vitest-environment node
// The Communications page on real SQLite (CRM M2 phase 2 S5, D8/D9/D11):
// history with filters, replies (matched and unknown), and group notices.
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import process from 'node:process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { WA_TEMPLATES, metaTemplateName } from '../../../shared/crm/waTemplates.js';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, COMMS_MIGRATIONS, CRM_MIGRATIONS, FEES_MIGRATIONS, SEED, T, actors, auditRows, grant, makeCaller, migrationStatements,
} from './classesHarness.js';

const state = vi.hoisted(() => ({ db: null }));
const auth = vi.hoisted(() => ({
  database: vi.fn(() => state.db),
  sessionForRequest: vi.fn(),
  ensureAuthTables: vi.fn(async () => undefined),
  requireUser: vi.fn(),
}));
const flags = vi.hoisted(() => ({ isSchoolFeatureEnabled: vi.fn(async () => true) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);

const { handleCrmRequest } = await import('../../../server/crm/router.js');
const call = makeCaller(auth, handleCrmRequest);
const { admin, teacher, staff } = actors;

let dir;

async function seed(db) {
  await db.batch([
    `INSERT INTO crm_contacts (id, school_id, full_name, phone_e164, whatsapp_opted_in, consent_at, consent_source, created_at, updated_at) VALUES
       ('ct_kavita', 'sch_a', 'Kavita Sharma', '+919800000001', 1, '${T}', 'staff', '${T}', '${T}'),
       ('ct_rohit', 'sch_a', 'Rohit Sharma', '+919800000002', 1, '${T}', 'staff', '${T}', '${T}'),
       ('ct_nope', 'sch_a', 'No Consent', '+919800000003', 0, NULL, NULL, '${T}', '${T}'),
       ('ct_lead', 'sch_a', 'Lead Parent', '+919800000004', 1, '${T}', 'public_form', '${T}', '${T}')`,
    // Kavita is the guardian of Anaya and Arjun (both in Grade 10 Maths); Rohit is Arjun's father; Diya's guardian hasn't consented.
    `INSERT INTO crm_guardian_links (id, school_id, student_id, contact_id, is_primary, is_fee_payer, created_at, updated_at) VALUES
       ('gl_1', 'sch_a', 'stu_1', 'ct_kavita', 1, 1, '${T}', '${T}'),
       ('gl_2', 'sch_a', 'stu_2', 'ct_kavita', 1, 1, '${T}', '${T}'),
       ('gl_3', 'sch_a', 'stu_2', 'ct_rohit', 0, 0, '${T}', '${T}'),
       ('gl_4', 'sch_a', 'stu_3', 'ct_nope', 1, 1, '${T}', '${T}')`,
    "INSERT INTO batch_memberships VALUES ('bm_3', 'b_sci9', 'stu_3', 'active', '" + T + "', NULL, '" + T + "', '" + T + "')",
    `INSERT INTO crm_leads (id, school_id, pipeline_id, stage_id, primary_contact_id, learner_name, last_activity_at, created_at, updated_at)
       VALUES ('lead_1', 'sch_a', 'pl_a', 'st_a', 'ct_lead', 'Ishaan', '${T}', '${T}', '${T}')`,
    `INSERT INTO crm_wa_connections (id, school_id, provider, mode, status, waba_id, phone_number_id, display_phone, verified_name, token_enc, connected_at, created_at, updated_at)
       VALUES ('wac_a', 'sch_a', 'meta', 'manual', 'connected', '4440001', '5550001', '+91 98200 11122', 'School A', 'v1.x.y.z', '${T}', '${T}', '${T}')`,
    ...['notice_cancelled', 'notice_holiday', 'notice_bring'].map((key) => `INSERT INTO crm_wa_templates (id, school_id, connection_id, template_key, language, version, meta_name, status, created_at, updated_at)
       VALUES ('wat_${key}', 'sch_a', 'wac_a', '${key}', 'en', ${WA_TEMPLATES[key].version}, '${metaTemplateName(key)}', 'approved', '${T}', '${T}')`),
  ], 'write');
}

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-msg-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  process.env.META_APP_SECRET = 'app-secret';
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([...BASE_SCHEMA, ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS, ...FEES_MIGRATIONS, ...COMMS_MIGRATIONS]), ...SEED], 'write');
  // CRM_MIGRATIONS seeds no pipeline; the lead needs one.
  await state.db.batch([
    `INSERT INTO crm_pipelines (id, school_id, name, created_at, updated_at) VALUES ('pl_a', 'sch_a', 'Admissions', '${T}', '${T}')`,
    `INSERT INTO crm_pipeline_stages (id, school_id, pipeline_id, name, category, position, created_at, updated_at) VALUES ('st_a', 'sch_a', 'pl_a', 'New', 'open', 0, '${T}', '${T}')`,
  ], 'write');
  await seed(state.db);
});
afterEach(() => { delete process.env.META_APP_SECRET; vi.useRealTimers(); });

const notice = (body = {}) => ({ entityType: 'batch', entityId: 'b_math10', mode: 'notice', templateKey: 'notice_cancelled', fields: { className: 'Grade 10 Maths', when: '21 Oct, 5 pm' }, ...body });

function webhookRes() {
  return {
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
    send(payload) { this.body = payload; this.headersSent = true; return this; },
  };
}
async function webhook(value) {
  const payload = { object: 'whatsapp_business_account', entry: [{ id: '4440001', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '5550001' }, ...value } }] }] };
  const raw = Buffer.from(JSON.stringify(payload));
  const out = webhookRes();
  await handleCrmRequest({ method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}` }, query: {}, rawBody: raw }, out, ['public', 'whatsapp', 'webhook']);
  return out;
}
const inbound = (from, body, id = `wamid.in.${Math.random()}`, at = Date.now()) => webhook({ messages: [{ from, id, timestamp: String(Math.floor(at / 1000)), type: 'text', text: { body } }] });


async function sendSome() {
  await call(admin, 'POST', 'messages', { body: notice() });
  // Newer than the notice just sent, whatever day the suite runs.
  const at = new Date(Date.now() + 60_000).toISOString();
  await state.db.execute({ sql: `INSERT INTO crm_comms_messages (id, school_id, via, kind, status, status_code, status_reason, contact_id, phone_e164, recipient_name, body_text, finance, dedup_key, created_at, updated_at)
    VALUES ('msg_fee', 'sch_a', 'api', 'fee_overdue', 'failed', '131000', 'WhatsApp is busy. Gave up after 5 attempts.', 'ct_kavita', '+919800000001', 'Kavita Sharma', '₹17,500 is overdue', 1, 'fee:x', ?, ?)`, args: [at, at] });
  await state.db.execute({ sql: "INSERT INTO crm_comms_subjects (message_id, school_id, entity_type, entity_id, created_at) VALUES ('msg_fee', 'sch_a', 'student', 'stu_3', ?)", args: [at] });
}

describe('history (S5)', () => {
  it('lists every message newest first, with filters and paging', async () => {
    await sendSome();
    const all = await call(admin, 'GET', 'messages');
    expect(all.statusCode).toBe(200);
    expect(all.body.items.map((item) => item.kind)).toEqual(['fee_overdue', 'notice', 'notice']);
    expect(all.body.items[0]).toMatchObject({ status: 'failed', retryable: true, recipientName: 'Kavita Sharma', subjects: [{ entityType: 'student', entityId: 'stu_3', name: 'Diya Rao' }] });
    expect((await call(admin, 'GET', 'messages', { query: { status: 'attention' } })).body.items.map((item) => item.id)).toEqual(['msg_fee']);
    expect((await call(admin, 'GET', 'messages', { query: { kind: 'notice', batchId: 'b_math10' } })).body.items).toHaveLength(2);
    const first = await call(admin, 'GET', 'messages', { query: { limit: '2' } });
    const second = await call(admin, 'GET', 'messages', { query: { limit: '2', cursor: first.body.nextCursor } });
    expect([...first.body.items, ...second.body.items].map((item) => item.id)).toHaveLength(3);
    expect(second.body.nextCursor).toBeNull();
  });

  it('hides fee text without finance access and limits teachers to their own batches', async () => {
    await sendSome();
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.comms.read']);
    const staffView = await call(staff, 'GET', 'messages');
    expect(staffView.body.items.find((item) => item.id === 'msg_fee')).toMatchObject({ body: null, amountsHidden: true, recipientName: null });
    await grant(state.db, 'usr_teacher', ['crm.comms.read']);
    await state.db.execute(`INSERT INTO crm_batch_instructors (id, school_id, batch_id, user_id, status, started_at, created_at, updated_at) VALUES ('bi_1', 'sch_a', 'b_math10', 'usr_teacher', 'active', '${T}', '${T}', '${T}')`);
    expect((await call(teacher, 'GET', 'messages')).body.items.map((item) => item.kind)).toEqual(['notice', 'notice']);
  });
});

describe('replies (S5)', () => {
  it('shows replies with their students, and unknown numbers separately', async () => {
    await inbound('919800000001', 'Thanks!', 'wamid.a', Date.now());
    await inbound('919777000000', 'Who is this?', 'wamid.b', Date.now());
    await inbound('919800000004', 'Is there a demo class?', 'wamid.c', Date.now());
    const matched = await call(admin, 'GET', 'messages/replies');
    // Same second: order by name to compare.
    const byName = [...matched.body.items].sort((a, b) => a.fromName.localeCompare(b.fromName));
    expect(byName.map((item) => [item.fromName, item.records.map((record) => record.name).sort()])).toEqual([
      ['Kavita Sharma', ['Anaya Iyer', 'Arjun Sharma']], ['Lead Parent', ['Ishaan']],
    ]);
    expect(byName[0].windowOpen).toBe(true);
    const unknown = await call(admin, 'GET', 'messages/replies', { query: { view: 'unknown' } });
    expect(unknown.body.items.map((item) => [item.fromPhone, item.body])).toEqual([['+919777000000', 'Who is this?']]);

    await grant(state.db, 'usr_teacher', ['crm.comms.read']);
    expect((await call(teacher, 'GET', 'messages/replies', { query: { view: 'unknown' } })).body.items).toEqual([]);
    expect((await call(teacher, 'GET', 'messages/replies')).body.items).toEqual([]);
  });
});

describe('group notices (S5)', () => {
  it('previews and sends to batches, with one copy per phone and a counts-only audit', async () => {
    const preview = await call(admin, 'GET', 'messages/group/preview', { query: { batchIds: 'b_math10,b_sci9' } });
    expect(preview.statusCode).toBe(200);
    expect(preview.body.target.studentCount).toBe(3);
    expect(preview.body.recipients.map((r) => r.name)).toEqual(['Kavita Sharma', 'Rohit Sharma']);
    expect(preview.body.skipped.map((s) => s.reason)).toEqual(['no_consent']);
    const sent = await call(admin, 'POST', 'messages/group', { body: { filters: { batchIds: ['b_math10', 'b_sci9'] }, templateKey: 'notice_holiday', fields: { dates: '1 Nov', occasion: 'Diwali' } } });
    expect(sent.statusCode).toBe(201);
    expect(sent.body).toMatchObject({ queued: 2, skipped: 1 });
    expect((await auditRows(state.db, 'message.group_sent'))[0].summary).toMatchObject({ recipients: 2, skipped: 1, batchIds: ['b_math10', 'b_sci9'] });
  });

  it('needs a filter, finance access for overdue fees, and keeps teachers to their batches', async () => {
    expect((await call(admin, 'GET', 'messages/group/preview')).statusCode).toBe(422);
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.comms.send']);
    expect((await call(staff, 'GET', 'messages/group/preview', { query: { overdueOnly: 'true' } })).statusCode).toBe(403);
    await grant(state.db, 'usr_teacher', ['crm.comms.send']);
    expect((await call(teacher, 'GET', 'messages/group/preview', { query: { batchIds: 'b_math10' } })).statusCode).toBe(403);
    await state.db.execute(`INSERT INTO crm_batch_instructors (id, school_id, batch_id, user_id, status, started_at, created_at, updated_at) VALUES ('bi_1', 'sch_a', 'b_math10', 'usr_teacher', 'active', '${T}', '${T}', '${T}')`);
    const own = await call(teacher, 'GET', 'messages/group/preview', { query: { batchIds: 'b_math10,b_sci9' } });
    expect(own.body.target.studentCount).toBe(2);
  });
});
