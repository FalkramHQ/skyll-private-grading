#!/usr/bin/env node

// Enable the mobile_portal_v2 feature flag for every school.
//
// The mobile portal (student answer-sheet gallery, recheck requests + status,
// PDF report share, and the teacher test list in Class Insights) shipped behind
// a per-school rollout gate ("feat: gate mobile portal rollout by school") but
// the flag was never turned on, so those surfaces stayed dark in the intake app
// for all schools. The backing endpoints (api/student-answer-sheet.js,
// api/rechecks/*) are production-ready and school/identity scoped.
//
// Additive + idempotent: UPSERTs one school_feature_flags row per school and is
// a no-op for schools already enabled. Re-running is safe.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '056_enable_mobile_portal_v2';
const FEATURE = 'mobile_portal_v2';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });

  const schools = (await db.execute('SELECT id, display_name FROM schools ORDER BY created_at')).rows;
  if (!schools.length) return console.log(`${migrationId}: no schools found; nothing to do.`);

  const existing = (await db.execute({
    sql: 'SELECT school_id, enabled FROM school_feature_flags WHERE feature_key = ?',
    args: [FEATURE],
  })).rows;
  const enabledBySchool = new Map(existing.map((row) => [row.school_id, Number(row.enabled) === 1]));

  const targets = schools.filter((school) => enabledBySchool.get(school.id) !== true);
  const alreadyOn = schools.length - targets.length;

  if (!targets.length) return console.log(`${migrationId}: ${FEATURE} already enabled for all ${schools.length} school(s); no changes.`);

  console.log(`${migrationId}: enabling ${FEATURE} for ${targets.length} school(s) (${alreadyOn} already on):`);
  for (const school of targets) console.log(`  + ${school.display_name}`);
  if (!apply) return console.log(`${migrationId}: dry run; re-run with --apply to execute.`);

  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const done = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (done.rows.length) return console.log(`${migrationId}: already applied.`);

  const now = new Date().toISOString();
  const upserts = targets.map((school) => ({
    sql: `INSERT INTO school_feature_flags (school_id, feature_key, enabled, updated_by, updated_at)
          VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(school_id, feature_key) DO UPDATE SET
            enabled = 1,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at`,
    args: [school.id, FEATURE, migrationId, now],
  }));
  const checksum = crypto.createHash('sha256').update(JSON.stringify(targets.map((s) => s.id))).digest('hex');
  await db.batch([...upserts, { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: enabled ${FEATURE} for ${upserts.length} school(s) at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
