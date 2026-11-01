#!/usr/bin/env node

// CRM M2 phase 2, slice 1 (FLKRM-328): each class's own WhatsApp number
// (CRM-020, D2/D6/D7). Additive + idempotent (sqld-safe).
//
// crm_wa_connections — the class's WhatsApp Business number, connected through
//                      Meta's Embedded Signup (or manually / the test provider
//                      by platform staff). The business token is stored
//                      AES-GCM encrypted and wiped on disconnect. At most one
//                      connected row per school and per Meta phone number id.
// crm_wa_settings    — one row per school: the class details that fill the
//                      fixed template blanks, language, automatic-message
//                      switches, the fee reminder schedule and a monthly limit.
// crm_wa_templates   — Meta's approval state of Skyll's templates for each
//                      connection (the wording itself is versioned data in
//                      shared/crm/waTemplates.js).
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '085_crm_whatsapp';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_wa_connections (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('meta', 'test')),
    mode TEXT NOT NULL CHECK (mode IN ('embedded', 'manual', 'test')),
    status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
    waba_id TEXT,
    phone_number_id TEXT NOT NULL,
    business_id TEXT,
    display_phone TEXT,
    verified_name TEXT,
    coexistence INTEGER NOT NULL DEFAULT 0 CHECK (coexistence IN (0, 1)),
    token_enc TEXT,
    pin_enc TEXT,
    health TEXT NOT NULL DEFAULT 'ok' CHECK (health IN ('ok', 'blocked')),
    health_code TEXT,
    health_reason TEXT,
    health_at TEXT,
    quality_rating TEXT,
    connected_by TEXT,
    connected_at TEXT NOT NULL,
    disconnected_by TEXT,
    disconnected_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_wa_connections_school_connected_idx
    ON crm_wa_connections (school_id) WHERE status = 'connected'`,
  // Meta's webhooks name only the phone number id, so it must map to one school.
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_wa_connections_phone_connected_idx
    ON crm_wa_connections (phone_number_id) WHERE status = 'connected'`,
  'CREATE INDEX IF NOT EXISTS crm_wa_connections_school_idx ON crm_wa_connections (school_id, connected_at)',

  `CREATE TABLE IF NOT EXISTS crm_wa_settings (
    school_id TEXT NOT NULL PRIMARY KEY,
    language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi')),
    sender_name TEXT,
    contact_line TEXT,
    payment_instructions TEXT,
    auto_fee_due INTEGER NOT NULL DEFAULT 1 CHECK (auto_fee_due IN (0, 1)),
    auto_fee_overdue INTEGER NOT NULL DEFAULT 1 CHECK (auto_fee_overdue IN (0, 1)),
    auto_receipt INTEGER NOT NULL DEFAULT 1 CHECK (auto_receipt IN (0, 1)),
    auto_report_ready INTEGER NOT NULL DEFAULT 1 CHECK (auto_report_ready IN (0, 1)),
    auto_absent INTEGER NOT NULL DEFAULT 1 CHECK (auto_absent IN (0, 1)),
    remind_days_before INTEGER NOT NULL DEFAULT 3 CHECK (remind_days_before BETWEEN 0 AND 15),
    overdue_first_day INTEGER NOT NULL DEFAULT 1 CHECK (overdue_first_day BETWEEN 1 AND 30),
    overdue_gap_days INTEGER NOT NULL DEFAULT 7 CHECK (overdue_gap_days BETWEEN 1 AND 30),
    overdue_count INTEGER NOT NULL DEFAULT 3 CHECK (overdue_count BETWEEN 0 AND 5),
    send_hour INTEGER NOT NULL DEFAULT 10 CHECK (send_hour BETWEEN 8 AND 20),
    monthly_limit_paise INTEGER CHECK (monthly_limit_paise IS NULL OR monthly_limit_paise > 0),
    version INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS crm_wa_templates (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    template_key TEXT NOT NULL,
    language TEXT NOT NULL,
    version INTEGER NOT NULL,
    meta_name TEXT NOT NULL,
    meta_template_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paused', 'disabled', 'failed')),
    category TEXT,
    reason TEXT,
    submitted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_wa_templates_connection_name_idx
    ON crm_wa_templates (connection_id, meta_name, language)`,
  'CREATE INDEX IF NOT EXISTS crm_wa_templates_school_idx ON crm_wa_templates (school_id, connection_id)',
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
