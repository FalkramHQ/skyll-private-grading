#!/usr/bin/env node

/* Phase 0 scaffold: canonical academic structure tables (additive only, zero breakage).
 *
 *   node scripts/migrations/021_canonical_restructure_scaffold.cjs --dry-run
 *   node scripts/migrations/021_canonical_restructure_scaffold.cjs --apply
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const migrationId = '021_canonical_restructure_scaffold';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

const createStatements = [
  `CREATE TABLE IF NOT EXISTS academic_years (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    label TEXT NOT NULL,
    starts_on TEXT,
    ends_on TEXT,
    is_current INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(school_id, label)
  )`,
  'CREATE INDEX IF NOT EXISTS academic_years_school_idx ON academic_years (school_id, is_current)',

  `CREATE TABLE IF NOT EXISTS student_enrollments (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL,
    academic_year_id TEXT NOT NULL,
    standard TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(student_id, academic_year_id)
  )`,
  'CREATE INDEX IF NOT EXISTS student_enrollments_student_year_idx ON student_enrollments (student_id, academic_year_id)',
  'CREATE INDEX IF NOT EXISTS student_enrollments_year_standard_idx ON student_enrollments (academic_year_id, standard)',

  `CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(school_id, name)
  )`,
  'CREATE INDEX IF NOT EXISTS subjects_school_idx ON subjects (school_id, status)',

  `CREATE TABLE IF NOT EXISTS batch_memberships (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    joined_at TEXT NOT NULL,
    left_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS batch_memberships_active_unique ON batch_memberships (batch_id, student_id) WHERE status = \'active\'',
  'CREATE INDEX IF NOT EXISTS batch_memberships_student_idx ON batch_memberships (student_id, status)',
  'CREATE INDEX IF NOT EXISTS batch_memberships_batch_idx ON batch_memberships (batch_id, status)',

  `CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    academic_year_id TEXT NOT NULL,
    name TEXT NOT NULL,
    exam_date TEXT,
    exam_type TEXT NOT NULL DEFAULT 'subjective',
    status TEXT NOT NULL,
    delivered_at TEXT,
    archived_at TEXT,
    source_test_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS exams_school_date_idx ON exams (school_id, exam_date DESC)',
  'CREATE INDEX IF NOT EXISTS exams_school_status_idx ON exams (school_id, status)',
  'CREATE INDEX IF NOT EXISTS exams_subject_idx ON exams (subject_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS exams_source_test_idx ON exams (source_test_id) WHERE source_test_id IS NOT NULL',

  `CREATE TABLE IF NOT EXISTS exam_batches (
    exam_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (exam_id, batch_id)
  )`,
  'CREATE INDEX IF NOT EXISTS exam_batches_batch_idx ON exam_batches (batch_id)',

  `CREATE TABLE IF NOT EXISTS exam_sets (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    set_code TEXT NOT NULL,
    question_paper_asset_id TEXT,
    answer_key_asset_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(exam_id, set_code)
  )`,
  'CREATE INDEX IF NOT EXISTS exam_sets_exam_idx ON exam_sets (exam_id)',

  `CREATE TABLE IF NOT EXISTS exam_set_assignments (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(set_id, student_id)
  )`,
  'CREATE INDEX IF NOT EXISTS exam_set_assignments_student_idx ON exam_set_assignments (student_id)',

  `CREATE TABLE IF NOT EXISTS exam_set_questions (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL,
    question_number TEXT NOT NULL,
    question_text TEXT,
    answer_key_text TEXT,
    max_marks REAL,
    rubric_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(set_id, question_number)
  )`,
  'CREATE INDEX IF NOT EXISTS exam_set_questions_set_idx ON exam_set_questions (set_id, question_number)',

  `CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    exam_id TEXT NOT NULL,
    set_id TEXT,
    student_id TEXT NOT NULL,
    batch_id_snapshot TEXT,
    status TEXT NOT NULL,
    active_asset_revision INTEGER NOT NULL DEFAULT 1,
    current_workflow_run_id TEXT,
    score REAL,
    max_marks REAL,
    review_status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(exam_id, student_id)
  )`,
  'CREATE INDEX IF NOT EXISTS submissions_exam_status_idx ON submissions (exam_id, status)',
  'CREATE INDEX IF NOT EXISTS submissions_student_idx ON submissions (student_id, exam_id)',
  'CREATE INDEX IF NOT EXISTS submissions_set_idx ON submissions (set_id)',

  `CREATE TABLE IF NOT EXISTS question_reviews (
    submission_question_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    corrected_answer TEXT,
    approved_marks REAL,
    reviewer_id TEXT,
    reason TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS cohort_report_cache (
    exam_id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    computed_at TEXT NOT NULL,
    invalidated_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS learner_dna_v2 (
    student_id TEXT PRIMARY KEY,
    school_id TEXT NOT NULL,
    dna_json TEXT NOT NULL,
    exam_count INTEGER DEFAULT 0,
    question_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS learner_dna_v2_school_idx ON learner_dna_v2 (school_id)',

  `CREATE TABLE IF NOT EXISTS regrade_runs (
    id TEXT PRIMARY KEY,
    exam_id TEXT,
    school_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    worker_id TEXT,
    heartbeat_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    question_count INTEGER NOT NULL DEFAULT 0,
    student_count INTEGER NOT NULL DEFAULT 0,
    workflow_version TEXT,
    model_version TEXT,
    input_manifest_json TEXT,
    output_manifest_json TEXT,
    result_json TEXT,
    error TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS regrade_runs_exam_idx ON regrade_runs (exam_id, status, requested_at DESC)',

  `CREATE TABLE IF NOT EXISTS regrade_items (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    submission_question_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    input_snapshot_json TEXT,
    output_json TEXT,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(run_id, submission_question_id)
  )`,
  'CREATE INDEX IF NOT EXISTS regrade_items_run_state_idx ON regrade_items (run_id, state)',
];

// Indexes on columns added below — must run AFTER the ALTERs.
const dependentIndexes = [
  'CREATE INDEX IF NOT EXISTS report_versions_exam_idx ON report_versions (exam_id, status)',
  'CREATE INDEX IF NOT EXISTS report_versions_student_idx ON report_versions (student_id, status, version DESC)',
  'CREATE INDEX IF NOT EXISTS file_assets_submission_idx ON file_assets (submission_id, kind, status)',
];

// Column additions applied conditionally (SQLite errors on duplicate column).
const columnAdditions = [
  ['batches', 'subject_id', 'ALTER TABLE batches ADD COLUMN subject_id TEXT'],
  ['batches', 'academic_year_id', 'ALTER TABLE batches ADD COLUMN academic_year_id TEXT'],
  ['report_versions', 'exam_id', 'ALTER TABLE report_versions ADD COLUMN exam_id TEXT'],
  ['report_versions', 'student_id', 'ALTER TABLE report_versions ADD COLUMN student_id TEXT'],
  ['file_assets', 'submission_id', 'ALTER TABLE file_assets ADD COLUMN submission_id TEXT'],
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  ${createStatements.length} create statements, ${columnAdditions.length} column additions`);
  if (!apply) return;
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log('Already applied; no changes made.');

  const alters = [];
  for (const [table, column, sql] of columnAdditions) {
    const info = await db.execute(`PRAGMA table_info(${table})`);
    if (!info.rows.some((row) => row.name === column)) alters.push(sql);
  }

  await db.batch([
    ...createStatements.map((sql) => ({ sql })),
    ...alters.map((sql) => ({ sql })),
    ...dependentIndexes.map((sql) => ({ sql })),
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, new Date().toISOString(), crypto.createHash('sha256').update([...createStatements, ...alters, ...dependentIndexes].join('\n')).digest('hex')] },
  ], 'write');
  console.log(`Applied ${migrationId}: ${createStatements.length} creates + ${alters.length} column additions.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
