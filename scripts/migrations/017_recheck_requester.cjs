const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');
require('dotenv').config();

const migrationId = '017_recheck_requester';
const statements = ['CREATE INDEX IF NOT EXISTS recheck_requests_requested_by_idx ON recheck_requests (requested_by, requested_at DESC)'];

async function main() {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`Already applied ${migrationId}`);
  const columns = await db.execute('PRAGMA table_info(recheck_requests)');
  const names = new Set(columns.rows.map((row) => row.name));
  if (!names.has('requested_by')) await db.execute('ALTER TABLE recheck_requests ADD COLUMN requested_by TEXT');
  if (!names.has('requested_by_role')) await db.execute('ALTER TABLE recheck_requests ADD COLUMN requested_by_role TEXT');
  for (const sql of statements) await db.execute(sql);
  await db.execute({ sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, new Date().toISOString(), crypto.createHash('sha256').update(statements.join('\n')).digest('hex')] });
  console.log(`Applied ${migrationId}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
