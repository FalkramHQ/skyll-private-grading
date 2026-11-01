#!/usr/bin/env node

// CRM M1 slice 4 (FLKRM-326): guardian rules (CRM-008, D15). Additive +
// idempotent (Turso-safe).
//
// crm_contacts.consent_source — where WhatsApp consent came from
//   ('staff' | 'roster_import' | 'public_form'); NULL = not recorded.
// crm_guardian_links fee-payer index — at most one active fee payer per
//   student, enforced by the database like the existing primary index.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '066_crm_guardian_rules';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const columns = [['consent_source', 'TEXT']];
const indexes = [
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_guardian_links_fee_payer_idx
    ON crm_guardian_links (student_id) WHERE is_fee_payer = 1 AND status = 'active'`,
];

// Statements for a database that has 061 but not 065 (tests use these).
const statements = [...columns.map(([name, type]) => `ALTER TABLE crm_contacts ADD COLUMN ${name} ${type}`), ...indexes];

async function pendingStatements(db) {
  const info = await db.execute('PRAGMA table_info(crm_contacts)');
  if (!info.rows.length) throw new Error('crm_contacts is required before applying this migration (run 061 first).');
  const existing = new Set(info.rows.map((row) => row.name));
  return [
    ...columns.filter(([name]) => !existing.has(name)).map(([name, type]) => `ALTER TABLE crm_contacts ADD COLUMN ${name} ${type}`),
    ...indexes,
  ];
}

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const clashes = await db.execute(`SELECT student_id FROM crm_guardian_links WHERE status = 'active' AND is_fee_payer = 1
                                    GROUP BY student_id HAVING COUNT(*) > 1`);
  if (clashes.rows.length) throw new Error(`${clashes.rows.length} student(s) have more than one fee payer; fix before applying.`);
  const pending = await pendingStatements(db);
  if (!apply) return console.log(`${migrationId}: dry run; ${pending.length} change(s):\n${pending.join('\n')}`);
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...pending.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied ${pending.length} change(s) at ${now}.`);
}

module.exports = { migrationId, statements, pendingStatements };

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
