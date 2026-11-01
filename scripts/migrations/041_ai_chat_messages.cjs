#!/usr/bin/env node

/* 041: AI chat message history for tutor / copilot multi-turn conversations.
 *
 *   node scripts/migrations/041_ai_chat_messages.cjs --dry-run
 *   node scripts/migrations/041_ai_chat_messages.cjs --apply
 */
const { getDb, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '041_ai_chat_messages';
const apply = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS ai_chat_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    school_id TEXT,
    student_id TEXT,
    role TEXT NOT NULL,
    scope TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_role TEXT NOT NULL,
    content TEXT NOT NULL,
    context_snapshot TEXT,
    model_used TEXT,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS ai_chat_messages_session_idx ON ai_chat_messages (session_id, created_at)',
  'CREATE INDEX IF NOT EXISTS ai_chat_messages_user_scope_idx ON ai_chat_messages (user_id, scope, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS ai_chat_messages_student_idx ON ai_chat_messages (student_id, scope, created_at DESC)',
];

async function main() {
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  const db = getDb();
  if (await alreadyApplied(db, migrationId)) return console.log('Already applied; no changes made.');

  for (const sql of statements) {
    console.log(apply ? `APPLY: ${sql.slice(0, 80)}...` : `PLAN: ${sql.slice(0, 80)}...`);
    if (apply) await db.execute(sql);
  }

  if (apply) {
    await markApplied(db, migrationId, statements);
    console.log('Applied and recorded in schema_migrations.');
  } else {
    console.log('Dry run only. Re-run with --apply to execute.');
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
