#!/usr/bin/env node

/*
 * Add canonical school, user, credential, and membership identity without
 * breaking current app_users/app_sessions or text-school API reads.
 *
 * Usage:
 *   node scripts/migrations/002_canonical_identity_tenancy.cjs --dry-run
 *   node scripts/migrations/002_canonical_identity_tenancy.cjs --apply
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({
  path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'),
  quiet: true,
  override: true,
});

const apply = process.argv.includes('--apply');
const migrationId = '002_canonical_identity_tenancy';
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const baseStatements = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS schools (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    institution_type TEXT NOT NULL DEFAULT 'school',
    status TEXT NOT NULL DEFAULT 'active',
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    login_id TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    credential_type TEXT NOT NULL DEFAULT 'password',
    is_primary INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS school_memberships (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(school_id, user_id, role)
  )`,
  `CREATE TABLE IF NOT EXISTS student_user_links (
    student_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    school_id TEXT NOT NULL,
    link_status TEXT NOT NULL DEFAULT 'confirmed',
    linked_by TEXT NOT NULL,
    linked_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS user_credentials_user_idx ON user_credentials (user_id, status)`,
  `CREATE INDEX IF NOT EXISTS school_memberships_user_idx ON school_memberships (user_id, status)`,
  `CREATE INDEX IF NOT EXISTS school_memberships_school_idx ON school_memberships (school_id, role, status)`,
];

const compatibilityColumns = {
  app_users: [
    ['user_id', 'TEXT'],
    ['school_id', 'TEXT'],
    ['display_name', 'TEXT'],
  ],
  app_sessions: [['user_id', 'TEXT']],
  students: [
    ['school_id', 'TEXT'],
    ['user_id', 'TEXT'],
  ],
  batches: [['school_id', 'TEXT']],
  tests: [['school_id', 'TEXT']],
  processing_jobs: [['school_id', 'TEXT']],
  intake_installations: [
    ['school_id', 'TEXT'],
    ['user_id', 'TEXT'],
  ],
};

const knownSchoolAliases = new Map([
  ['partner-academy-b', 'partner-academy-b'],
  ['partner-academy-bacademy', 'partner-academy-b'],
  ['rockiitacademy', 'partner-academy-b'],
]);

function normalized(value) { return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
function slug(value) {
  const compact = normalized(value);
  return knownSchoolAliases.get(compact)
    || String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    || 'unknown-school';
}
function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`;
}
function canonicalRole(role) { return role === 'admin' ? 'school_admin' : String(role || 'student'); }

async function tableExists(db, table) {
  const result = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table] });
  return result.rows.length > 0;
}

async function ensureColumns(db) {
  for (const [table, columns] of Object.entries(compatibilityColumns)) {
    if (!(await tableExists(db, table))) continue;
    const info = await db.execute(`PRAGMA table_info(${table})`);
    const existing = new Set(info.rows.map((row) => String(row.name)));
    for (const [name, type] of columns) {
      if (!existing.has(name)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

async function collectSchoolNames(db) {
  const names = new Set();
  for (const table of ['app_users', 'students', 'batches', 'tests', 'processing_jobs', 'intake_installations']) {
    if (!(await tableExists(db, table))) continue;
    const result = await db.execute(`SELECT DISTINCT school FROM ${table} WHERE school IS NOT NULL AND TRIM(school) != ''`);
    result.rows.forEach((row) => names.add(String(row.school).trim()));
  }
  return [...names];
}

async function migrateSchools(db, now) {
  const names = await collectSchoolNames(db);
  const schools = new Map();
  for (const name of names) {
    const schoolSlug = slug(name);
    const schoolId = stableId('sch', schoolSlug);
    schools.set(normalized(name), { id: schoolId, slug: schoolSlug, displayName: name });
    await db.execute({
      sql: `INSERT INTO schools (id, slug, display_name, status, created_at, updated_at)
            VALUES (?, ?, ?, 'active', ?, ?)
            ON CONFLICT(slug) DO UPDATE SET updated_at = excluded.updated_at`,
      args: [schoolId, schoolSlug, name, now, now],
    });
  }
  for (const table of ['app_users', 'students', 'batches', 'tests', 'processing_jobs', 'intake_installations']) {
    if (!(await tableExists(db, table))) continue;
    for (const [legacyName, school] of schools) {
      const aliases = names.filter((name) => normalized(name) === legacyName);
      for (const name of aliases) await db.execute({ sql: `UPDATE ${table} SET school_id = ? WHERE school = ?`, args: [school.id, name] });
    }
  }
  return schools;
}

async function migrateUsers(db, schools, now) {
  if (!(await tableExists(db, 'app_users'))) return;
  const legacyUsers = await db.execute('SELECT username, password_hash, role, school, active, created_at, updated_at FROM app_users');
  for (const legacy of legacyUsers.rows) {
    const username = String(legacy.username).trim().toLowerCase();
    const userId = stableId('usr', username);
    const school = schools.get(normalized(legacy.school));
    await db.batch([
      { sql: `INSERT INTO users (id, display_name, status, created_at, updated_at)
              VALUES (?, NULL, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        args: [userId, Number(legacy.active) === 1 ? 'active' : 'disabled', legacy.created_at || now, now] },
      { sql: `INSERT INTO user_credentials (id, user_id, login_id, password_hash, credential_type, is_primary, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'password', 1, ?, ?, ?)
              ON CONFLICT(login_id) DO UPDATE SET user_id = excluded.user_id, password_hash = excluded.password_hash, status = excluded.status, updated_at = excluded.updated_at`,
        args: [stableId('cred', username), userId, username, legacy.password_hash, Number(legacy.active) === 1 ? 'active' : 'disabled', legacy.created_at || now, now] },
      { sql: 'UPDATE app_users SET user_id = ?, school_id = ? WHERE username = ?', args: [userId, school?.id || null, legacy.username] },
    ], 'write');
    if (school) {
      const role = canonicalRole(legacy.role);
      await db.execute({
        sql: `INSERT INTO school_memberships (id, school_id, user_id, role, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(school_id, user_id, role) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        args: [stableId('mem', `${school.id}:${userId}:${role}`), school.id, userId, role, Number(legacy.active) === 1 ? 'active' : 'disabled', now, now],
      });
    }
  }

  if (await tableExists(db, 'app_login_aliases')) {
    const aliases = await db.execute('SELECT alias, username, password_hash, active, created_at FROM app_login_aliases');
    for (const alias of aliases.rows) {
      const loginId = String(alias.alias).trim().toLowerCase();
      const userId = stableId('usr', String(alias.username).trim().toLowerCase());
      await db.execute({
        sql: `INSERT INTO user_credentials (id, user_id, login_id, password_hash, credential_type, is_primary, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'password_alias', 0, ?, ?, ?)
              ON CONFLICT(login_id) DO UPDATE SET user_id = excluded.user_id, password_hash = excluded.password_hash, status = excluded.status, updated_at = excluded.updated_at`,
        args: [stableId('cred', loginId), userId, loginId, alias.password_hash, Number(alias.active) === 1 ? 'active' : 'disabled', alias.created_at || now, now],
      });
    }
  }

  if (await tableExists(db, 'app_sessions')) {
    await db.execute(`UPDATE app_sessions
      SET user_id = (SELECT user_id FROM app_users WHERE app_users.username = app_sessions.username)
      WHERE user_id IS NULL`);
  }
}

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Creates ${baseStatements.length} tables/indexes and adds compatibility IDs to ${Object.keys(compatibilityColumns).length} existing tables.`);
  if (!apply) {
    console.log('No database changes made. Existing usernames, passwords, sessions, schools, batches, and tests remain untouched.');
    return;
  }
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration. Set TURSO_DATABASE_URL/TURSO_AUTH_TOKEN (or legacy VITE_DB_URL/VITE_DB_TOKEN).');
  const db = createClient({ url: dbUrl, authToken });
  await db.batch(baseStatements.map((sql) => ({ sql })), 'write');
  const existing = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log('Already applied; no changes made.');
  await ensureColumns(db);
  const now = new Date().toISOString();
  const schools = await migrateSchools(db, now);
  await migrateUsers(db, schools, now);
  const checksum = crypto.createHash('sha256').update(baseStatements.join('\n') + JSON.stringify(compatibilityColumns)).digest('hex');
  await db.execute({ sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] });
  console.log(`Applied ${migrationId}: ${schools.size} legacy school names mapped to canonical school IDs.`);
}

main().catch((error) => { console.error(`Migration failed: ${error.message}`); process.exitCode = 1; });
