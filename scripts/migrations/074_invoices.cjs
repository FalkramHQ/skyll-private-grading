#!/usr/bin/env node

// Skyll invoices (FLKRM-486): invoices, their frozen lines, the papers each
// one billed, and a per-financial-year counter for SKY/<FY>/<seq> numbers.
//
// The database itself enforces the billing rules that must survive races:
//   - invoices_live_period_idx: one issued invoice per (school, month);
//   - invoice_papers_live_idx: a paper is on at most one live invoice
//     (voiding sets released_at, which frees it);
//   - UNIQUE(fy, seq) / UNIQUE(number): numbers never repeat.
// The counter row is bumped in the same write batch that inserts the invoice,
// so a refused or failed generation never leaves a gap.
//
// Additive + idempotent (Turso-safe: no VACUUM, no DROP COLUMN). Back up first:
//
//   node scripts/migrations/backupFullDb.cjs
//   node scripts/migrations/074_invoices.cjs --dry-run
//   node scripts/migrations/074_invoices.cjs --apply
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '074_invoices';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  `CREATE TABLE IF NOT EXISTS invoice_counters (
    fy TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL REFERENCES schools(id),
    period TEXT NOT NULL,
    fy TEXT NOT NULL,
    seq INTEGER NOT NULL,
    number TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('issued', 'void')),
    invoice_date TEXT NOT NULL,
    paper_count INTEGER NOT NULL,
    subtotal_paise INTEGER NOT NULL,
    round_off_paise INTEGER NOT NULL,
    total_paise INTEGER NOT NULL,
    bill_to_json TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    voided_by TEXT,
    voided_at TEXT,
    void_reason TEXT,
    paid_on TEXT,
    paid_reference TEXT,
    paid_marked_by TEXT,
    paid_marked_at TEXT,
    pdf_key TEXT,
    UNIQUE(fy, seq)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS invoices_live_period_idx ON invoices (school_id, period) WHERE status = 'issued'",
  'CREATE INDEX IF NOT EXISTS invoices_school_issued_idx ON invoices (school_id, issued_at)',
  `CREATE TABLE IF NOT EXISTS invoice_lines (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL REFERENCES invoices(id),
    position INTEGER NOT NULL,
    exam_id TEXT,
    exam_name TEXT NOT NULL,
    exam_date TEXT,
    max_marks REAL NOT NULL,
    papers INTEGER NOT NULL,
    rate_paise_per_mark INTEGER NOT NULL,
    amount_paise INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS invoice_lines_invoice_idx ON invoice_lines (invoice_id, position)',
  `CREATE TABLE IF NOT EXISTS invoice_papers (
    invoice_id TEXT NOT NULL REFERENCES invoices(id),
    submission_id TEXT NOT NULL,
    exam_id TEXT,
    student_id TEXT,
    student_name TEXT,
    max_marks REAL NOT NULL,
    amount_paise INTEGER NOT NULL,
    graded_at TEXT,
    released_at TEXT,
    PRIMARY KEY (invoice_id, submission_id)
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS invoice_papers_live_idx ON invoice_papers (submission_id) WHERE released_at IS NULL',
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${statements.length} change(s): invoice_counters, invoices, invoice_lines, invoice_papers and their indexes.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const required = await db.execute("SELECT id FROM schema_migrations WHERE id IN ('072_submission_graded_at', '073_school_billing_profiles')");
  if (required.rows.length !== 2) throw new Error('072_submission_graded_at and 073_school_billing_profiles are required before this migration.');
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([...statements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied ${statements.length} change(s) at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
