#!/usr/bin/env node

// Guardian contacts become the single home for parent phone numbers
// (FLKRM-325, slice 4). Additive + idempotent (Turso-safe).
//
// crm_contacts        — a person the school can reach (guardian today; lead
//                       inquirers later). Phone is E.164. PII: see
//                       docs/CRM_CONTRACTS.md §4.
// crm_guardian_links  — contact ↔ student with relationship and roles
//                       (primary / emergency / fee payer). At most one active
//                       primary guardian per student. Removing a link never
//                       deletes the contact.
//
// students.parent_* (migration 054) becomes legacy: nothing writes it after
// this slice. Any values found are copied into contacts + primary links.
//
//   node scripts/migrations/061_crm_contacts.cjs               dry run
//   node scripts/migrations/061_crm_contacts.cjs --apply       tables + backfill
//   node scripts/migrations/061_crm_contacts.cjs --backfill    re-run the copy only
//     (use right after the slice-4 deploy: the previous code may still have
//      written students.parent_* until then)
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '061_crm_contacts';
const apply = process.argv.includes('--apply');
const backfillOnly = process.argv.includes('--backfill');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_contacts (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    full_name TEXT,
    phone_e164 TEXT,
    email TEXT,
    preferred_channel TEXT NOT NULL DEFAULT 'whatsapp',
    whatsapp_opted_in INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_opted_in IN (0, 1)),
    consent_at TEXT,
    anonymised_at TEXT,
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_contacts_phone_idx ON crm_contacts (school_id, phone_e164)',
  'CREATE INDEX IF NOT EXISTS crm_contacts_email_idx ON crm_contacts (school_id, email)',
  'CREATE INDEX IF NOT EXISTS crm_contacts_school_idx ON crm_contacts (school_id, archived_at)',

  `CREATE TABLE IF NOT EXISTS crm_guardian_links (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    relationship TEXT NOT NULL DEFAULT 'guardian',
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    is_emergency INTEGER NOT NULL DEFAULT 0 CHECK (is_emergency IN (0, 1)),
    is_fee_payer INTEGER NOT NULL DEFAULT 0 CHECK (is_fee_payer IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT,
    UNIQUE (student_id, contact_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_guardian_links_primary_idx
    ON crm_guardian_links (student_id) WHERE is_primary = 1 AND status = 'active'`,
  'CREATE INDEX IF NOT EXISTS crm_guardian_links_student_idx ON crm_guardian_links (school_id, student_id, status)',
  'CREATE INDEX IF NOT EXISTS crm_guardian_links_contact_idx ON crm_guardian_links (school_id, contact_id)',
];

// Copies legacy students.parent_* into a contact + active primary link per
// student. Deterministic ids + OR IGNORE make it safe to run any number of
// times; students that already have a primary guardian are skipped.
function backfillStatements(now) {
  const legacy = `FROM students s
    WHERE s.parent_phone IS NOT NULL AND TRIM(s.parent_phone) <> '' AND s.school_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM crm_guardian_links g WHERE g.student_id = s.id AND g.is_primary = 1 AND g.status = 'active')`;
  return [
    {
      sql: `INSERT OR IGNORE INTO crm_contacts (id, school_id, full_name, phone_e164, whatsapp_opted_in, consent_at, created_by, created_at, updated_at)
            SELECT 'ct_legacy_' || s.id, s.school_id, s.parent_name, s.parent_phone,
                   CASE WHEN s.parent_whatsapp_opted_in = 1 THEN 1 ELSE 0 END,
                   CASE WHEN s.parent_whatsapp_opted_in = 1 THEN ? END, 'migration:061', ?, ?
            ${legacy}`,
      args: [now, now, now],
    },
    {
      sql: `INSERT OR IGNORE INTO crm_guardian_links (id, school_id, student_id, contact_id, relationship, is_primary, created_at, updated_at)
            SELECT 'gl_legacy_' || s.id, s.school_id, s.id, 'ct_legacy_' || s.id, 'guardian', 1, ?, ?
            ${legacy}`,
      args: [now, now],
    },
  ];
}

async function legacyCount(db) {
  const info = await db.execute('PRAGMA table_info(students)');
  if (!info.rows.some((row) => row.name === 'parent_phone')) return 0;
  const result = await db.execute("SELECT COUNT(*) AS n FROM students WHERE parent_phone IS NOT NULL AND TRIM(parent_phone) <> ''");
  return Number(result.rows[0].n);
}

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  const legacy = await legacyCount(db);

  if (backfillOnly) {
    const results = await db.batch(backfillStatements(new Date().toISOString()), 'write');
    console.log(`${migrationId}: backfill copied ${results[1].rowsAffected} guardian link(s) from ${legacy} legacy parent phone(s).`);
    return;
  }
  if (!apply) {
    console.log(`${migrationId}: dry run; ${statements.length} statements + backfill of ${legacy} legacy parent phone(s).`);
    return;
  }

  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied (use --backfill to re-run the copy).`);
  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  const results = await db.batch([
    ...statements.map((sql) => ({ sql })),
    ...backfillStatements(now),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied ${statements.length} statement(s); backfilled ${results[statements.length + 1].rowsAffected} guardian link(s) at ${now}.`);
}

module.exports = { migrationId, statements, backfillStatements };

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
