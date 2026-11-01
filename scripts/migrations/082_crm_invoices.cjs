#!/usr/bin/env node

// CRM M2 phase 1, slice 2 (FLKRM-328): invoices (CRM-017, D2/D4/D6).
// Additive + idempotent (sqld-safe). Money is integer paise; due and issue
// dates are school-local YYYY-MM-DD.
//
// crm_invoices      — one per due date per student. Only `issued` or `void` is
//                     stored; paid / overdue are computed. Issued invoices are
//                     never edited: a correction voids and re-issues
//                     (`replaces_invoice_id`). Names and the school header are
//                     frozen in `bill_to_json` at issue.
// crm_invoice_lines — the charges on an invoice, copied from the plan.
// crm_doc_counters  — gapless numbering per school, document kind and financial
//                     year, bumped in the same batch as the insert.
//
// No foreign keys to people, so nothing ever cascades (finance is kept 7 years).
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '082_crm_invoices';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_invoices (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    plan_id TEXT,
    number TEXT NOT NULL,
    fy TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0),
    status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
    issue_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    total_paise INTEGER NOT NULL CHECK (total_paise > 0),
    bill_to_json TEXT NOT NULL,
    void_reason TEXT,
    voided_by TEXT,
    voided_at TEXT,
    replaces_invoice_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((status = 'void') = (void_reason IS NOT NULL AND voided_at IS NOT NULL))
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_invoices_number_idx ON crm_invoices (school_id, number)',
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_invoices_seq_idx ON crm_invoices (school_id, fy, seq)',
  'CREATE INDEX IF NOT EXISTS crm_invoices_student_idx ON crm_invoices (school_id, student_id, due_date)',
  'CREATE INDEX IF NOT EXISTS crm_invoices_due_idx ON crm_invoices (school_id, status, due_date)',

  `CREATE TABLE IF NOT EXISTS crm_invoice_lines (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    label TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_invoice_lines_invoice_idx ON crm_invoice_lines (school_id, invoice_id, position)',

  `CREATE TABLE IF NOT EXISTS crm_doc_counters (
    school_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('invoice', 'receipt')),
    fy TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (school_id, kind, fy)
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
