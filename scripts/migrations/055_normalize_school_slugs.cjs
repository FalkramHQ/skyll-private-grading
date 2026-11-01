#!/usr/bin/env node

// Normalise existing school slugs to the canonical slugify(display_name) form.
//
// The 7 pre-existing schools were seeded with slugs from an older slugify that
// mishandled apostrophes — e.g. "Partner Academy A" became "partner-academy-a"
// instead of "partner-academy-a". This made the slugify() fallback in
// server/schools/public.js silently disagree with the stored slug, so those
// schools only resolved via the hardcoded alias map.
//
// This migration rewrites each slug to the canonical form, guarding against
// collisions. Old short links (/partnerc, /partnera, ...) keep working via the alias
// map, so this is safe. Additive + idempotent (re-running is a no-op).
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

try {
  require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });
} catch {
  // OCI supplies the protected environment through systemd.
}

const migrationId = '055_normalize_school_slugs';
const apply = process.argv.includes('--apply');
const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL || process.env.NEXT_PUBLIC_DB;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;

// Mirror of slugifySchoolName() in server/schools/public.js.
function slugify(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');
  const db = createClient({ url: dbUrl, authToken });
  const rows = (await db.execute("SELECT id, slug, display_name FROM schools ORDER BY created_at")).rows;

  const taken = new Map(); // canonical slug -> school id (to avoid collisions)
  const changes = [];
  for (const row of rows) {
    const canonical = slugify(row.display_name);
    if (!canonical) continue;
    if (taken.has(canonical) && taken.get(canonical) !== row.id) {
      console.warn(`${migrationId}: skip "${row.display_name}" — canonical slug "${canonical}" already used by ${taken.get(canonical)}`);
      continue;
    }
    taken.set(canonical, row.id);
    if (row.slug !== canonical) changes.push({ id: row.id, from: row.slug, to: canonical, name: row.display_name });
  }

  if (!changes.length) return console.log(`${migrationId}: no slug changes needed.`);
  console.log(`${migrationId}: ${changes.length} slug change(s):`);
  for (const c of changes) console.log(`  ${c.name}: ${c.from || '(null)'} -> ${c.to}`);
  if (!apply) return console.log(`${migrationId}: dry run; re-run with --apply to execute.`);

  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT 1 FROM schema_migrations WHERE id = ?', args: [migrationId] });
  if (existing.rows.length) return console.log(`${migrationId}: already applied.`);

  const now = new Date().toISOString();
  const updates = changes.map((c) => ({ sql: 'UPDATE schools SET slug = ?, updated_at = ? WHERE id = ?', args: [c.to, now, c.id] }));
  const checksum = crypto.createHash('sha256').update(JSON.stringify(changes)).digest('hex');
  await db.batch([...updates, { sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now, checksum] }], 'write');
  console.log(`${migrationId}: applied ${updates.length} slug update(s) at ${now}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
