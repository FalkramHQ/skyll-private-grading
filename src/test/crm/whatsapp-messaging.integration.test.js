// @vitest-environment node
// Sending WhatsApp messages on real SQLite (CRM M2 phase 2 S2, D5/D8/D9/D11/
// D12/D15): compose, the outbox, the dispatcher, Meta's message webhooks and
// STOP. Meta itself is a fake provider.
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
const { claim, dispatchOnce, probeBlocked, reclaimExpired, LEASE_MS } = await import('../../../server/comms/dispatcher.js');
const { ProviderError } = await import('../../../server/comms/errors.js');
const call = makeCaller(auth, handleCrmRequest);
const { admin, teacher, teacher2, staff } = actors;

let dir;
const NOW = Date.parse('2026-10-20T06:00:00.000Z');

/** A fake Meta: records sends; `fail(phone)` decides an error per recipient. */
function fakeProvider({ fail = () => null } = {}) {
  const sent = [];
  let n = 0;
  const factory = vi.fn(() => ({
    kind: 'meta',
    async send({ to, message }) {
      const error = fail(to, message);
      if (error) throw error;
      n += 1;
      sent.push({ to, message });
      return { id: `wamid.${n}` };
    },
  }));
  return { factory, sent };
}

const temporary = () => new ProviderError({ kind: 'temporary', code: '131000', reason: 'WhatsApp is busy; Skyll will try again shortly' });

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

const rows = async (sql, args = []) => (await state.db.execute({ sql, args })).rows;
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
const inbound = (from, body, id = `wamid.in.${Math.random()}`, at = NOW) => webhook({ messages: [{ from, id, timestamp: String(Math.floor(at / 1000)), type: 'text', text: { body } }] });

describe('compose and send (S2)', () => {
  it('previews a batch notice: one copy per phone, skipped guardians, cost; phones only with contact access', async () => {
    const res = await call(admin, 'GET', 'messages/compose', { query: { entityType: 'batch', entityId: 'b_math10' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.recipients.map((r) => [r.name, r.students])).toEqual([['Kavita Sharma', ['Anaya Iyer', 'Arjun Sharma']], ['Rohit Sharma', ['Arjun Sharma']]]);
    expect(res.body.recipients[0].phone).toBe('+919800000001');
    expect(res.body.notices.map((n) => n.key)).toEqual(['notice_cancelled', 'notice_rescheduled', 'notice_holiday', 'notice_bring']);
    expect(res.body.estimate.total).toMatch(/₹0\.28/);

    const diya = await call(admin, 'GET', 'messages/compose', { query: { entityType: 'student', entityId: 'stu_3' } });
    expect(diya.body.recipients).toEqual([]);
    expect(diya.body.skipped).toEqual([expect.objectContaining({ name: 'No Consent', reason: 'no_consent' })]);

    await grant(state.db, 'usr_staff', ['crm.access', 'crm.comms.send', 'crm.students.read', 'crm.classes.read']);
    const noContacts = await call(staff, 'GET', 'messages/compose', { query: { entityType: 'batch', entityId: 'b_math10' } });
    expect(noContacts.body.recipients.every((r) => r.phone === null)).toBe(true);
  });

  it('queues a batch notice per phone with timeline subjects and a counts-only audit; the dispatcher sends it', async () => {
    const sent = await call(admin, 'POST', 'messages', { body: notice() });
    expect(sent.statusCode).toBe(201);
    expect(sent.body).toMatchObject({ queued: 2, skipped: 0 });
    const queued = await rows('SELECT contact_id, status, body_text, template_key FROM crm_comms_messages ORDER BY contact_id');
    expect(queued.map((r) => [r.contact_id, r.status])).toEqual([['ct_kavita', 'queued'], ['ct_rohit', 'queued']]);
    expect(queued[0].body_text).toContain('Hello Kavita Sharma, this is School A. The Grade 10 Maths class on 21 Oct, 5 pm is cancelled.');
    expect(await rows('SELECT entity_id FROM crm_comms_subjects ORDER BY entity_id')).toEqual([{ entity_id: 'stu_1' }, { entity_id: 'stu_2' }, { entity_id: 'stu_2' }]);
    const [audit] = await auditRows(state.db, 'message.group_sent');
    expect(audit.summary).toMatchObject({ recipients: 2, skipped: 0, batchIds: ['b_math10'], templateKey: 'notice_cancelled' });
    expect(JSON.stringify(audit.summary)).not.toMatch(/Kavita|9800/);

    const meta = fakeProvider();
    const result = await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    expect(result).toMatchObject({ claimed: 2, outcomes: { sent: 2 } });
    expect(meta.sent.map((s) => s.to).sort()).toEqual(['919800000001', '919800000002']);
    expect(meta.sent[0].message.template).toMatchObject({ name: 'skyll_notice_cancelled_v1', language: { code: 'en' } });
    expect((await rows("SELECT COUNT(*) AS n FROM crm_comms_messages WHERE status = 'sent' AND cost_millipaise = 11500 AND provider_message_id IS NOT NULL"))[0].n).toBe(2);

    const timeline = await call(admin, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_2' } });
    const messages = timeline.body.items.filter((item) => item.kind === 'message');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ messageKind: 'notice', status: 'sent', actorName: 'Admin A' });
  });

  it('rejects notices with missing fields, and to classes without WhatsApp', async () => {
    const missing = await call(admin, 'POST', 'messages', { body: notice({ fields: { className: 'Grade 10 Maths' } }) });
    expect(missing.statusCode).toBe(422);
    expect(missing.body.error.details).toEqual([{ path: 'fields.when', message: 'Required' }]);
    await state.db.execute("UPDATE crm_wa_connections SET status = 'disconnected'");
    expect((await call(admin, 'POST', 'messages', { body: notice() })).body.error.code).toBe('not_connected');
  });

  it('allows free text only inside the 24-hour window, and Send from my phone always', async () => {
    const text = { entityType: 'student', entityId: 'stu_1', mode: 'text', contactId: 'ct_kavita', text: 'Is Anaya feeling better?' };
    expect((await call(admin, 'POST', 'messages', { body: text })).body.error.code).toBe('window_closed');

    const phone = await call(admin, 'POST', 'messages', { body: { ...text, mode: 'phone' } });
    expect(phone.statusCode).toBe(201);
    expect(phone.body.link).toBe('https://wa.me/919800000001?text=Is%20Anaya%20feeling%20better%3F');
    expect((await rows("SELECT via, status FROM crm_comms_messages WHERE via = 'phone'"))[0]).toEqual({ via: 'phone', status: 'sent' });

    expect((await inbound('919800000001', 'Thanks for the update', 'wamid.in.1', Date.now())).statusCode).toBe(200);
    const queued = await call(admin, 'POST', 'messages', { body: text });
    expect(queued.statusCode).toBe(201);
    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: Date.now(), providerFactory: meta.factory });
    expect(meta.sent[0].message).toEqual({ type: 'text', text: { body: 'Is Anaya feeling better?', preview_url: false } });

    const timeline = await call(admin, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_1' } });
    expect(timeline.body.items.find((item) => item.kind === 'reply')).toMatchObject({ body: 'Thanks for the update', fromName: 'Kavita Sharma', isStop: false });
  });

  it('messages a lead by free text or phone only, never a notice', async () => {
    expect((await call(admin, 'POST', 'messages', { body: { entityType: 'lead', entityId: 'lead_1', mode: 'notice', templateKey: 'notice_holiday' } })).statusCode).toBe(422);
    const res = await call(admin, 'POST', 'messages', { body: { entityType: 'lead', entityId: 'lead_1', mode: 'phone', text: 'Hello from School A' } });
    expect(res.body.link).toMatch(/^https:\/\/wa\.me\/919800000004\?text=Hello/);
    const timeline = await call(admin, 'GET', 'timeline', { query: { entityType: 'lead', entityId: 'lead_1' } });
    expect(timeline.body.items.find((item) => item.kind === 'message')).toMatchObject({ via: 'phone', status: 'sent' });
  });

  it('gives the Front desk comms access and limits granted teachers to their own batches', async () => {
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.comms.read', 'crm.comms.send', 'crm.students.read', 'crm.classes.read', 'crm.contacts.read']);
    expect((await call(staff, 'POST', 'messages', { body: notice() })).statusCode).toBe(201);

    // Teachers have no comms access by default.
    expect((await call(teacher, 'GET', 'messages/compose', { query: { entityType: 'batch', entityId: 'b_math10' } })).statusCode).toBe(403);
    await grant(state.db, 'usr_teacher', ['crm.comms.read', 'crm.comms.send']);
    await state.db.execute(`INSERT INTO crm_batch_instructors (id, school_id, batch_id, user_id, status, started_at, created_at, updated_at) VALUES ('bi_1', 'sch_a', 'b_math10', 'usr_teacher', 'active', '${T}', '${T}', '${T}')`);
    expect((await call(teacher, 'GET', 'messages/compose', { query: { entityType: 'batch', entityId: 'b_math10' } })).statusCode).toBe(200);
    expect((await call(teacher, 'GET', 'messages/compose', { query: { entityType: 'batch', entityId: 'b_sci9' } })).statusCode).toBe(403);
    expect((await call(teacher, 'GET', 'messages/compose', { query: { entityType: 'student', entityId: 'stu_3' } })).statusCode).toBe(403);

    const own = await call(teacher, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_1' } });
    expect(own.body.items.some((item) => item.kind === 'message')).toBe(true);
    // A teacher with the grant but not teaching the batch sees no messages on its students.
    await grant(state.db, 'usr_teacher2', ['crm.comms.read']);
    const other = await call(teacher2, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_1' } });
    expect(other.body.items.some((item) => item.kind === 'message')).toBe(false);
  });
});

describe('dispatcher (S2)', () => {
  async function queueTwo() {
    await call(admin, 'POST', 'messages', { body: notice() });
  }

  it('never lets two workers claim the same message', async () => {
    await queueTwo();
    const [a, b] = await Promise.all([claim(state.db, 'w1', 10, NOW), claim(state.db, 'w2', 10, NOW)]);
    const ids = [...a, ...b].map((row) => row.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('retries temporary errors with backoff, then gives up after 5 attempts', async () => {
    await queueTwo();
    const meta = fakeProvider({ fail: temporary });
    let now = NOW;
    await dispatchOnce(state.db, { workerId: 'w1', now, providerFactory: meta.factory });
    let [row] = await rows("SELECT * FROM crm_comms_messages WHERE contact_id = 'ct_kavita'");
    expect(row).toMatchObject({ status: 'queued', attempts: 1, status_code: '131000' });
    expect(Date.parse(row.next_attempt_at) - now).toBe(60_000);
    // Not due yet: nothing is claimed.
    expect((await dispatchOnce(state.db, { workerId: 'w1', now: now + 30_000, providerFactory: meta.factory })).claimed).toBe(0);
    for (const minutes of [1, 2, 5, 15]) {
      now += minutes * 60_000 + 1000;
      await dispatchOnce(state.db, { workerId: 'w1', now, providerFactory: meta.factory });
    }
    [row] = await rows("SELECT * FROM crm_comms_messages WHERE contact_id = 'ct_kavita'");
    expect(row).toMatchObject({ status: 'failed', attempts: 5 });
    expect(row.status_reason).toMatch(/Gave up after 5 attempts/);
    expect(meta.sent).toHaveLength(0);

    // Staff can retry a temporary failure by hand.
    const retried = await call(admin, 'POST', 'messages/retry', { body: { messageId: row.id } });
    expect(retried.body.status).toBe('queued');
  });

  it('fails a send whose outcome is unknown instead of sending it twice', async () => {
    await queueTwo();
    await claim(state.db, 'crashed-worker', 10, NOW);
    expect(await reclaimExpired(state.db, NOW + LEASE_MS + 1)).toBe(2);
    const failed = await rows('SELECT status, status_code FROM crm_comms_messages');
    expect(failed.every((r) => r.status === 'failed' && r.status_code === 'unconfirmed')).toBe(true);
    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW + LEASE_MS + 2, providerFactory: meta.factory });
    expect(meta.sent).toHaveLength(0);
  });

  it('cancels messages whose recipient withdrew consent or changed number before sending', async () => {
    await queueTwo();
    await state.db.execute("UPDATE crm_contacts SET whatsapp_opted_in = 0 WHERE id = 'ct_kavita'");
    await state.db.execute("UPDATE crm_contacts SET phone_e164 = '+919811111111' WHERE id = 'ct_rohit'");
    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    expect(meta.sent).toHaveLength(0);
    expect((await rows('SELECT status, status_reason FROM crm_comms_messages ORDER BY contact_id')).map((r) => r.status_reason)).toEqual([
      'The parent has not agreed to WhatsApp messages (or replied STOP)', 'The parent’s phone number changed',
    ]);
  });

  it('holds everything when the class is blocked, shows it, and releases after a successful probe', async () => {
    await queueTwo();
    const payment = new ProviderError({ kind: 'class', code: '131042', reason: 'Meta could not charge the class’s payment method; update it in Meta Business Suite' });
    const broken = fakeProvider({ fail: () => payment });
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: broken.factory });
    expect((await rows('SELECT status FROM crm_comms_messages')).map((r) => r.status)).toEqual(['held', 'held']);
    expect((await rows('SELECT attempts FROM crm_comms_messages')).every((r) => r.attempts === 0)).toBe(true);
    const settings = await call(admin, 'GET', 'settings/whatsapp');
    expect(settings.body.connection).toMatchObject({ health: 'blocked', healthCode: '131042' });

    // Too soon to probe; then the payment is still broken; then it's fixed.
    expect(await probeBlocked(state.db, { workerId: 'w1', now: NOW + 60_000, providerFactory: broken.factory })).toBe(0);
    expect(await probeBlocked(state.db, { workerId: 'w1', now: NOW + 16 * 60_000, providerFactory: broken.factory })).toBe(0);
    const fixed = fakeProvider();
    expect(await probeBlocked(state.db, { workerId: 'w1', now: NOW + 32 * 60_000, providerFactory: fixed.factory })).toBe(1);
    expect(fixed.sent).toHaveLength(1);
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW + 33 * 60_000, providerFactory: fixed.factory });
    expect((await rows('SELECT status FROM crm_comms_messages')).map((r) => r.status).sort()).toEqual(['sent', 'sent']);
    expect((await auditRows(state.db, 'wa_connection.changed')).map((r) => r.summary.change)).toEqual(['blocked', 'unblocked']);
  });

  it('holds billable messages at the monthly limit and releases them when the limit is raised', async () => {
    await state.db.execute(`INSERT INTO crm_wa_settings (school_id, sender_name, monthly_limit_paise, created_at, updated_at) VALUES ('sch_a', 'School A', 10000, '${T}', '${T}')`);
    // ₹99.99 already spent this month (before GST, in millipaise).
    await state.db.execute(`INSERT INTO crm_comms_messages (id, school_id, via, kind, status, dedup_key, cost_millipaise, pricing_category, sent_at, created_at, updated_at)
      VALUES ('msg_old', 'sch_a', 'api', 'notice', 'sent', 'old', 9999000, 'utility', '${new Date(NOW - 3600_000).toISOString()}', '${T}', '${T}')`);
    await queueTwo();
    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    expect(meta.sent).toHaveLength(0);
    expect((await rows("SELECT status FROM crm_comms_messages WHERE id != 'msg_old'")).map((r) => r.status)).toEqual(['held', 'held']);
    const settings = await call(admin, 'GET', 'settings/whatsapp');
    expect(settings.body.connection.healthReason).toMatch(/limit \(₹100\) is reached/);

    const { version, saved: _saved, ...current } = settings.body.settings;
    const raised = await call(admin, 'POST', 'settings/whatsapp', { body: { ...current, monthlyLimitPaise: 50000, expectedVersion: version } });
    expect(raised.statusCode).toBe(200);
    expect(raised.body.connection.health).toBe('ok');
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    expect(meta.sent).toHaveLength(2);
  });

  it('waits for Meta to approve a template, and fails one Meta rejected', async () => {
    await state.db.execute("UPDATE crm_wa_templates SET status = 'pending'");
    await queueTwo();
    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    expect((await rows('SELECT status, attempts, status_reason FROM crm_comms_messages'))[0]).toMatchObject({ status: 'queued', attempts: 0, status_reason: 'Waiting for Meta to approve the wording' });
    await state.db.execute("UPDATE crm_wa_templates SET status = 'rejected', reason = 'INVALID_FORMAT'");
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW + 11 * 60_000, providerFactory: meta.factory });
    expect((await rows('SELECT status, status_reason FROM crm_comms_messages'))[0].status_reason).toMatch(/rejected.*INVALID_FORMAT/);
  });
});

describe('Meta message webhooks (S2)', () => {
  async function sentNotice() {
    await call(admin, 'POST', 'messages', { body: notice() });
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: fakeProvider().factory });
  }
  const status = (id, value, extra = {}) => webhook({ statuses: [{ id, status: value, timestamp: String(Math.floor(NOW / 1000) + 60), ...extra }] });

  it('moves statuses forwards only and records pricing', async () => {
    await sentNotice();
    await status('wamid.1', 'read');
    await status('wamid.1', 'delivered');
    const [row] = await rows("SELECT status, delivered_at, read_at FROM crm_comms_messages WHERE provider_message_id = 'wamid.1'");
    expect(row.status).toBe('read');
    expect(row.read_at).toBeTruthy();
    expect(row.delivered_at).toBeTruthy();
    await status('wamid.2', 'delivered', { pricing: { billable: false, category: 'service' } });
    expect((await rows("SELECT status, cost_millipaise, pricing_category FROM crm_comms_messages WHERE provider_message_id = 'wamid.2'"))[0]).toEqual({ status: 'delivered', cost_millipaise: 0, pricing_category: 'service' });
  });

  it('explains failures plainly, and blocks the class on a class-wide failure', async () => {
    await sentNotice();
    await status('wamid.1', 'failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] });
    expect((await rows("SELECT status, status_reason FROM crm_comms_messages WHERE provider_message_id = 'wamid.1'"))[0].status_reason).toMatch(/not on WhatsApp/);
    await status('wamid.2', 'failed', { errors: [{ code: 131042, title: 'Business eligibility payment issue' }] });
    expect((await rows('SELECT health, health_code FROM crm_wa_connections'))[0]).toEqual({ health: 'blocked', health_code: '131042' });
  });

  it('withdraws consent on STOP, cancels what was waiting, audits it, and acknowledges once', async () => {
    await call(admin, 'POST', 'messages', { body: notice() });
    await inbound('919800000001', ' stop ', 'wamid.stop.1');
    await inbound('919800000001', ' stop ', 'wamid.stop.1'); // Meta retries the same event
    expect((await rows("SELECT whatsapp_opted_in, consent_source FROM crm_contacts WHERE id = 'ct_kavita'"))[0]).toEqual({ whatsapp_opted_in: 0, consent_source: 'whatsapp_stop' });
    expect((await rows("SELECT status, status_reason FROM crm_comms_messages WHERE contact_id = 'ct_kavita' AND kind = 'notice'"))[0]).toEqual({ status: 'cancelled', status_reason: 'The parent replied STOP' });
    expect((await auditRows(state.db, 'contact.consent_changed')).map((r) => r.summary)).toEqual([{ optedIn: false, source: 'whatsapp_stop' }]);
    const acks = await rows("SELECT body_text, status FROM crm_comms_messages WHERE kind = 'stop_ack'");
    expect(acks).toHaveLength(1);
    expect(acks[0].body_text).toMatch(/won’t receive more WhatsApp updates from School A/);

    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: Date.now(), providerFactory: meta.factory });
    expect(meta.sent.map((s) => [s.to, s.message.type])).toEqual([['919800000002', 'template'], ['919800000001', 'text']]);
    const guardians = await call(admin, 'GET', 'students/guardians', { query: { studentId: 'stu_1' } });
    expect(guardians.body.items[0].contact).toMatchObject({ whatsappOptIn: false, consentSource: 'whatsapp_stop' });
  });

  it('stores media as a label only, and keeps unknown numbers unmatched', async () => {
    await webhook({ messages: [{ from: '919777777777', id: 'wamid.img', timestamp: String(Math.floor(NOW / 1000)), type: 'image', image: { id: 'm1', caption: 'Homework' } }] });
    expect((await rows('SELECT contact_id, kind, body_text, media_label FROM crm_comms_inbound'))[0]).toEqual({ contact_id: null, kind: 'media', body_text: 'Homework', media_label: 'Photo received' });
  });
});
