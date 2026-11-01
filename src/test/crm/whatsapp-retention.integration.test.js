// @vitest-environment node
// Message retention and erasure (CRM M2 phase 2 S6, D14).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { COMMS_MIGRATIONS, CRM_MIGRATIONS, migrationStatements } from './classesHarness.js';
import { eraseContactStatements, runRetention } from '../../../server/comms/retention.js';

let dir;
let db;
const NOW = Date.parse('2027-11-01T00:00:00.000Z');
const OLD = '2026-10-01T00:00:00.000Z';
const RECENT = '2027-10-01T00:00:00.000Z';

beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'crm-waret-')); });
afterAll(async () => { db?.close(); await rm(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  db?.close();
  db = createClient({ url: `file:${path.join(dir, `${Math.random()}.db`)}` });
  await db.batch([...migrationStatements([...CRM_MIGRATIONS, ...COMMS_MIGRATIONS]),
    `INSERT INTO crm_contacts (id, school_id, full_name, phone_e164, whatsapp_opted_in, created_at, updated_at) VALUES
       ('ct_k', 'sch_a', 'Kavita', '+919800000001', 1, '${OLD}', '${OLD}'), ('ct_r', 'sch_a', 'Rohit', '+919800000002', 1, '${OLD}', '${OLD}')`,
    ...[['m_old', 'ct_k', OLD], ['m_new', 'ct_k', RECENT], ['m_rohit', 'ct_r', RECENT]].map(([id, contact, at]) => `INSERT INTO crm_comms_messages
       (id, school_id, via, kind, status, contact_id, phone_e164, recipient_name, body_text, vars_json, dedup_key, created_at, updated_at)
       VALUES ('${id}', 'sch_a', 'api', 'notice', 'read', '${contact}', '+91', 'Name', 'Hello', '{"a":1}', '${id}', '${at}', '${at}')`),
    `INSERT INTO crm_comms_inbound (id, school_id, connection_id, provider_message_id, from_phone, contact_id, kind, body_text, received_at, created_at, updated_at) VALUES
       ('i_old', 'sch_a', 'c', 'w1', '+919800000001', 'ct_k', 'text', 'old reply', '${OLD}', '${OLD}', '${OLD}'),
       ('i_new', 'sch_a', 'c', 'w2', '+919800000002', 'ct_r', 'text', 'new reply', '${RECENT}', '${RECENT}', '${RECENT}')`,
  ], 'write');
});

const all = async (table) => (await db.execute(`SELECT * FROM ${table} ORDER BY id`)).rows;

describe('message retention (S6, D14)', () => {
  it('drops text older than a year but keeps the record, once', async () => {
    expect(await runRetention(db, { now: NOW })).toMatchObject({ messages: 1, replies: 1 });
    const messages = await all('crm_comms_messages');
    expect(messages.find((m) => m.id === 'm_old')).toMatchObject({ body_text: null, vars_json: null, kind: 'notice', status: 'read', contact_id: 'ct_k', recipient_name: 'Name' });
    expect(messages.find((m) => m.id === 'm_new').body_text).toBe('Hello');
    expect(Object.fromEntries((await all('crm_comms_inbound')).map((i) => [i.id, i.body_text]))).toEqual({ i_old: null, i_new: 'new reply' });
    expect(await runRetention(db, { now: NOW })).toMatchObject({ queued: 0 });
  });

  it('wipes an erased contact’s messages, replies and phone, by statement or by the sweep', async () => {
    await db.batch(eraseContactStatements('sch_a', 'ct_k', '2027-10-15T00:00:00.000Z'), 'write');
    const kavita = (await all('crm_comms_messages')).filter((m) => m.contact_id === 'ct_k');
    expect(kavita.every((m) => m.body_text === null && m.phone_e164 === null && m.recipient_name === null && m.anonymised_at)).toBe(true);
    expect((await all('crm_comms_inbound')).find((i) => i.id === 'i_old')).toMatchObject({ body_text: null, from_phone: '', anonymised_at: '2027-10-15T00:00:00.000Z' });

    await db.execute("UPDATE crm_contacts SET anonymised_at = '2027-10-20T00:00:00.000Z', phone_e164 = NULL WHERE id = 'ct_r'");
    expect(await runRetention(db, { now: Date.parse('2027-10-21T00:00:00.000Z') })).toMatchObject({ erasedMessages: 1, erasedReplies: 1 });
    expect((await all('crm_comms_messages')).find((m) => m.id === 'm_rohit')).toMatchObject({ body_text: null, phone_e164: null, kind: 'notice', status: 'read' });
  });
});
