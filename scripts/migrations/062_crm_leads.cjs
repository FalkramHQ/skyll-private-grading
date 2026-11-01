#!/usr/bin/env node

// Remaining CRM foundation schema (FLKRM-325, slice 5). Additive + idempotent
// (Turso-safe).
//
// crm_lead_sources        — per-school lead sources (walk-in, referral, …)
// crm_leads               — pre-student journey; lifecycle comes from the
//                           stage category. Retention columns (lost_at,
//                           last_activity_at, anonymised_at) support the
//                           12-month lost-lead policy (CRM_CONTRACTS.md §4)
// crm_lead_stage_events   — append-only stage history (triggers)
// crm_tags / crm_entity_tags — school tags on any CRM entity
// crm_notes               — free-text notes (PII risk; anonymised with entity)
// crm_student_profiles    — CRM-only fields for canonical students (owner,
//                           converted-from lead); never a copy of students
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '062_crm_leads';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const statements = [
  `CREATE TABLE IF NOT EXISTS crm_lead_sources (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    label TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (school_id, source_key)
  )`,

  `CREATE TABLE IF NOT EXISTS crm_leads (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    pipeline_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    primary_contact_id TEXT,
    learner_name TEXT NOT NULL,
    learner_grade TEXT,
    interest_json TEXT NOT NULL DEFAULT '{}',
    source_id TEXT,
    owner_user_id TEXT,
    lost_reason TEXT,
    lost_at TEXT,
    converted_student_id TEXT,
    converted_at TEXT,
    last_activity_at TEXT NOT NULL,
    anonymised_at TEXT,
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_leads_stage_idx ON crm_leads (school_id, stage_id, archived_at)',
  'CREATE INDEX IF NOT EXISTS crm_leads_owner_idx ON crm_leads (school_id, owner_user_id, archived_at)',
  'CREATE INDEX IF NOT EXISTS crm_leads_activity_idx ON crm_leads (school_id, last_activity_at)',
  'CREATE INDEX IF NOT EXISTS crm_leads_list_idx ON crm_leads (school_id, created_at, id)',
  'CREATE INDEX IF NOT EXISTS crm_leads_contact_idx ON crm_leads (school_id, primary_contact_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_leads_converted_idx ON crm_leads (converted_student_id) WHERE converted_student_id IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS crm_leads_lost_idx ON crm_leads (school_id, lost_at) WHERE lost_at IS NOT NULL',

  `CREATE TABLE IF NOT EXISTS crm_lead_stage_events (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    from_stage_id TEXT,
    to_stage_id TEXT NOT NULL,
    actor_user_id TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_lead_stage_events_lead_idx ON crm_lead_stage_events (school_id, lead_id, created_at)',
  `CREATE TRIGGER IF NOT EXISTS crm_lead_stage_events_no_update
    BEFORE UPDATE ON crm_lead_stage_events
    BEGIN SELECT RAISE(ABORT, 'crm_lead_stage_events is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS crm_lead_stage_events_no_delete
    BEFORE DELETE ON crm_lead_stage_events
    BEGIN SELECT RAISE(ABORT, 'crm_lead_stage_events is append-only'); END`,

  `CREATE TABLE IF NOT EXISTS crm_tags (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    label TEXT NOT NULL,
    color TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS crm_tags_label_idx ON crm_tags (school_id, lower(label)) WHERE archived_at IS NULL',

  `CREATE TABLE IF NOT EXISTS crm_entity_tags (
    school_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tag_id, entity_type, entity_id)
  )`,
  'CREATE INDEX IF NOT EXISTS crm_entity_tags_entity_idx ON crm_entity_tags (school_id, entity_type, entity_id)',

  `CREATE TABLE IF NOT EXISTS crm_notes (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    body TEXT NOT NULL,
    author_user_id TEXT,
    anonymised_at TEXT,
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_notes_entity_idx ON crm_notes (school_id, entity_type, entity_id, created_at)',

  `CREATE TABLE IF NOT EXISTS crm_student_profiles (
    student_id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    owner_user_id TEXT,
    converted_from_lead_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS crm_student_profiles_owner_idx ON crm_student_profiles (school_id, owner_user_id)',
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
