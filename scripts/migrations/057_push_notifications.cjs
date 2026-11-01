#!/usr/bin/env node

// Push-notification outbox + per-installation Expo push tokens.
//
// Adds the transactional outbox the OCI worker drains to deliver Expo push
// notifications (report published, recheck resolved, processing complete), and
// extends intake_installations with the device's Expo push token + role so a
// notification can target one student (school + username) or a role broadcast
// (school + role='admin'). See api/_lib/pushOutbox.js for the delivery flow.
//
// Additive + idempotent: CREATE TABLE/INDEX IF NOT EXISTS, and ADD COLUMN is
// skipped when the column already exists. Re-running is safe.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '057_push_notifications';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const DDL = [
  `CREATE TABLE IF NOT EXISTS push_notifications (
    id TEXT PRIMARY KEY,
    school TEXT NOT NULL,
    username TEXT,
    role TEXT,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS push_notifications_drain_idx ON push_notifications (status, created_at)',
  'CREATE INDEX IF NOT EXISTS push_notifications_target_idx ON push_notifications (school, username)',
];
const COLUMNS = ['expo_push_token TEXT', 'role TEXT'];

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });

  console.log(`${migrationId}: create push_notifications outbox (+2 indexes); add intake_installations columns [${COLUMNS.map((c) => c.split(' ')[0]).join(', ')}].`);
  if (!apply) return console.log(`${migrationId}: dry run; re-run with --apply to execute.`);

  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const done = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (done.rows.length) return console.log(`${migrationId}: already applied.`);

  for (const sql of DDL) await db.execute(sql);
  console.log('  + push_notifications table and indexes');
  for (const column of COLUMNS) {
    const name = column.split(' ')[0];
    try {
      await db.execute({ sql: `ALTER TABLE intake_installations ADD COLUMN ${column}` });
      console.log(`  + intake_installations.${name}`);
    } catch {
      console.log(`  = intake_installations.${name} already exists`);
    }
  }

  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(`${migrationId}:${DDL.join(';')}:${COLUMNS.join(',')}`).digest('hex');
  await db.execute({ sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] });
  console.log(`${migrationId}: applied at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
