#!/usr/bin/env node

// CRM M1 slice 2 (FLKRM-326): follow-up tasks (CRM-012). Additive + idempotent
// (Turso-safe).
//
// crm_tasks        — a to-do with an owner, due time (UTC), priority and an
//                    optional related lead or student. Status follows
//                    TASK_MACHINE (open → done | cancelled, done → open).
//                    owner_user_id is NULL for unassigned tasks.
// crm_task_events  — append-only history (created, completed, reopened,
//                    cancelled, rescheduled, reassigned); triggers block
//                    UPDATE/DELETE, as for crm_lead_stage_events.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '065_crm_tasks';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_tasks (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT,
    owner_user_id TEXT,
    due_at TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
    related_type TEXT CHECK (related_type IN ('lead', 'student')),
    related_id TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
    completed_at TEXT,
    completed_by TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((related_type IS NULL) = (related_id IS NULL))
  )`,
  'CREATE INDEX IF NOT EXISTS crm_tasks_owner_due_idx ON crm_tasks (school_id, owner_user_id, status, due_at)',
  'CREATE INDEX IF NOT EXISTS crm_tasks_due_idx ON crm_tasks (school_id, status, due_at)',
  'CREATE INDEX IF NOT EXISTS crm_tasks_related_idx ON crm_tasks (school_id, related_type, related_id, status)',

  `CREATE TABLE IF NOT EXISTS crm_task_events (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('created', 'completed', 'reopened', 'cancelled', 'rescheduled', 'reassigned')),
    from_value TEXT,
    to_value TEXT,
    actor_user_id TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_task_events_task_idx ON crm_task_events (school_id, task_id, created_at)',
  `CREATE TRIGGER IF NOT EXISTS crm_task_events_no_update
    BEFORE UPDATE ON crm_task_events
    BEGIN SELECT RAISE(ABORT, 'crm_task_events is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS crm_task_events_no_delete
    BEFORE DELETE ON crm_task_events
    BEGIN SELECT RAISE(ABORT, 'crm_task_events is append-only'); END`,
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
