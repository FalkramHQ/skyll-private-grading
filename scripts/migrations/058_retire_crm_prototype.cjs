#!/usr/bin/env node

// Retire the classes-first CRM prototype tables (FLKRM-325, slice 1).
//
// The prototype handler created crm_leads, crm_interactions, crm_fees,
// crm_attendance, and crm_messages at runtime. The M0 CRM replaces them with
// migrated tables, and their names would otherwise collide with new
// CREATE TABLE IF NOT EXISTS statements and silently keep the old shape.
//
// Each table is renamed to _deprecated_<name> only when it is EMPTY. If any
// table holds rows, nothing is renamed and the migration aborts so the data
// can be reviewed first. Turso-safe: RENAME only, no DROP.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '058_retire_crm_prototype';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const prototypeTables = ['crm_leads', 'crm_interactions', 'crm_fees', 'crm_attendance', 'crm_messages'];

async function tableExists(db, name) {
  const result = await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [name] });
  return result.rows.length > 0;
}

async function plan(db) {
  const renames = [];
  const blocked = [];
  for (const name of prototypeTables) {
    if (!(await tableExists(db, name))) continue;
    const target = `_deprecated_${name}`;
    if (await tableExists(db, target)) {
      blocked.push(`${name} (target ${target} already exists)`);
      continue;
    }
    const count = Number((await db.execute(`SELECT COUNT(*) AS n FROM ${name}`)).rows[0].n);
    if (count > 0) blocked.push(`${name} (${count} rows)`);
    else renames.push(`ALTER TABLE ${name} RENAME TO ${target}`);
  }
  return { renames, blocked };
}

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  const { renames, blocked } = await plan(db);

  if (blocked.length) {
    throw new Error(`${migrationId}: refusing to rename; review first: ${blocked.join(', ')}`);
  }
  if (!apply) {
    console.log(`${migrationId}: dry run; ${renames.length} rename(s).`);
    for (const statement of renames) console.log(`  ${statement}`);
    return;
  }

  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);

  const now = new Date().toISOString();
  const checksum = crypto.createHash('sha256').update(renames.join('\n')).digest('hex');
  await db.batch([
    ...renames.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] },
  ], 'write');
  console.log(`${migrationId}: applied ${renames.length} rename(s) at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
