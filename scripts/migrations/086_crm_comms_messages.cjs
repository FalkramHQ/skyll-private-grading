#!/usr/bin/env node

// CRM M2 phase 2, slice 2 (FLKRM-328): the message outbox and history, and
// parents' replies (CRM-020/021, D8/D9/D12/D14). Additive + idempotent.
//
// Named crm_comms_* because an empty prototype table called `crm_messages`
// keeps reappearing on the VM database (see CRM_M1B_IMPLEMENTATION.md, S5).
//
// crm_comms_messages    — one row per recipient phone. API routes and the
//                         planner only insert rows (status `queued`); the OCI
//                         worker claims them with a lease and sends. A dedup
//                         key, unique per school among rows not cancelled,
//                         makes every insert safe to repeat. `skipped` rows
//                         note automatic messages that weren't queued.
// crm_comms_subjects    — which student or lead timelines a message belongs
//                         on (one notice to a guardian of two students shows
//                         on both). Insert-only.
// crm_comms_inbound     — every message a parent sends to the class's number:
//                         replies, STOP, and the 24-hour window. No media.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '086_crm_comms_messages';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_comms_messages (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
    via TEXT NOT NULL CHECK (via IN ('api', 'phone')),
    kind TEXT NOT NULL CHECK (kind IN ('fee_due', 'fee_overdue', 'fee_manual', 'receipt', 'report_ready', 'absent', 'notice', 'free_text', 'stop_ack')),
    connection_id TEXT,
    template_key TEXT,
    template_language TEXT,
    template_version INTEGER,
    contact_id TEXT,
    phone_e164 TEXT,
    recipient_name TEXT,
    vars_json TEXT,
    body_text TEXT,
    ref_type TEXT,
    ref_id TEXT,
    ref_json TEXT,
    finance INTEGER NOT NULL DEFAULT 0 CHECK (finance IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('queued', 'held', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled', 'skipped')),
    status_code TEXT,
    status_reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    provider_message_id TEXT,
    dedup_key TEXT NOT NULL,
    group_id TEXT,
    pricing_category TEXT,
    cost_millipaise INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    sent_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    failed_at TEXT,
    text_purged_at TEXT,
    anonymised_at TEXT
  )`,
  // A cancelled message frees its key, so the same message can be queued again later.
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_comms_messages_dedup_idx
    ON crm_comms_messages (school_id, dedup_key) WHERE status != 'cancelled'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_comms_messages_provider_idx
    ON crm_comms_messages (provider_message_id) WHERE provider_message_id IS NOT NULL`,
  'CREATE INDEX IF NOT EXISTS crm_comms_messages_dispatch_idx ON crm_comms_messages (school_id, status, next_attempt_at)',
  "CREATE INDEX IF NOT EXISTS crm_comms_messages_queue_idx ON crm_comms_messages (status, next_attempt_at) WHERE status IN ('queued', 'sending', 'held')",
  'CREATE INDEX IF NOT EXISTS crm_comms_messages_created_idx ON crm_comms_messages (school_id, created_at)',
  'CREATE INDEX IF NOT EXISTS crm_comms_messages_contact_idx ON crm_comms_messages (school_id, contact_id, created_at)',
  'CREATE INDEX IF NOT EXISTS crm_comms_messages_group_idx ON crm_comms_messages (school_id, group_id)',

  `CREATE TABLE IF NOT EXISTS crm_comms_subjects (
    message_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('student', 'lead')),
    entity_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (message_id, entity_type, entity_id)
  )`,
  'CREATE INDEX IF NOT EXISTS crm_comms_subjects_entity_idx ON crm_comms_subjects (school_id, entity_type, entity_id)',

  `CREATE TABLE IF NOT EXISTS crm_comms_inbound (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    from_phone TEXT NOT NULL,
    contact_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'media', 'button', 'other')),
    body_text TEXT,
    media_label TEXT,
    is_stop INTEGER NOT NULL DEFAULT 0 CHECK (is_stop IN (0, 1)),
    received_at TEXT NOT NULL,
    text_purged_at TEXT,
    anonymised_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_comms_inbound_provider_idx ON crm_comms_inbound (provider_message_id)',
  'CREATE INDEX IF NOT EXISTS crm_comms_inbound_window_idx ON crm_comms_inbound (school_id, from_phone, received_at)',
  'CREATE INDEX IF NOT EXISTS crm_comms_inbound_contact_idx ON crm_comms_inbound (school_id, contact_id, received_at)',

  // Message subjects are history: they never change.
  `CREATE TRIGGER IF NOT EXISTS crm_comms_subjects_no_update
    BEFORE UPDATE ON crm_comms_subjects
    BEGIN SELECT RAISE(ABORT, 'crm_comms_subjects is insert-only'); END`,
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${statements.length} statements.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...statements.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied ${statements.length} statement(s) at ${now}.`);
}

module.exports = { migrationId, statements };

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
