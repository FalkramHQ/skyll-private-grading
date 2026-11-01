// @vitest-environment node
// Settings → WhatsApp and Meta's webhook on real SQLite, with Meta's Graph API
// stubbed (CRM M2 phase 2 S1, D2/D4/D6/D11).
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import process from 'node:process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { metaTemplateName } from '../../../shared/crm/waTemplates.js';
import {
  BASE_SCHEMA, CLASSES_MIGRATIONS, COMMS_MIGRATIONS, CRM_MIGRATIONS, FEES_MIGRATIONS, SEED, actors, auditRows, grant, makeCaller, migrationStatements,
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

const ENV = {
  WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 3).toString('base64'),
  META_APP_ID: '1111111111',
  META_APP_SECRET: 'app-secret',
  META_ES_CONFIG_ID: '2222222222',
  META_WEBHOOK_VERIFY_TOKEN: 'verify-me',
  PUBLIC_APP_URL: 'https://www.skyllai.com',
};

const { handleCrmRequest } = await import('../../../server/crm/router.js');
const { setWhatsAppFetch } = await import('../../../server/crm/whatsapp.js');
const call = makeCaller(auth, handleCrmRequest);
const { admin, otherAdmin, teacher, staff } = actors;
const platform = { user_id: 'usr_platform', username: 'skyll', role: 'skyll_admin', school_id: 'sch_platform', school: null };
const asPlatform = { headers: { 'x-skyll-school': 'sch_a' } };

let dir;
let graph;

/** A tiny fake of the Graph endpoints Skyll calls. */
function fakeGraph({ failRegister = false } = {}) {
  const calls = [];
  const templates = [];
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const impl = vi.fn(async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method || 'GET';
    const route = pathname.replace(/^\/v[\d.]+\//, '');
    calls.push({ method, route, auth: init.headers?.Authorization || null, query: Object.fromEntries(searchParams) });
    if (route === 'oauth/access_token') return searchParams.get('code') === 'good-code-123' ? respond({ access_token: 'EAAG-business-token' }) : respond({ error: { code: 100, message: 'Invalid code' } }, 400);
    if (route === '5550001' && method === 'GET') return respond({ display_phone_number: '+91 98200 11122', verified_name: 'Sharma Classes', quality_rating: 'GREEN' });
    if (route === '4440001/subscribed_apps') return respond({ success: true });
    if (route === '4440001/phone_numbers') return respond({ data: [{ id: '5550001', display_phone_number: '+91 98200 11122' }] });
    if (route === '4449999/phone_numbers') return respond({ data: [{ id: '5559999' }] });
    if (route === '5550001/register') return failRegister ? respond({ error: { code: 133005, message: 'PIN mismatch' } }, 400) : respond({ success: true });
    if (route === '1111111111/uploads') return respond({ id: 'upload:abc' });
    if (route === 'upload:abc') return respond({ h: 'header-handle' });
    if (route === '4440001/message_templates' && method === 'POST') {
      const body = JSON.parse(init.body);
      templates.push(body);
      return respond({ id: `tpl_${templates.length}`, status: 'PENDING', category: 'UTILITY' });
    }
    if (route === '4440001/message_templates') {
      return respond({ data: templates.map((t, i) => ({ id: `tpl_${i + 1}`, name: t.name, language: t.language, status: t.name.includes('absent') ? 'REJECTED' : 'APPROVED', category: 'UTILITY', rejected_reason: t.name.includes('absent') ? 'INVALID_FORMAT' : 'NONE' })) });
    }
    return respond({ error: { code: 100, message: `Unexpected ${method} ${route}` } }, 400);
  });
  return { impl, calls, templates };
}

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-wa-')); });
afterAll(async () => { state.db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  state.db?.close();
  state.db = createClient({ url: `file:${path.join(dir, `${Date.now()}-${Math.random()}.db`)}` });
  await state.db.batch([...BASE_SCHEMA, ...migrationStatements([...CRM_MIGRATIONS, ...CLASSES_MIGRATIONS, ...FEES_MIGRATIONS, ...COMMS_MIGRATIONS]), ...SEED], 'write');
  // After the migrations: requiring them loads the developer's .env (override), which may hold real META_* values.
  Object.assign(process.env, ENV);
  graph = fakeGraph();
  setWhatsAppFetch(graph.impl);
});

afterEach(() => {
  setWhatsAppFetch(null);
  for (const key of Object.keys(ENV)) delete process.env[key];
});

const signup = { code: 'good-code-123', wabaId: '4440001', phoneNumberId: '5550001', businessId: '3330001', coexistence: true };

describe('Settings → WhatsApp (S1)', () => {
  it('starts unconnected with defaults from the fee documents name', async () => {
    const res = await call(admin, 'GET', 'settings/whatsapp');
    expect(res.statusCode).toBe(200);
    expect(res.body.connection).toBeNull();
    expect(res.body.settings).toMatchObject({ language: 'en', senderName: 'School A', version: 0, saved: false, monthlyLimitPaise: null });
    expect(res.body.settings.auto).toEqual({ feeDue: true, feeOverdue: true, receipt: true, reportReady: true, absent: true });
    expect(res.body.settings.schedule).toEqual({ remindDaysBefore: 3, overdueFirstDay: 1, overdueGapDays: 7, overdueCount: 3, sendHour: 10 });
    expect(res.body.signup).toMatchObject({ available: true, appId: '1111111111', configId: '2222222222' });
    expect(res.body.platform).toBe(false);
  });

  it('connects through Embedded Signup with coexistence: encrypted token, templates in both languages, audit', async () => {
    const res = await call(admin, 'POST', 'settings/whatsapp/connect', { body: signup });
    expect(res.statusCode).toBe(200);
    expect(res.body.connection).toMatchObject({ mode: 'embedded', provider: 'meta', displayPhone: '+91 98200 11122', verifiedName: 'Sharma Classes', coexistence: true, health: 'ok' });
    expect(JSON.stringify(res.body)).not.toContain('EAAG');

    // Coexistence numbers are not re-registered; the token travels only in the Authorization header.
    expect(graph.calls.some((c) => c.route.endsWith('/register'))).toBe(false);
    expect(graph.calls.filter((c) => c.route !== 'oauth/access_token' && !c.route.startsWith('upload:')).every((c) => c.auth === 'Bearer EAAG-business-token')).toBe(true);
    expect(graph.calls.every((c) => !JSON.stringify(c.query).includes('EAAG'))).toBe(true);

    const [row] = (await state.db.execute('SELECT token_enc, pin_enc FROM crm_wa_connections')).rows;
    expect(row.token_enc).toMatch(/^v1\./);
    expect(row.token_enc).not.toContain('EAAG');
    expect(row.pin_enc).toBeNull();

    // 9 templates × 2 languages; the receipt carries a sample PDF handle.
    expect(graph.templates).toHaveLength(18);
    expect(graph.templates.find((t) => t.name === metaTemplateName('receipt')).components[0].example.header_handle).toEqual(['header-handle']);
    expect(res.body.templates).toHaveLength(18);
    expect(res.body.templates.find((t) => t.key === 'fee_due' && t.language === 'hi')).toMatchObject({ status: 'approved', label: 'Fee due soon' });
    expect(res.body.templates.find((t) => t.key === 'absent' && t.language === 'en')).toMatchObject({ status: 'rejected', reason: 'INVALID_FORMAT' });

    expect((await auditRows(state.db, 'wa_connection.changed')).map((r) => r.summary)).toEqual([
      expect.objectContaining({ change: 'connected', mode: 'embedded', coexistence: true }),
    ]);
  });

  it('registers a new (non-coexistence) number with a stored, encrypted PIN, and surfaces Meta errors plainly', async () => {
    const res = await call(admin, 'POST', 'settings/whatsapp/connect', { body: { ...signup, coexistence: false } });
    expect(res.statusCode).toBe(200);
    expect(graph.calls.some((c) => c.route === '5550001/register')).toBe(true);
    expect((await state.db.execute('SELECT pin_enc FROM crm_wa_connections')).rows[0].pin_enc).toMatch(/^v1\./);

    const badCode = await call(otherAdmin, 'POST', 'settings/whatsapp/connect', { body: { ...signup, code: 'expired-code-123' } });
    expect(badCode.statusCode).toBe(502);
    expect(badCode.body.error.code).toBe('whatsapp_error');

    graph = fakeGraph({ failRegister: true });
    setWhatsAppFetch(graph.impl);
    const pin = await call(otherAdmin, 'POST', 'settings/whatsapp/connect', { body: { ...signup, coexistence: false } });
    expect(pin.statusCode).toBe(502);
    expect(pin.body.error.message).toMatch(/PIN/);
  });

  it('refuses a number that is not in the chosen WhatsApp account', async () => {
    const res = await call(admin, 'POST', 'settings/whatsapp/connect', { body: { ...signup, wabaId: '4449999' } });
    expect(res.statusCode).toBe(422);
    expect(await state.db.execute('SELECT COUNT(*) AS n FROM crm_wa_connections').then((r) => Number(r.rows[0].n))).toBe(0);
  });

  it('refuses to connect when the server has no Meta app or encryption key', async () => {
    delete process.env.WHATSAPP_TOKEN_KEY;
    expect((await call(admin, 'GET', 'settings/whatsapp')).body.signup.available).toBe(false);
    const res = await call(admin, 'POST', 'settings/whatsapp/connect', { body: signup });
    expect(res.statusCode).toBe(503);
    expect(graph.impl).not.toHaveBeenCalled();
  });

  it('lets only platform staff connect manually or use the test provider', async () => {
    const manual = { wabaId: '4440001', phoneNumberId: '5550001', accessToken: 'EAAG-system-user-token-xyz' };
    expect((await call(admin, 'POST', 'settings/whatsapp/connect-manual', { body: manual })).statusCode).toBe(403);
    expect((await call(admin, 'POST', 'settings/whatsapp/connect-test', { body: {} })).statusCode).toBe(403);

    const res = await call(platform, 'POST', 'settings/whatsapp/connect-manual', { body: manual, ...asPlatform });
    expect(res.statusCode).toBe(200);
    expect(res.body.connection).toMatchObject({ mode: 'manual', displayPhone: '+91 98200 11122' });
    expect(res.body.platform).toBe(true);

    // Connecting the test provider replaces the manual number.
    const test = await call(platform, 'POST', 'settings/whatsapp/connect-test', { body: {}, ...asPlatform });
    expect(test.body.connection).toMatchObject({ mode: 'test', provider: 'test' });
    expect(test.body.templates.every((t) => t.status === 'approved')).toBe(true);
    const rows = (await state.db.execute('SELECT mode, status, token_enc FROM crm_wa_connections ORDER BY created_at')).rows;
    expect(rows.map((r) => [r.mode, r.status, r.token_enc === null])).toEqual([['manual', 'disconnected', true], ['test', 'connected', true]]);
  });

  it('keeps one connected row per Meta number across schools', async () => {
    await call(admin, 'POST', 'settings/whatsapp/connect', { body: signup });
    await call(otherAdmin, 'POST', 'settings/whatsapp/connect', { body: signup });
    const rows = (await state.db.execute("SELECT school_id, status FROM crm_wa_connections ORDER BY created_at")).rows;
    expect(rows.map((r) => [r.school_id, r.status])).toEqual([['sch_a', 'disconnected'], ['sch_b', 'connected']]);
  });

  it('disconnects with a version check and wipes the token', async () => {
    const connected = await call(admin, 'POST', 'settings/whatsapp/connect', { body: signup });
    expect((await call(admin, 'POST', 'settings/whatsapp/disconnect', { body: { expectedVersion: 99 } })).statusCode).toBe(409);
    const res = await call(admin, 'POST', 'settings/whatsapp/disconnect', { body: { expectedVersion: connected.body.connection.version } });
    expect(res.statusCode).toBe(200);
    expect(res.body.connection).toBeNull();
    expect((await state.db.execute('SELECT token_enc, status FROM crm_wa_connections')).rows[0]).toMatchObject({ token_enc: null, status: 'disconnected' });
    expect((await call(admin, 'POST', 'settings/whatsapp/disconnect', { body: { expectedVersion: 1 } })).statusCode).toBe(404);
  });

  it('saves class details, switches, schedule and limit with versions and an audit of field names', async () => {
    const body = {
      language: 'hi', senderName: 'Sharma Classes, Andheri', contactLine: '98200 00000', paymentInstructions: 'UPI sharmaclasses@okhdfc',
      auto: { feeDue: true, feeOverdue: true, receipt: true, reportReady: true, absent: false },
      schedule: { remindDaysBefore: 5, overdueFirstDay: 2, overdueGapDays: 10, overdueCount: 2, sendHour: 11 },
      monthlyLimitPaise: 50000, expectedVersion: 0,
    };
    const saved = await call(admin, 'POST', 'settings/whatsapp', { body });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.settings).toMatchObject({ language: 'hi', senderName: 'Sharma Classes, Andheri', auto: { absent: false }, schedule: { sendHour: 11 }, monthlyLimitPaise: 50000, version: 1 });
    expect((await call(admin, 'POST', 'settings/whatsapp', { body })).statusCode).toBe(409);
    expect((await call(admin, 'POST', 'settings/whatsapp', { body: { ...body, schedule: { ...body.schedule, sendHour: 23 }, expectedVersion: 1 } })).statusCode).toBe(422);
    expect((await call(admin, 'POST', 'settings/whatsapp', { body: { ...body, monthlyLimitPaise: null, expectedVersion: 1 } })).body.settings.monthlyLimitPaise).toBeNull();
    const audit = await auditRows(state.db, 'wa_settings.changed');
    expect(audit[1].summary.fields).toEqual(['monthlyLimitPaise']);
    expect(JSON.stringify(audit)).not.toContain('okhdfc');
  });

  it('is admin-only and school-scoped', async () => {
    await grant(state.db, 'usr_staff', ['crm.access', 'crm.comms.read', 'crm.comms.send']);
    for (const actor of [teacher, staff]) expect((await call(actor, 'GET', 'settings/whatsapp')).statusCode).toBe(403);
    await call(admin, 'POST', 'settings/whatsapp/connect', { body: signup });
    expect((await call(otherAdmin, 'GET', 'settings/whatsapp')).body.connection).toBeNull();
  });
});

describe('Meta webhook (S1)', () => {
  function res() {
    return {
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; this.headersSent = true; return this; },
      send(payload) { this.body = payload; this.headersSent = true; return this; },
    };
  }
  const post = async (payload, signature) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const out = res();
    const sig = signature ?? `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
    await handleCrmRequest({ method: 'POST', headers: { 'x-hub-signature-256': sig }, query: {}, rawBody: raw, body: payload }, out, ['public', 'whatsapp', 'webhook']);
    return out;
  };

  it('answers Meta’s verification only with the right token', async () => {
    const ok = res();
    await handleCrmRequest({ method: 'GET', headers: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '12345' } }, ok, ['public', 'whatsapp', 'webhook']);
    expect([ok.statusCode, ok.body]).toEqual([200, '12345']);
    const bad = res();
    await handleCrmRequest({ method: 'GET', headers: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '12345' } }, bad, ['public', 'whatsapp', 'webhook']);
    expect(bad.statusCode).toBe(403);
  });

  it('rejects unsigned events and applies template and account updates', async () => {
    await call(admin, 'POST', 'settings/whatsapp/connect', { body: signup });
    const update = {
      object: 'whatsapp_business_account',
      entry: [{ id: '4440001', changes: [{ field: 'message_template_status_update', value: { event: 'PAUSED', message_template_name: metaTemplateName('fee_due'), message_template_language: 'en', reason: 'LOW_QUALITY' } }] }],
    };
    expect((await post(update, 'sha256=00')).statusCode).toBe(401);
    expect((await post(update)).statusCode).toBe(200);
    const template = (await state.db.execute({ sql: "SELECT status, reason FROM crm_wa_templates WHERE meta_name = ? AND language = 'en'", args: [metaTemplateName('fee_due')] })).rows[0];
    expect(template).toMatchObject({ status: 'paused', reason: 'LOW_QUALITY' });

    await post({ object: 'whatsapp_business_account', entry: [{ id: '4440001', changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED' } }] }] });
    const settings = await call(admin, 'GET', 'settings/whatsapp');
    expect(settings.body.connection).toMatchObject({ health: 'blocked', healthCode: 'partner_removed' });
    expect(settings.body.connection.healthReason).toMatch(/removed Skyll/);
    expect((await auditRows(state.db, 'wa_connection.changed')).map((r) => r.summary.change)).toEqual(['connected', 'blocked']);
  });
});
