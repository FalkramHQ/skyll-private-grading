#!/usr/bin/env node

// private_inference_attestations / private_inference_receipts: proof that a
// school's grading ran inside NEAR AI's TEE.
//
// An attestation row is one verified NEAR AI attestation report (raw JSON kept so
// anyone can re-verify the Intel TDX quote and GPU evidence). A receipt row is one
// chat completion: SHA-256 of the exact request and response bytes, the TEE
// signature over them, and the attestation whose key made it. Written by the OCI
// worker for schools named in NEAR_AI_SCHOOLS; nothing reads them in the product yet.
//
// Additive + idempotent (Turso-safe: no VACUUM, no DROP COLUMN). Back up first:
//
//   node scripts/migrations/backupFullDb.cjs
//   node scripts/migrations/091_private_inference_receipts.cjs --dry-run
//   node scripts/migrations/091_private_inference_receipts.cjs --apply
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '091_private_inference_receipts';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
const statements = [
  `CREATE TABLE IF NOT EXISTS private_inference_attestations (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    nonce TEXT NOT NULL,
    report_sha256 TEXT NOT NULL,
    report_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    verified_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS private_inference_receipts (
    id TEXT PRIMARY KEY,
    attestation_id TEXT NOT NULL REFERENCES private_inference_attestations(id),
    school TEXT,
    test_id TEXT,
    job_id TEXT,
    job_type TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    completion_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL,
    response_sha256 TEXT NOT NULL,
    signature_kind TEXT NOT NULL,
    signed_text TEXT NOT NULL,
    signature TEXT NOT NULL,
    signing_address TEXT NOT NULL,
    signing_algo TEXT NOT NULL,
    tcb_status TEXT,
    gpu_verified INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_private_inference_receipts_test ON private_inference_receipts(school, test_id)',
  'CREATE INDEX IF NOT EXISTS idx_private_inference_receipts_job ON private_inference_receipts(job_id)',
];

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);
  if (!apply) {
    console.log(`${migrationId} dry run. Would execute:`);
    for (const statement of statements) console.log(`${statement.replace(/\s+/g, ' ').slice(0, 120)}…`);
    return console.log('Re-run with --apply to execute.');
  }
  const checksum = crypto.createHash('sha256').update(statements.join('\n')).digest('hex');
  await db.batch([
    ...statements,
    { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, new Date().toISOString(), checksum] },
  ], 'write');
  console.log(`${migrationId}: applied.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
