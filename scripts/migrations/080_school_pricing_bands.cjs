#!/usr/bin/env node

// Per-school invoice pricing by exam marks band (#311).
//
// school_pricing_bands: "up to max_marks → price_paise per paper" for a school.
// A school with no rows keeps the default 25 paise per mark.
// invoice_lines.price_paise_per_paper: the per-paper price a banded line was
// billed at (frozen). Default-rule lines keep rate_paise_per_mark and leave this
// NULL; banded lines store rate_paise_per_mark = 0 (074 made it NOT NULL, and
// libSQL can't relax that).
//
// Additive + idempotent (Turso-safe: no VACUUM, no DROP COLUMN). Back up first:
//
//   node scripts/migrations/backupFullDb.cjs
//   node scripts/migrations/080_school_pricing_bands.cjs --dry-run
//   node scripts/migrations/080_school_pricing_bands.cjs --apply
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '080_school_pricing_bands';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  `CREATE TABLE IF NOT EXISTS school_pricing_bands (
    school_id TEXT NOT NULL REFERENCES schools(id),
    max_marks INTEGER NOT NULL,
    price_paise INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (school_id, max_marks)
  )`,
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; create school_pricing_bands and add invoice_lines.price_paise_per_paper (if missing).`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const required = await db.execute("SELECT 1 FROM schema_migrations WHERE id = '074_invoices'");
  if (!required.rows.length) throw new Error('074_invoices is required before this migration.');
  const info = await db.execute('PRAGMA table_info(invoice_lines)');
  const hasColumn = info.rows.some((row) => row.name === 'price_paise_per_paper');
  const allStatements = [...statements, ...(hasColumn ? [] : ['ALTER TABLE invoice_lines ADD COLUMN price_paise_per_paper INTEGER'])];
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(allStatements.join('\n')).digest('hex');
  await db.batch([...allStatements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied ${allStatements.length} change(s) at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
