#!/usr/bin/env node

// CRM admission pipelines and stages (FLKRM-325, slice 3). Additive +
// idempotent (Turso-safe).
//
// crm_pipelines        — one default pipeline per school today; the table
//                        supports more (e.g. separate JEE / NEET funnels)
// crm_pipeline_stages  — school-named stages mapped to a fixed category
//                        (open | applicant | won | lost) the system enforces
//
// Default stages are seeded lazily on first use with deterministic ids, so
// concurrent first requests cannot create duplicates.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '060_crm_pipeline';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_pipelines (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_pipelines_default_idx ON crm_pipelines (school_id) WHERE is_default = 1',
  'CREATE INDEX IF NOT EXISTS crm_pipelines_school_idx ON crm_pipelines (school_id, archived_at)',

  `CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    pipeline_id TEXT NOT NULL,
    stage_key TEXT,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('open', 'applicant', 'won', 'lost')),
    position INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_pipeline_stages_pipeline_idx ON crm_pipeline_stages (pipeline_id, archived_at, position)',
  'CREATE INDEX IF NOT EXISTS crm_pipeline_stages_school_idx ON crm_pipeline_stages (school_id, category)',
  `CREATE UNIQUE INDEX IF NOT EXISTS crm_pipeline_stages_name_idx
    ON crm_pipeline_stages (pipeline_id, lower(name)) WHERE archived_at IS NULL`,
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
