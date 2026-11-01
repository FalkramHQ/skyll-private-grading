// Two safety defaults for WhatsApp (CRM M2 phase 2): a worker without
// WHATSAPP_TOKEN_KEY leaves WhatsApp alone, and templates with a button are
// only submitted with a public https address parents can open.
import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { createCommsRunner } from '../../../server/comms/runner.js';
import { publicBaseUrlProblem, syncTemplates } from '../../../server/comms/templates.js';
import { WA_LANGUAGES, WA_TEMPLATES, WA_TEMPLATE_KEYS } from '../../../shared/crm/waTemplates.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

function fakeDb() {
  const writes = [];
  return {
    writes,
    execute: vi.fn(async (statement) => {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (/^\s*SELECT/i.test(sql)) return { rows: [] };
      writes.push(statement);
      return { rows: [], rowsAffected: 1 };
    }),
  };
}

describe('comms runner without WHATSAPP_TOKEN_KEY', () => {
  it('does no WhatsApp work and says so once', async () => {
    const db = fakeDb();
    const log = vi.fn();
    const tick = createCommsRunner(db, { workerId: 'w1', log, env: {} });
    await tick(Date.parse('2026-11-01T10:00:00Z'));
    await tick(Date.parse('2026-11-01T10:20:00Z'));
    expect(db.execute).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ event: 'comms_disabled', reason: 'WHATSAPP_TOKEN_KEY is not set' });
  });

  it('works as before once the key is set', async () => {
    const db = fakeDb();
    const tick = createCommsRunner(db, { workerId: 'w1', log: vi.fn(), env: { WHATSAPP_TOKEN_KEY: KEY } });
    await tick(Date.parse('2026-11-01T10:00:00Z'));
    // The first thing it does is look for the outbox table.
    expect(db.execute).toHaveBeenCalledWith(expect.stringContaining('crm_comms_messages'));
  });
});

describe('template button addresses', () => {
  it('accepts only public https addresses', () => {
    expect(publicBaseUrlProblem('https://www.skyllai.com')).toBeNull();
    expect(publicBaseUrlProblem('https://classes.example.in/')).toBeNull();
    expect(publicBaseUrlProblem('http://www.skyllai.com')).toBe('must start with https://');
    for (const local of ['https://localhost:5173', 'https://127.0.0.1', 'https://192.168.1.4:5173', 'https://10.0.0.2', 'https://172.20.0.1', 'https://mac.local', 'https://[::1]:5173']) {
      expect(publicBaseUrlProblem(local), local).toBe('must be a public address, not this computer or a private network');
    }
    expect(publicBaseUrlProblem('not a url')).toBe('is not a valid web address');
  });

  it('does not submit button templates with a localhost address, and still submits the rest', async () => {
    const db = fakeDb();
    const provider = { kind: 'meta', submitTemplate: vi.fn(async () => ({ id: 'tpl_1', status: 'PENDING', category: 'UTILITY' })), listTemplates: vi.fn(async () => []) };
    await syncTemplates(db, { id: 'wac_1', school_id: 'sch_a' }, provider, { baseUrl: 'http://localhost:5173', now: () => '2026-11-01T00:00:00.000Z' });

    const withButton = WA_TEMPLATE_KEYS.filter((key) => WA_TEMPLATES[key].button);
    const without = WA_TEMPLATE_KEYS.filter((key) => !WA_TEMPLATES[key].button);
    expect(withButton.length).toBeGreaterThan(0);
    expect(provider.submitTemplate).toHaveBeenCalledTimes(without.length * WA_LANGUAGES.length);
    for (const [payload] of provider.submitTemplate.mock.calls) expect(JSON.stringify(payload)).not.toContain('localhost');

    const failed = db.writes.filter((write) => write.args?.[8] === 'failed');
    expect(failed.map((write) => write.args[3]).sort()).toEqual(withButton.flatMap((key) => WA_LANGUAGES.map(() => key)).sort());
    expect(failed[0].args[10]).toMatch(/^Not submitted: PUBLIC_APP_URL \(http:\/\/localhost:5173\) must start with https:\/\//);
  });
});
