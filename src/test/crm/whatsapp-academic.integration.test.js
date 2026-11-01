// @vitest-environment node
// Absence alerts and report-ready messages (CRM M2 phase 2 S4, D3/D5/D10).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { WA_TEMPLATES, metaTemplateName } from '../../../shared/crm/waTemplates.js';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, COMMS_MIGRATIONS, CRM_MIGRATIONS, FEES_MIGRATIONS, SEED, T, actors, makeCaller, migrationStatements,
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
const { planAcademic } = await import('../../../server/comms/academic.js');
const { default: reportHandler } = await import('../../../server/parent/report.js');
const call = makeCaller(auth, handleCrmRequest);
const { admin, teacher } = actors;

let dir;
const NOW = Date.parse('2026-10-20T06:00:00.000Z');
const MIN = 60_000;

function fakeProvider() {
  const sent = [];
  let n = 0;
  const factory = vi.fn(() => ({ kind: 'meta', async send({ to, message }) { n += 1; sent.push({ to, message }); return { id: `wamid.${n}` }; } }));
  return { factory, sent };
}

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-waacad-')); });
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
    'CREATE TABLE exams (id TEXT PRIMARY KEY, school_id TEXT, name TEXT, released_at TEXT)',
    'CREATE TABLE submissions (id TEXT PRIMARY KEY, exam_id TEXT, student_id TEXT)',
    'CREATE TABLE report_versions (id TEXT PRIMARY KEY, submission_id TEXT, version INTEGER, status TEXT, published_at TEXT, payload_json TEXT, username TEXT, school TEXT, exam_id TEXT)',
    `INSERT INTO crm_contacts (id, school_id, full_name, phone_e164, whatsapp_opted_in, created_at, updated_at) VALUES
       ('ct_kavita', 'sch_a', 'Kavita Sharma', '+919800000001', 1, '${T}', '${T}'),
       ('ct_rohit', 'sch_a', 'Rohit Sharma', '+919800000002', 1, '${T}', '${T}'),
       ('ct_nope', 'sch_a', 'No Consent', '+919800000003', 0, '${T}', '${T}')`,
    `INSERT INTO crm_guardian_links (id, school_id, student_id, contact_id, is_primary, is_fee_payer, created_at, updated_at) VALUES
       ('gl_2', 'sch_a', 'stu_2', 'ct_kavita', 1, 1, '${T}', '${T}'),
       ('gl_3', 'sch_a', 'stu_2', 'ct_rohit', 0, 0, '${T}', '${T}'),
       ('gl_1', 'sch_a', 'stu_1', 'ct_nope', 1, 1, '${T}', '${T}')`,
    `INSERT INTO crm_wa_connections (id, school_id, provider, mode, status, waba_id, phone_number_id, token_enc, connected_at, created_at, updated_at)
       VALUES ('wac_a', 'sch_a', 'meta', 'manual', 'connected', '4440001', '5550001', 'v1.x.y.z', '${new Date(NOW - 86_400_000).toISOString()}', '${T}', '${T}')`,
    ...['absent', 'report_ready'].map((key) => `INSERT INTO crm_wa_templates (id, school_id, connection_id, template_key, language, version, meta_name, status, created_at, updated_at)
       VALUES ('wat_${key}', 'sch_a', 'wac_a', '${key}', 'en', ${WA_TEMPLATES[key].version}, '${metaTemplateName(key)}', 'approved', '${T}', '${T}')`),
    `INSERT INTO crm_class_sessions (id, school_id, batch_id, instructor_user_id, local_date, starts_at, ends_at, created_at, updated_at)
       VALUES ('ses_1', 'sch_a', 'b_math10', 'usr_teacher', '2026-10-20', '2026-10-20T04:30:00.000Z', '2026-10-20T05:30:00.000Z', '${T}', '${T}')`,
  ], 'write');
});
afterEach(() => { vi.useRealTimers(); });

const mark = (studentId, status, at) => state.db.execute({
  sql: `INSERT INTO crm_session_attendance (id, school_id, session_id, student_id, status, marked_by, marked_at, created_at, updated_at) VALUES (?, 'sch_a', 'ses_1', ?, ?, 'usr_teacher', ?, ?, ?)
        ON CONFLICT (session_id, student_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
  args: [`att_${studentId}`, studentId, status, at, at, at],
});
const rows = async (sql, args = []) => (await state.db.execute({ sql, args })).rows;

describe('absent today (S4)', () => {
  it('waits 10 minutes, then tells every consenting guardian once', async () => {
    await mark('stu_2', 'absent', new Date(NOW - 5 * MIN).toISOString());
    expect((await planAcademic(state.db, { now: NOW })).queued).toBe(0);
    await planAcademic(state.db, { now: NOW + 6 * MIN });
    await planAcademic(state.db, { now: NOW + 7 * MIN });
    const queued = await rows("SELECT contact_id, body_text FROM crm_comms_messages WHERE kind = 'absent' ORDER BY contact_id");
    expect(queued.map((r) => r.contact_id)).toEqual(['ct_kavita', 'ct_rohit']);
    expect(queued[0].body_text).toBe('Hello Kavita Sharma, this is a message from School A. Arjun Sharma was marked absent from Grade 10 Maths on 20 Oct 2026. If this is not correct, or if you would like to tell us the reason, please get in touch.\n\nContact: reply to this message\n\nThank you.');
  });

  it('sends nothing for a quick correction, and cancels after a later one', async () => {
    await mark('stu_2', 'absent', new Date(NOW - 15 * MIN).toISOString());
    await mark('stu_2', 'present', new Date(NOW - 12 * MIN).toISOString());
    await planAcademic(state.db, { now: NOW });
    expect(await rows('SELECT 1 FROM crm_comms_messages')).toEqual([]);

    await mark('stu_2', 'absent', new Date(NOW - 11 * MIN).toISOString());
    await planAcademic(state.db, { now: NOW });
    await mark('stu_2', 'late', new Date(NOW).toISOString());
    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    expect(meta.sent).toEqual([]);
    expect((await rows("SELECT DISTINCT status_reason FROM crm_comms_messages WHERE kind = 'absent'"))[0].status_reason).toBe('The attendance was corrected');
  });

  it('notes once a day when nobody agreed, and stays quiet when switched off', async () => {
    await mark('stu_1', 'absent', new Date(NOW - 20 * MIN).toISOString());
    await planAcademic(state.db, { now: NOW });
    await planAcademic(state.db, { now: NOW + MIN });
    expect(await rows("SELECT status, status_reason FROM crm_comms_messages")).toEqual([{ status: 'skipped', status_reason: 'Not sent: no guardian has agreed to WhatsApp' }]);
    await state.db.execute(`INSERT INTO crm_wa_settings (school_id, auto_absent, created_at, updated_at) VALUES ('sch_a', 0, '${T}', '${T}')`);
    await mark('stu_2', 'absent', new Date(NOW - 20 * MIN).toISOString());
    await planAcademic(state.db, { now: NOW + 2 * MIN });
    expect(await rows("SELECT 1 FROM crm_comms_messages WHERE kind = 'absent' AND status = 'queued'")).toEqual([]);
  });

  it('shows absence alerts on the timeline to staff with comms access only', async () => {
    await mark('stu_2', 'absent', new Date(NOW - 20 * MIN).toISOString());
    await planAcademic(state.db, { now: NOW });
    const timeline = await call(admin, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_2' } });
    expect(timeline.body.items.filter((item) => item.kind === 'message').map((item) => item.messageKind)).toEqual(['absent', 'absent']);
    const teacherView = await call(teacher, 'GET', 'timeline', { query: { entityType: 'student', entityId: 'stu_2' } });
    expect(teacherView.body.items.some((item) => item.kind === 'message')).toBe(false);
  });
});

describe('report ready (S4)', () => {
  async function publish(at) {
    await state.db.batch([
      "INSERT INTO exams VALUES ('ex_1', 'sch_a', 'Unit Test 2', '2026-01-01T00:00:00.000Z')",
      "INSERT INTO submissions VALUES ('sub_1', 'ex_1', 'stu_2')",
      { sql: "INSERT INTO report_versions VALUES ('rv_1', 'sub_1', 1, 'published', ?, ?, 'arjun', 'School A', 'ex_1')", args: [at, JSON.stringify({ student: { name: 'Arjun Sharma' }, subjects: [{ name: 'Maths', score: 18, max_marks: 20 }] })] },
    ], 'write');
  }

  it('tells families only once a teacher releases the test, even days after grading', async () => {
    await state.db.batch([
      "INSERT INTO exams VALUES ('ex_1', 'sch_a', 'Unit Test 2', NULL)",
      "INSERT INTO submissions VALUES ('sub_1', 'ex_1', 'stu_2')",
      { sql: "INSERT INTO report_versions VALUES ('rv_1', 'sub_1', 1, 'published', ?, '{}', 'arjun', 'School A', 'ex_1')", args: [new Date(NOW - 5 * 24 * 60 * MIN).toISOString()] },
    ], 'write');
    await planAcademic(state.db, { now: NOW });
    expect(await rows("SELECT id FROM crm_comms_messages WHERE kind = 'report_ready'")).toHaveLength(0);
    await state.db.execute("UPDATE exams SET released_at = ? WHERE id = 'ex_1'", [new Date(NOW).toISOString()]);
    await planAcademic(state.db, { now: NOW + MIN });
    expect((await rows("SELECT id FROM crm_comms_messages WHERE kind = 'report_ready'")).length).toBeGreaterThan(0);
  });

  it('sends each guardian a link that opens the report, once per report', async () => {
    await publish(new Date(NOW - 30 * MIN).toISOString());
    await planAcademic(state.db, { now: NOW });
    await state.db.execute("INSERT INTO report_versions VALUES ('rv_2', 'sub_1', 2, 'published', ?, '{}', 'arjun', 'School A', 'ex_1')", [new Date(NOW).toISOString()]);
    await planAcademic(state.db, { now: NOW + MIN });
    const queued = await rows("SELECT contact_id, body_text FROM crm_comms_messages WHERE kind = 'report_ready' ORDER BY contact_id");
    expect(queued).toHaveLength(2);
    expect(queued[0].body_text).toBe('Hello Kavita Sharma, Arjun Sharma’s report for Unit Test 2 from School A is ready. Tap View report below to see it.');

    const meta = fakeProvider();
    await dispatchOnce(state.db, { workerId: 'w1', now: NOW, providerFactory: meta.factory });
    const token = meta.sent[0].message.template.components.find((c) => c.type === 'button').parameters[0].text;
    expect(await rows("SELECT purpose, submission_id, student_id FROM crm_access_links ORDER BY created_at LIMIT 1")).toEqual([{ purpose: 'report', submission_id: 'sub_1', student_id: 'stu_2' }]);

    const res = {
      headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; },
    };
    await reportHandler({ method: 'GET', query: { token }, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.report).toMatchObject({ studentName: 'Arjun Sharma' });
    expect(res.headers['X-Robots-Tag']).toBe('noindex, nofollow');

    await state.db.execute('UPDATE crm_access_links SET revoked_at = ?', [new Date().toISOString()]);
    const revoked = { ...res, headers: {} };
    await reportHandler({ method: 'GET', query: { token }, headers: {} }, revoked);
    expect(revoked.statusCode).toBe(410);
  });

  it('ignores reports published before the class connected', async () => {
    await publish(new Date(NOW - 2 * 86_400_000).toISOString());
    expect((await planAcademic(state.db, { now: NOW })).queued).toBe(0);
  });
});
