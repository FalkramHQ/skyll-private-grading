import { randomUUID } from 'node:crypto';
import { database } from './auth.js';
import { createRetryableInitializer } from './runtimeInitialization.js';
import { PUSH_OUTBOX_DDL, INSTALLATION_PUSH_COLUMNS } from './pushOutbox.js';

export function id(prefix) { return `${prefix}_${randomUUID()}`; }

const ensureIntakeTablesInitialized = createRetryableInitializer(async () => {
  const db = database();
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY, school TEXT NOT NULL, name TEXT NOT NULL, grade TEXT,
      board TEXT, stream TEXT, academic_year TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY, school TEXT NOT NULL, display_name TEXT NOT NULL,
      roster_key TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS batch_memberships (
      id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, student_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', joined_at TEXT NOT NULL, left_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS tests (
      id TEXT PRIMARY KEY, school TEXT NOT NULL, title TEXT NOT NULL, subject TEXT NOT NULL,
      grade TEXT NOT NULL, status TEXT NOT NULL, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS test_students (
      id TEXT PRIMARY KEY, test_id TEXT NOT NULL, student_id TEXT NOT NULL,
      student_name TEXT NOT NULL, batch_id TEXT, status TEXT NOT NULL DEFAULT 'expected',
      expected_page_count INTEGER, created_at TEXT NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS test_batches (
      test_id TEXT NOT NULL, batch_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (test_id, batch_id)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS file_assets (
      id TEXT PRIMARY KEY, test_id TEXT NOT NULL, test_student_id TEXT,
      kind TEXT NOT NULL, storage_key TEXT NOT NULL, mime_type TEXT, byte_size INTEGER,
      checksum TEXT, status TEXT NOT NULL DEFAULT 'registered', created_by TEXT NOT NULL, created_at TEXT NOT NULL
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS intake_asset_events (
      id TEXT PRIMARY KEY, test_id TEXT NOT NULL, test_student_id TEXT,
      event_type TEXT NOT NULL, status TEXT NOT NULL, actor_username TEXT NOT NULL,
      reason TEXT, asset_ids_json TEXT NOT NULL, page_count INTEGER NOT NULL DEFAULT 0,
      error TEXT, created_at TEXT NOT NULL, completed_at TEXT
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS processing_jobs (
      id TEXT PRIMARY KEY, test_id TEXT NOT NULL, school TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL, payload_json TEXT NOT NULL, requested_by TEXT NOT NULL,
      requested_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, worker_id TEXT, error TEXT, result_json TEXT,
      progress_json TEXT
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS asset_ocr_runs (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, job_id TEXT NOT NULL,
      engine TEXT NOT NULL, model TEXT NOT NULL, revision INTEGER NOT NULL,
      asset_checksum TEXT, status TEXT NOT NULL, markdown TEXT, pages_json TEXT,
      page_count INTEGER NOT NULL DEFAULT 0, usage_json TEXT, error TEXT,
      created_at TEXT NOT NULL, completed_at TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(asset_id, revision)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS exam_rubric_versions (
      id TEXT PRIMARY KEY, test_id TEXT NOT NULL, job_id TEXT NOT NULL,
      version INTEGER NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL,
      source_ocr_run_ids_json TEXT NOT NULL, question_map_json TEXT,
      quality_json TEXT, error TEXT, created_at TEXT NOT NULL,
      completed_at TEXT, is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(test_id, version)
    )` },
    { sql: `CREATE TABLE IF NOT EXISTS intake_installations (
      installation_id TEXT PRIMARY KEY, school TEXT NOT NULL, username TEXT NOT NULL,
      platform TEXT NOT NULL, app_version TEXT, runtime_version TEXT, update_id TEXT,
      last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL
    )` },
    { sql: 'CREATE INDEX IF NOT EXISTS tests_school_idx ON tests (school, created_at DESC)' },
    { sql: 'CREATE INDEX IF NOT EXISTS batches_school_idx ON batches (school, status, name)' },
    { sql: 'CREATE INDEX IF NOT EXISTS students_school_idx ON students (school, status, display_name)' },
    { sql: 'CREATE INDEX IF NOT EXISTS batch_memberships_batch_idx ON batch_memberships (batch_id, status)' },
    { sql: 'CREATE INDEX IF NOT EXISTS test_students_test_idx ON test_students (test_id, status)' },
    { sql: 'CREATE INDEX IF NOT EXISTS intake_asset_events_test_student_idx ON intake_asset_events (test_id, test_student_id, event_type, created_at DESC)' },
    { sql: 'CREATE INDEX IF NOT EXISTS processing_jobs_status_idx ON processing_jobs (status, requested_at)' },
    { sql: 'CREATE INDEX IF NOT EXISTS asset_ocr_runs_asset_idx ON asset_ocr_runs (asset_id, is_active, created_at DESC)' },
    { sql: 'CREATE INDEX IF NOT EXISTS exam_rubric_versions_test_idx ON exam_rubric_versions (test_id, is_active, created_at DESC)' },
    { sql: 'CREATE INDEX IF NOT EXISTS intake_installations_school_seen_idx ON intake_installations (school, last_seen_at DESC)' },
    ...PUSH_OUTBOX_DDL.map((sql) => ({ sql })),
  ], 'write');
  try {
    await db.execute({ sql: 'ALTER TABLE test_students ADD COLUMN expected_page_count INTEGER' });
  } catch {
    // Column already exists on databases created after this migration.
  }
  // Canonical tenancy columns from migration 002; a fresh database created by
  // this initializer must accept the same inserts as a migrated one.
  for (const table of ['tests', 'processing_jobs']) {
    try {
      await db.execute({ sql: `ALTER TABLE ${table} ADD COLUMN school_id TEXT` });
    } catch {
      // Column already exists.
    }
  }
  for (const column of INSTALLATION_PUSH_COLUMNS) {
    try {
      await db.execute({ sql: `ALTER TABLE intake_installations ADD COLUMN ${column}` });
    } catch {
      // Column already exists on databases created after migration 057.
    }
  }
});

export function ensureIntakeTables() {
  return ensureIntakeTablesInitialized();
}
