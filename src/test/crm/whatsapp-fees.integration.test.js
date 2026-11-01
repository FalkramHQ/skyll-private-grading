// @vitest-environment node
// Fee messages and the parent fees page on real SQLite (CRM M2 phase 2 S3,
// D5/D7/D10/D13; CRM-019). Meta is a fake provider.
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
const limits = vi.hoisted(() => ({ checkRateLimit: vi.fn(async () => false) }));
vi.mock('../../../api/_lib/auth.js', () => auth);
vi.mock('../../../api/_lib/featureFlags.js', () => flags);
vi.mock('../../../api/_lib/rateLimit.js', () => limits);

const { handleCrmRequest } = await import('../../../server/crm/router.js');
const { dispatchOnce } = await import('../../../server/comms/dispatcher.js');
const { overdueStep, planFees } = await import('../../../server/comms/fees.js');
const call = makeCaller(auth, handleCrmRequest);
const { admin, staff } = actors;

let dir;
// 20 Oct 2026, 11:30 in Kolkata: after the default 10:00 send hour.
const NOW = Date.parse('2026-10-20T06:00:00.000Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function fakeProvider() {
  const sent = [];
  const uploads = [];
  let n = 0;
  const factory = vi.fn(() => ({
    kind: 'meta',
    async send({ to, message }) { n += 1; sent.push({ to, message }); return { id: `wamid.${n}` }; },
    async uploadMedia(file) { uploads.push(file); return `media.${uploads.length}`; },
  }));
  return { factory, sent, uploads };
}

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-wafees-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  limits.checkRateLimit.mockResolvedValue(false);
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Math.random()}.db`)}` });
  await state.db.batch([...BASE_SCHEMA, ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS, ...FEES_MIGRATIONS, ...COMMS_MIGRATIONS]), ...SEED,
    'CREATE TABLE school_feature_flags (school_id TEXT, feature_key TEXT, enabled INTEGER, updated_by TEXT, updated_at TEXT)',
    "INSERT INTO school_feature_flags VALUES ('sch_a', 'crm', 1, 'test', 'x')",
    `INSERT INTO crm_contacts (id, school_id, full_name, phone_e164, whatsapp_opted_in, created_at, updated_at) VALUES
       ('ct_kavita', 'sch_a', 'Kavita Sharma', '+919800000001', 1, '${T}', '${T}'),
       ('ct_rohit', 'sch_a', 'Rohit Sharma', '+919800000002', 1, '${T}', '${T}'),
       ('ct_nope', 'sch_a', 'No Consent', '+919800000003', 0, '${T}', '${T}')`,
    `INSERT INTO crm_guardian_links (id, school_id, student_id, contact_id, is_primary, is_fee_payer, created_at, updated_at) VALUES
       ('gl_1', 'sch_a', 'stu_1', 'ct_kavita', 1, 1, '${T}', '${T}'),
       ('gl_2', 'sch_a', 'stu_2', 'ct_kavita', 1, 1, '${T}', '${T}'),
       ('gl_3', 'sch_a', 'stu_2', 'ct_rohit', 0, 0, '${T}', '${T}'),
       ('gl_4', 'sch_a', 'stu_3', 'ct_nope', 1, 1, '${T}', '${T}')`,
    // Connected a week ago.
    `INSERT INTO crm_wa_connections (id, school_id, provider, mode, status, waba_id, phone_number_id, display_phone, token_enc, connected_at, created_at, updated_at)
       VALUES ('wac_a', 'sch_a', 'meta', 'manual', 'connected', '4440001', '5550001', '+91 98200 11122', 'v1.x.y.z', '${new Date(NOW - 7 * DAY).toISOString()}', '${T}', '${T}')`,
    ...['fee_due', 'fee_overdue', 'receipt'].map((key) => `INSERT INTO crm_wa_templates (id, school_id, connection_id, template_key, language, version, meta_name, status, created_at, updated_at)
       VALUES ('wat_${key}', 'sch_a', 'wac_a', '${key}', 'en', ${WA_TEMPLATES[key].version}, '${metaTemplateName(key)}', 'approved', '${T}', '${T}')`),
  ], 'write');
});
afterEach(() => { vi.useRealTimers(); });

const invoice = async (dueDate, amountPaise, studentId = 'stu_1', label = 'Instalment 2') => (await call(admin, 'POST', 'fees/invoices', {
  body: { studentId, dueDate, lines: [{ label, amountPaise }] },
})).body;
const pay = (body = {}) => call(admin, 'POST', 'fees/payments', {
  body: { studentId: 'stu_1', amountPaise: 500000, receivedOn: '2026-10-20', method: 'upi', reference: 'UPI-REF-77881', note: 'Paid at the counter by uncle', ...body },
});
const rows = async (sql, args = []) => (await state.db.execute({ sql, args })).rows;
const messages = () => rows("SELECT kind, status, status_reason, contact_id, body_text, dedup_key FROM crm_comms_messages ORDER BY created_at, id");

describe('the overdue schedule (D7)', () => {
  const settings = { overdue_first_day: 1, overdue_gap_days: 7, overdue_count: 3 };
  it.each([
    ['2026-10-19', '2026-10-19', null],
    ['2026-10-19', '2026-10-20', { step: 0, date: '2026-10-20' }],
    ['2026-10-19', '2026-10-26', { step: 0, date: '2026-10-20' }],
    ['2026-10-19', '2026-10-27', { step: 1, date: '2026-10-27' }],
    ['2026-10-19', '2026-11-03', { step: 2, date: '2026-11-03' }],
    ['2026-10-19', '2026-12-31', { step: 2, date: '2026-11-03' }],
  ])('due %s, today %s → %j', (due, today, expected) => {
    expect(overdueStep(settings, due, today)).toEqual(expected);
  });
  it('is off when the count is 0', () => {
    expect(overdueStep({ ...settings, overdue_count: 0 }, '2026-10-01', '2026-10-20')).toBeNull();
  });
});

describe('reminder planner (S3)', () => {
  it('reminds the fee payer 3 days before, after the send hour, once', async () => {
    await invoice('2026-10-23', 1200000);
    // 09:00 in Kolkata: too early.
    expect((await planFees(state.db, { now: NOW - 2.5 * HOUR })).queued).toBe(0);
    await planFees(state.db, { now: NOW });
    await planFees(state.db, { now: NOW + HOUR });
    const queued = await messages();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'fee_due', status: 'queued', contact_id: 'ct_kavita' });
    expect(queued[0].body_text).toBe('Hello Kavita Sharma, this is a fee reminder from School A. ₹12,000 for Anaya Iyer (Instalment 2) is due on 23 Oct 2026.\n\n'
      + 'How to pay: Please pay at the class office.\nContact: reply to this message\n\nThank you.');

    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    const template = meta.sent[0].message.template;
    expect(template.name).toBe(metaTemplateName('fee_due'));
    const token = template.components.find((c) => c.type === 'button').parameters[0].text;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await rows('SELECT purpose, contact_id FROM crm_access_links')).toEqual([{ purpose: 'fees', contact_id: 'ct_kavita' }]);
    expect(JSON.stringify(await rows('SELECT * FROM crm_access_links'))).not.toContain(token);
  });

  it('combines overdue invoices per student, steps through the schedule, and stops once paid', async () => {
    await invoice('2026-10-19', 1000000, 'stu_1', 'Instalment 1');
    await invoice('2026-10-12', 750000, 'stu_1', 'Books');
    await planFees(state.db, { now: NOW });
    let queued = await messages();
    // 8 days after the oldest due date: step 1 (day 8), never step 0 as well.
    expect(queued.map((m) => m.dedup_key)).toEqual([expect.stringMatching(/^fee_overdue:stu_1:.+:1:ct_kavita$/)]);
    expect(queued[0].body_text).toContain('₹17,500 for Anaya Iyer is now overdue (2 fees, the oldest due on 12 Oct 2026)');

    // Paid in full before the worker sends: the reminder is cancelled, nobody is chased.
    await pay({ amountPaise: 1750000 });
    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    expect(meta.sent.filter((s) => s.message.template.name === metaTemplateName('fee_overdue'))).toHaveLength(0);
    queued = await rows("SELECT status, status_reason FROM crm_comms_messages WHERE kind = 'fee_overdue'");
    expect(queued[0]).toEqual({ status: 'cancelled', status_reason: 'Nothing is overdue any more' });
  });

  it('refreshes the amount at send time after a part payment', async () => {
    await invoice('2026-10-19', 1000000);
    await planFees(state.db, { now: NOW });
    await pay({ amountPaise: 400000, receivedOn: '2026-10-20' });
    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    const overdue = meta.sent.find((s) => s.message.template.name === metaTemplateName('fee_overdue'));
    expect(overdue.message.template.components[0].parameters[2].text).toBe('6,000');
    expect((await rows("SELECT body_text FROM crm_comms_messages WHERE kind = 'fee_overdue'"))[0].body_text).toContain('₹6,000');
  });

  it('skips paused students, notes missing consent and an unconnected class at most once a day', async () => {
    await invoice('2026-10-23', 1200000, 'stu_1');
    await invoice('2026-10-23', 900000, 'stu_3');
    expect((await call(admin, 'POST', 'fees/reminders/pause', { body: { studentId: 'stu_1', untilDate: '2026-10-25' } })).statusCode).toBe(200);
    await planFees(state.db, { now: NOW });
    await planFees(state.db, { now: NOW + HOUR });
    expect((await messages()).map((m) => [m.kind, m.status, m.status_reason])).toEqual([['fee_due', 'skipped', 'Not sent: the fee payer hasn’t agreed to WhatsApp']]);
    expect((await auditRows(state.db, 'reminder.paused'))[0].summary).toEqual({ change: 'paused', untilDate: '2026-10-25' });

    await state.db.execute('DELETE FROM crm_comms_messages');
    await state.db.execute("UPDATE crm_wa_connections SET status = 'disconnected'");
    await call(admin, 'POST', 'fees/reminders/pause', { body: { studentId: 'stu_1', untilDate: null } });
    await planFees(state.db, { now: NOW });
    await planFees(state.db, { now: NOW + HOUR });
    expect((await messages()).map((m) => [m.kind, m.status, m.status_reason])).toEqual([
      ['fee_due', 'skipped', 'Not sent: WhatsApp isn’t connected'], ['fee_due', 'skipped', 'Not sent: WhatsApp isn’t connected'],
    ]);
    const timeline = await call(admin, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_1' } });
    expect(timeline.body.items.find((item) => item.kind === 'message')).toMatchObject({ status: 'skipped', statusReason: 'Not sent: WhatsApp isn’t connected' });
  });

  it('starts from the next reminder after connecting, never a backlog', async () => {
    await state.db.execute(`UPDATE crm_wa_connections SET connected_at = '${new Date(NOW - HOUR).toISOString()}'`);
    await invoice('2026-10-23', 1200000);
    await invoice('2026-10-19', 1000000, 'stu_2');
    await planFees(state.db, { now: NOW });
    expect(await messages()).toEqual([]);
    // Tomorrow's step for the overdue fee, and the next before-due reminder, go out normally.
    await invoice('2026-10-24', 300000, 'stu_2');
    await planFees(state.db, { now: NOW + DAY });
    expect((await messages()).map((m) => m.kind)).toEqual(['fee_due']);
  });

  it('honours the class schedule and switches', async () => {
    await state.db.execute(`INSERT INTO crm_wa_settings (school_id, remind_days_before, send_hour, auto_fee_overdue, created_at, updated_at) VALUES ('sch_a', 5, 12, 0, '${T}', '${T}')`);
    await invoice('2026-10-25', 1200000);
    await invoice('2026-10-19', 1000000, 'stu_2');
    expect((await planFees(state.db, { now: NOW })).queued).toBe(0);
    await planFees(state.db, { now: NOW + HOUR });
    expect((await messages()).map((m) => m.kind)).toEqual(['fee_due']);
  });
});

describe('receipts (S3)', () => {
  it('sends the receipt PDF to the fee payer, and nothing for a reversed payment', async () => {
    await invoice('2026-10-30', 1200000);
    const payment = (await pay({ amountPaise: 500000 })).body;
    await planFees(state.db, { now: NOW });
    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    const receipt = meta.sent.find((s) => s.message.template.name === metaTemplateName('receipt'));
    expect(receipt.message.template.components[0]).toEqual({ type: 'header', parameters: [{ type: 'document', document: { id: 'media.1', filename: `${payment.receiptNumber.replace(/[^A-Za-z0-9-]+/g, '-')}.pdf` } }] });
    expect(meta.uploads[0]).toMatchObject({ mimeType: 'application/pdf' });
    expect(meta.uploads[0].data.subarray(0, 4).toString()).toBe('%PDF');
    expect(receipt.message.template.components[1].parameters.map((p) => p.text)).toEqual(expect.arrayContaining(['5,000', payment.receiptNumber, '7,000']));

    const second = (await pay({ amountPaise: 100000, reference: 'CHQ-1' })).body;
    await call(admin, 'POST', 'fees/payments/reverse', { body: { paymentId: second.id, reason: 'Cheque bounced' } });
    await planFees(state.db, { now: NOW + 60_000 });
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW + 60_000, providerFactory: meta.factory });
    expect(meta.sent.filter((s) => s.message.template.name === metaTemplateName('receipt'))).toHaveLength(1);
  });
});

describe('manual Send reminder (S3)', () => {
  it('sends once per fee payer per day, offers the phone instead, and needs fee access', async () => {
    await invoice('2026-10-19', 1000000);
    const first = await call(admin, 'POST', 'fees/reminders/send', { body: { studentId: 'stu_1' } });
    expect(first.statusCode).toBe(200);
    expect(first.body.templateKey).toBe('fee_overdue');
    expect((await call(admin, 'POST', 'fees/reminders/send', { body: { studentId: 'stu_1' } })).body.error.code).toBe('already_reminded');
    const status = await call(admin, 'GET', 'fees/reminders', { query: { studentId: 'stu_1' } });
    expect(status.body).toMatchObject({ connected: true, sentToday: true, payer: { name: 'Kavita Sharma', consent: true }, last: { kind: 'fee_manual', status: 'queued' } });

    const phone = await call(admin, 'POST', 'fees/reminders/send', { body: { studentId: 'stu_1', via: 'phone' } });
    expect(decodeURIComponent(phone.body.link)).toMatch(/^https:\/\/wa\.me\/919800000001\?text=Hello Kavita Sharma.*View fees: https?:\/\/[^/]+\/f\/[A-Za-z0-9_-]{43}$/s);

    expect((await call(admin, 'POST', 'fees/reminders/send', { body: { studentId: 'stu_4' } })).statusCode).toBe(422);
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.comms.send']);
    expect((await call(staff, 'POST', 'fees/reminders/send', { body: { studentId: 'stu_1' } })).statusCode).toBe(403);
  });
});

describe('the parent fees page (S3, D10)', () => {
  function res() {
    return {
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; this.headersSent = true; return this; },
      send(payload) { this.body = payload; this.headersSent = true; return this; },
    };
  }
  const open = async (route, query) => {
    const out = res();
    await handleCrmRequest({ method: 'GET', headers: { 'x-forwarded-for': '203.0.113.9' }, query }, out, route.split('/'));
    return out;
  };
  async function linkFor(contactId) {
    const { createLink } = await import('../../../server/comms/links.js');
    return createLink(state.db, { schoolId: 'sch_a', purpose: 'fees', contactId, now: Date.now() });
  }

  it('shows every child this guardian pays for, without notes, references or other families', async () => {
    await invoice('2026-10-19', 1000000, 'stu_1');
    await invoice('2026-11-19', 800000, 'stu_2');
    await invoice('2026-11-19', 600000, 'stu_3');
    await pay({ amountPaise: 400000 });
    const token = await linkFor('ct_kavita');
    const page = await open('public/fees', { token });
    expect(page.statusCode).toBe(200);
    expect(page.headers).toMatchObject({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    expect(page.body.children.map((child) => [child.name, child.summary.balancePaise, child.summary.overduePaise])).toEqual([['Anaya Iyer', 600000, 600000], ['Arjun Sharma', 800000, 0]]);
    expect(page.body.children[0].payments[0]).toEqual({ id: expect.any(String), receiptNumber: expect.any(String), receivedOn: '2026-10-20', amountPaise: 400000, method: 'UPI', reversed: false });
    const text = JSON.stringify(page.body);
    expect(text).not.toMatch(/UPI-REF|uncle|Diya|No Consent/);

    // Rohit isn't the fee payer for anyone.
    expect((await open('public/fees', { token: await linkFor('ct_rohit') })).body.children).toEqual([]);
  });

  it('serves PDFs only for this family, and refuses expired, revoked and unknown links', async () => {
    const own = await invoice('2026-10-19', 1000000, 'stu_1');
    const other = await invoice('2026-11-19', 600000, 'stu_3');
    const payment = (await pay({ amountPaise: 400000 })).body;
    const token = await linkFor('ct_kavita');
    const pdf = await open('public/fees/invoice', { token, invoiceId: own.id ?? own.invoices?.[0]?.id });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    expect((await open('public/fees/receipt', { token, paymentId: payment.id })).statusCode).toBe(200);
    expect((await open('public/fees/invoice', { token, invoiceId: other.id ?? other.invoices?.[0]?.id })).statusCode).toBe(404);

    expect((await open('public/fees', { token: 'x'.repeat(43) })).statusCode).toBe(404);
    expect((await open('public/fees', { token: 'short' })).statusCode).toBe(404);

    expect((await call(admin, 'POST', 'fees/links/revoke', { body: { studentId: 'stu_1' } })).body.revoked).toBe(1);
    const revoked = await open('public/fees', { token });
    expect([revoked.statusCode, revoked.body.error.code]).toEqual([410, 'link_revoked']);
    expect((await auditRows(state.db, 'access_link.revoked'))[0].summary).toMatchObject({ purpose: 'fees' });

    const later = await linkFor('ct_kavita');
    vi.setSystemTime(new Date(NOW + 61 * DAY));
    expect((await open('public/fees', { token: later })).body.error.code).toBe('link_expired');
  });

  it('rate-limits opening links', async () => {
    limits.checkRateLimit.mockResolvedValue(true);
    expect((await open('public/fees', { token: await linkFor('ct_kavita') })).statusCode).toBe(429);
  });
});
