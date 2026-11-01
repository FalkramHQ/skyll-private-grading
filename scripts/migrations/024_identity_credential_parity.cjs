#!/usr/bin/env node

/* Phase 1: identity parity — copy any app_users credentials missing from user_credentials
 * (status mapped from app_users.active; disabled stays disabled) and backfill
 * students.user_id from student_user_links.
 *
 *   node scripts/migrations/024_identity_credential_parity.cjs --dry-run
 *   node scripts/migrations/024_identity_credential_parity.cjs --apply
 */
const { getDb, id, now, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '024_identity_credential_parity';
const apply = process.argv.includes('--apply');

async function main() {
  const db = getDb();
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (apply && (await alreadyApplied(db, migrationId))) return console.log('Already applied; no changes made.');
  const ts = now();

  // --- 1. Credentials missing from user_credentials (login_id match on username OR any alias).
  const missing = (await db.execute(`
    SELECT a.username, a.password_hash, a.active, a.user_id
    FROM app_users a
    LEFT JOIN user_credentials c ON c.login_id = a.username
    WHERE c.id IS NULL`)).rows;

  const credentialStatements = missing.map((row) => ({
    sql: `INSERT INTO user_credentials (id, user_id, login_id, password_hash, credential_type, is_primary, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'password', 1, ?, ?, ?)`,
    args: [id('cred'), row.user_id, row.username, row.password_hash, row.active === 1 ? 'active' : 'disabled', ts, ts],
  }));

  // --- 2. Aliases missing from user_credentials (as non-primary credentials on the same user).
  const missingAliases = (await db.execute(`
    SELECT al.alias, al.password_hash, al.active, u.user_id
    FROM app_login_aliases al
    JOIN app_users u ON u.username = al.username
    LEFT JOIN user_credentials c ON c.login_id = al.alias
    WHERE c.id IS NULL AND u.user_id IS NOT NULL`)).rows;

  const aliasStatements = missingAliases.map((row) => ({
    sql: `INSERT INTO user_credentials (id, user_id, login_id, password_hash, credential_type, is_primary, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'password', 0, ?, ?, ?)`,
    args: [id('cred'), row.user_id, row.alias, row.password_hash, row.active === 1 ? 'active' : 'disabled', ts, ts],
  }));

  // --- 3. students.user_id backfill from student_user_links.
  const unlinkable = (await db.execute(`
    SELECT COUNT(*) n FROM students WHERE user_id IS NULL`)).rows[0].n;
  const linkStatements = [`
    UPDATE students SET user_id = (
      SELECT l.user_id FROM student_user_links l WHERE l.student_id = students.id AND l.link_status = 'confirmed'
    )
    WHERE user_id IS NULL
      AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.student_id = students.id AND l.link_status = 'confirmed')`];

  console.log(`Credentials to copy: ${credentialStatements.length} (${missing.map((r) => r.username).join(', ') || 'none'})`);
  console.log(`Alias credentials to copy: ${aliasStatements.length}`);
  console.log(`students with user_id NULL before: ${unlinkable}`);
  if (!apply) return;

  await db.batch([...credentialStatements, ...aliasStatements.map((s) => ({ sql: s.sql, args: s.args })), ...linkStatements.map((sql) => ({ sql }))], 'write');
  const after = (await db.execute('SELECT COUNT(*) n FROM students WHERE user_id IS NULL')).rows[0].n;
  await markApplied(db, migrationId, [...missing.map((r) => r.username), ...missingAliases.map((r) => r.alias), `students_null_after:${after}`]);
  console.log(`Applied ${migrationId}. students with user_id NULL after: ${after}`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
