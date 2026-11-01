#!/usr/bin/env node

// CRM capability grants, immutable audit log, and idempotency keys
// (FLKRM-325, slice 2). Additive + idempotent (Turso-safe).
//
// crm_capability_grants  — per-user CRM capabilities on top of role defaults;
//                          revoked rows are kept (revoked_at) for history
// crm_audit_events       — append-only; triggers reject UPDATE and DELETE, and
//                          there are no foreign keys, so deleting or archiving a
//                          business record can never erase its history
// crm_idempotency_keys   — replay protection for retried POSTs
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '059_crm_access_audit';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_capability_grants (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_capability_grants_active_idx
    ON crm_capability_grants (school_id, user_id, capability) WHERE revoked_at IS NULL`,
  'CREATE INDEX IF NOT EXISTS crm_capability_grants_user_idx ON crm_capability_grants (school_id, user_id, revoked_at)',

  `CREATE TABLE IF NOT EXISTS crm_audit_events (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    actor_user_id TEXT,
    actor_role TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    summary_json TEXT NOT NULL DEFAULT '{}',
    request_id TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_audit_events_school_created_idx ON crm_audit_events (school_id, created_at, id)',
  'CREATE INDEX IF NOT EXISTS crm_audit_events_entity_idx ON crm_audit_events (school_id, entity_type, entity_id, created_at)',
  'CREATE INDEX IF NOT EXISTS crm_audit_events_actor_idx ON crm_audit_events (school_id, actor_user_id, created_at)',
  `CREATE TRIGGER IF NOT EXISTS crm_audit_events_no_update
    BEFORE UPDATE ON crm_audit_events
    BEGIN SELECT RAISE(ABORT, 'crm_audit_events is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS crm_audit_events_no_delete
    BEFORE DELETE ON crm_audit_events
    BEGIN SELECT RAISE(ABORT, 'crm_audit_events is append-only'); END`,

  `CREATE TABLE IF NOT EXISTS crm_idempotency_keys (
    school_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (school_id, user_id, idempotency_key)
  )`,
  'CREATE INDEX IF NOT EXISTS crm_idempotency_keys_created_idx ON crm_idempotency_keys (created_at)',
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
