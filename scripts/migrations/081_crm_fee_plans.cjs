#!/usr/bin/env node

// CRM M2 phase 1, slice 1 (FLKRM-328): fee plans and fee settings (CRM-017,
// D3/D6). Additive + idempotent (sqld-safe). Money is integer paise.
//
// crm_fee_plans      — reusable fee templates: one-time, instalments, or
//                      monthly (amount × count, due on a day of the month),
//                      optionally for a course. Archived, never deleted.
// crm_fee_plan_items — a plan's charges, each due N days/months after the
//                      start date (instalments and extra one-time items).
// crm_fee_settings   — one row per school: document number prefix and the
//                      header printed on invoices and receipts.
//
// Not to be confused with Skyll's own billing of schools (`invoices`,
// `school_billing_profiles`): every fee table here is crm_-prefixed.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '081_crm_fee_plans';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_fee_plans (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    course_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('one_time', 'instalments', 'monthly')),
    monthly_amount_paise INTEGER CHECK (monthly_amount_paise IS NULL OR monthly_amount_paise > 0),
    monthly_count INTEGER CHECK (monthly_count IS NULL OR monthly_count BETWEEN 1 AND 24),
    monthly_due_day INTEGER CHECK (monthly_due_day IS NULL OR monthly_due_day BETWEEN 1 AND 28),
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((kind = 'monthly') = (monthly_amount_paise IS NOT NULL AND monthly_count IS NOT NULL AND monthly_due_day IS NOT NULL))
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_fee_plans_name_idx ON crm_fee_plans (school_id, name_key)',
  'CREATE INDEX IF NOT EXISTS crm_fee_plans_course_idx ON crm_fee_plans (school_id, course_id, status)',

  `CREATE TABLE IF NOT EXISTS crm_fee_plan_items (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    due_offset_value INTEGER NOT NULL DEFAULT 0 CHECK (due_offset_value >= 0),
    due_offset_unit TEXT NOT NULL DEFAULT 'months' CHECK (due_offset_unit IN ('days', 'months')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_fee_plan_items_plan_idx ON crm_fee_plan_items (school_id, plan_id, position)',

  `CREATE TABLE IF NOT EXISTS crm_fee_settings (
    school_id TEXT NOT NULL PRIMARY KEY,
    prefix TEXT NOT NULL,
    header_name TEXT NOT NULL,
    header_address TEXT,
    header_phone TEXT,
    header_gstin TEXT,
    footer_note TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
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
