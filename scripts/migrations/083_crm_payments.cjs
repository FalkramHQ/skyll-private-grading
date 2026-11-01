#!/usr/bin/env node

// CRM M2 phase 1, slice 3 (FLKRM-328): payments and allocations (CRM-017,
// D5/D6). Additive + idempotent (sqld-safe). Money is integer paise.
//
// crm_payments            — append-only ledger. A `payment` gets a receipt
//                           number; a mistake is a `reversal` row (reason),
//                           at most one per payment.
// crm_payment_allocations — append-only, signed: + allocates part of a payment
//                           to an invoice, − releases it. Whatever is not
//                           allocated is the student's credit.
//
// The ledger rules live in triggers so they hold inside every batch, even
// when two people record payments at once:
// - an allocation never exceeds the invoice's balance or the payment's
//   unallocated amount, and stays within one student and school;
// - a reversed payment can't be allocated again; a release can't take back
//   more than was allocated;
// - an invoice with money allocated to it can't be voided.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '083_crm_payments';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const appendOnly = (table) => [
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_update
    BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete
    BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
];

const allocated = (column) => `COALESCE((SELECT SUM(x.amount_paise) FROM crm_payment_allocations x WHERE x.school_id = NEW.school_id AND x.${column} = NEW.${column}), 0)`;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_payments (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('payment', 'reversal')),
    reverses_payment_id TEXT,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    received_on TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
    reference TEXT,
    payer_name TEXT,
    note TEXT,
    reason TEXT,
    receipt_number TEXT,
    fy TEXT,
    seq INTEGER,
    created_by TEXT,
    created_at TEXT NOT NULL,
    CHECK ((kind = 'reversal') = (reverses_payment_id IS NOT NULL AND reason IS NOT NULL)),
    CHECK ((kind = 'payment') = (receipt_number IS NOT NULL AND fy IS NOT NULL AND seq IS NOT NULL))
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_payments_reverses_idx ON crm_payments (reverses_payment_id) WHERE reverses_payment_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_payments_receipt_idx ON crm_payments (school_id, receipt_number) WHERE receipt_number IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_payments_seq_idx ON crm_payments (school_id, fy, seq) WHERE seq IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS crm_payments_student_idx ON crm_payments (school_id, student_id, received_on)',
  'CREATE INDEX IF NOT EXISTS crm_payments_received_idx ON crm_payments (school_id, received_on)',
  ...appendOnly('crm_payments'),
  // A reversal must mirror an existing payment of the same school and student.
  `CREATE TRIGGER IF NOT EXISTS crm_payments_reversal_check
    BEFORE INSERT ON crm_payments WHEN NEW.kind = 'reversal'
    BEGIN
      SELECT RAISE(ABORT, 'reversal_mismatch') WHERE NOT EXISTS (
        SELECT 1 FROM crm_payments p WHERE p.id = NEW.reverses_payment_id AND p.school_id = NEW.school_id AND p.student_id = NEW.student_id
          AND p.kind = 'payment' AND p.amount_paise = NEW.amount_paise);
    END`,

  `CREATE TABLE IF NOT EXISTS crm_payment_allocations (
    id TEXT NOT NULL PRIMARY KEY,
    school_id TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    invoice_id TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise <> 0),
    reason TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_payment_allocations_invoice_idx ON crm_payment_allocations (school_id, invoice_id)',
  'CREATE INDEX IF NOT EXISTS crm_payment_allocations_payment_idx ON crm_payment_allocations (school_id, payment_id, invoice_id)',
  ...appendOnly('crm_payment_allocations'),
  `CREATE TRIGGER IF NOT EXISTS crm_payment_allocations_allocate_check
    BEFORE INSERT ON crm_payment_allocations WHEN NEW.amount_paise > 0
    BEGIN
      SELECT RAISE(ABORT, 'allocation_invalid') WHERE NOT EXISTS (
        SELECT 1 FROM crm_payments p JOIN crm_invoices i ON i.id = NEW.invoice_id AND i.school_id = NEW.school_id AND i.student_id = p.student_id AND i.status = 'issued'
        WHERE p.id = NEW.payment_id AND p.school_id = NEW.school_id AND p.kind = 'payment');
      SELECT RAISE(ABORT, 'payment_reversed') WHERE EXISTS (
        SELECT 1 FROM crm_payments r WHERE r.reverses_payment_id = NEW.payment_id AND r.school_id = NEW.school_id);
      SELECT RAISE(ABORT, 'allocation_exceeds_invoice')
        WHERE NEW.amount_paise > (SELECT total_paise FROM crm_invoices WHERE id = NEW.invoice_id AND school_id = NEW.school_id) - ${allocated('invoice_id')};
      SELECT RAISE(ABORT, 'allocation_exceeds_payment')
        WHERE NEW.amount_paise > (SELECT amount_paise FROM crm_payments WHERE id = NEW.payment_id AND school_id = NEW.school_id) - ${allocated('payment_id')};
    END`,
  `CREATE TRIGGER IF NOT EXISTS crm_payment_allocations_release_check
    BEFORE INSERT ON crm_payment_allocations WHEN NEW.amount_paise < 0
    BEGIN
      SELECT RAISE(ABORT, 'release_exceeds_allocation')
        WHERE -NEW.amount_paise > COALESCE((SELECT SUM(x.amount_paise) FROM crm_payment_allocations x
                                            WHERE x.school_id = NEW.school_id AND x.payment_id = NEW.payment_id AND x.invoice_id = NEW.invoice_id), 0);
    END`,
  // D4: void only when nothing is allocated.
  `CREATE TRIGGER IF NOT EXISTS crm_invoices_void_check
    BEFORE UPDATE OF status ON crm_invoices WHEN NEW.status = 'void' AND OLD.status = 'issued'
    BEGIN
      SELECT RAISE(ABORT, 'invoice_has_payments')
        WHERE COALESCE((SELECT SUM(x.amount_paise) FROM crm_payment_allocations x WHERE x.school_id = OLD.school_id AND x.invoice_id = OLD.id), 0) > 0;
    END`,
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
