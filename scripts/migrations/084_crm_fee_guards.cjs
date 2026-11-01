#!/usr/bin/env node

// CRM M2 phase 1, slice 3 follow-up (FLKRM-328 security review): database
// guards for the fee ledger. Additive + idempotent (sqld-safe).
//
// crm_payment_requests — one row per (school, user, Idempotency-Key) that
//                        recorded a payment, written in the payment's batch,
//                        so a retried or doubled request can never record the
//                        same payment twice or use a second receipt number.
// Triggers:
// - an issued invoice can only change by being voided (status and void fields);
// - invoice lines are append-only;
// - document counters never go backwards and are never deleted.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '084_crm_fee_guards';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_payment_requests (
    school_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (school_id, user_id, request_key)
  )`,

  // Only issued → void, and only the void fields (and updated_at) may change.
  `CREATE TRIGGER IF NOT EXISTS crm_invoices_immutable
    BEFORE UPDATE ON crm_invoices
    WHEN NOT (OLD.status = 'issued' AND NEW.status = 'void'
      AND NEW.id IS OLD.id AND NEW.school_id IS OLD.school_id AND NEW.student_id IS OLD.student_id AND NEW.plan_id IS OLD.plan_id AND NEW.number IS OLD.number AND NEW.fy IS OLD.fy AND NEW.seq IS OLD.seq AND NEW.issue_date IS OLD.issue_date AND NEW.due_date IS OLD.due_date AND NEW.total_paise IS OLD.total_paise AND NEW.bill_to_json IS OLD.bill_to_json AND NEW.replaces_invoice_id IS OLD.replaces_invoice_id AND NEW.created_by IS OLD.created_by AND NEW.created_at IS OLD.created_at)
    BEGIN SELECT RAISE(ABORT, 'crm_invoices: issued invoices are never edited'); END`,
  `CREATE TRIGGER IF NOT EXISTS crm_invoices_no_delete
    BEFORE DELETE ON crm_invoices
    BEGIN SELECT RAISE(ABORT, 'crm_invoices is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS crm_invoice_lines_no_update
    BEFORE UPDATE ON crm_invoice_lines
    BEGIN SELECT RAISE(ABORT, 'crm_invoice_lines is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS crm_invoice_lines_no_delete
    BEFORE DELETE ON crm_invoice_lines
    BEGIN SELECT RAISE(ABORT, 'crm_invoice_lines is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS crm_doc_counters_forward_only
    BEFORE UPDATE ON crm_doc_counters
    WHEN NEW.last_seq < OLD.last_seq OR NEW.school_id IS NOT OLD.school_id OR NEW.kind IS NOT OLD.kind OR NEW.fy IS NOT OLD.fy
    BEGIN SELECT RAISE(ABORT, 'crm_doc_counters only move forward'); END`,
  `CREATE TRIGGER IF NOT EXISTS crm_doc_counters_no_delete
    BEFORE DELETE ON crm_doc_counters
    BEGIN SELECT RAISE(ABORT, 'crm_doc_counters are never deleted'); END`,
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
