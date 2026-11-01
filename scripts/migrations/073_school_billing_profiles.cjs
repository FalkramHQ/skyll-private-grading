#!/usr/bin/env node

// school_billing_profiles: Bill To details for Skyll invoices (FLKRM-485).
//
// One row per school: legal name, address (printed as-is in the invoice's
// Bill To block), optional GSTIN and PAN, and place of supply (an Indian state
// or union territory, validated by the API). The profile also decides who is
// invoiced: schools without one (demo and internal schools) are never billed.
//
// Additive + idempotent (Turso-safe: no VACUUM, no DROP COLUMN). Back up first:
//
//   node scripts/migrations/backupFullDb.cjs
//   node scripts/migrations/073_school_billing_profiles.cjs --dry-run
//   node scripts/migrations/073_school_billing_profiles.cjs --apply
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '073_school_billing_profiles';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  `CREATE TABLE IF NOT EXISTS school_billing_profiles (
    school_id TEXT PRIMARY KEY REFERENCES schools(id),
    legal_name TEXT NOT NULL,
    address TEXT NOT NULL,
    gstin TEXT,
    pan TEXT,
    place_of_supply TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${statements.length} change(s): create school_billing_profiles.`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const schools = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schools'");
  if (!schools.rows.length) throw new Error('schools is required before applying this migration.');
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([...statements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied ${statements.length} change(s) at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
