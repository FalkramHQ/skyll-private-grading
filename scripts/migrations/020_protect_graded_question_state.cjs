#!/usr/bin/env node

// A worker retry may refresh evidence, but it must never downgrade a graded
// question or overwrite the canonical grade payload used for reports/review.
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment directly.
}

const migrationId = '020_protect_graded_question_state';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  `CREATE TRIGGER IF NOT EXISTS submission_questions_prevent_grade_downgrade
   BEFORE UPDATE OF status ON submission_questions
   WHEN OLD.status IN ('graded', 'ready_for_review') AND NEW.status = 'evidence_ready'
   BEGIN
     SELECT RAISE(IGNORE);
   END`,
];

async function main() {
  if (!apply) return console.log(`${migrationId}: dry run; ${statements.length} change(s).`);
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  const now = new Date().toISOString();
  await db.batch([...statements.map((sql) => ({ sql })), { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
