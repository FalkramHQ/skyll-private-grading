/* Shared helpers for the 021+ canonical restructure migrations. */
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

function getDb() {
  const url = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
  if (!url || !authToken) throw new Error('Missing Turso configuration.');
  return createClient({ url, authToken });
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const now = () => new Date().toISOString();
/* Deterministic id for backfilled rows so re-runs and cross-migration joins converge. */
const stableId = (prefix, value) => `${prefix}_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`;

/* Resolve free-text school names ("Partner Academy B", 'Skyll Internal') to schools.id. */
async function loadSchoolResolver(db) {
  const rows = (await db.execute('SELECT id, slug, display_name FROM schools')).rows;
  const byKey = new Map();
  for (const row of rows) {
    byKey.set(String(row.display_name || '').trim().toLowerCase(), row.id);
    byKey.set(String(row.slug || '').trim().toLowerCase(), row.id);
  }
  // Known historical aliases.
  const skyllId = byKey.get('skyll');
  if (skyllId) {
    byKey.set('skyll academy', skyllId);
    byKey.set('skyll internal', skyllId);
  }
  const partnerbId = byKey.get("Partner Academy B");
  if (partnerbId) {
    byKey.set('partner-academy-b', partnerbId);
    byKey.set('Partner Academy B', partnerbId);
    byKey.set('Partner Academy B', partnerbId);
  }
  return {
    resolve(name) {
      const key = String(name || '').trim().toLowerCase();
      return key ? byKey.get(key) || null : null;
    },
    all: rows,
  };
}

/* Normalize subject names: trim, collapse whitespace, case-insensitive identity. */
const SUBJECT_ALIASES = new Map([
  ['maths', 'mathematics'],
  ['math', 'mathematics'],
]);

/* Split legacy subject strings that smuggled set codes: 'Mathematics set A' -> { name: 'Mathematics', setCode: 'A' }. */
function parseSubjectAndSet(raw) {
  const cleaned = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;
  const setMatch = cleaned.match(/^(.*?)\s*set\s*([A-Za-z0-9]+)$/i);
  const base = setMatch ? setMatch[1].trim() : cleaned;
  const setCode = setMatch ? setMatch[2].toUpperCase() : null;
  const alias = SUBJECT_ALIASES.get(base.toLowerCase()) || base.toLowerCase();
  const display = SUBJECT_ALIASES.get(base.toLowerCase())
    ? SUBJECT_ALIASES.get(base.toLowerCase()).replace(/^./, (c) => c.toUpperCase())
    : base;
  return { key: alias, display, setCode };
}

function normalizeSubject(raw) {
  const parsed = parseSubjectAndSet(raw);
  return parsed ? { key: parsed.key, display: parsed.display } : null;
}

async function alreadyApplied(db, migrationId) {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)');
  const existing = await db.execute({ sql: 'SELECT id FROM schema_migrations WHERE id = ?', args: [migrationId] });
  return existing.rows.length > 0;
}

async function markApplied(db, migrationId, parts) {
  const checksum = crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  await db.execute({ sql: 'INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', args: [migrationId, now(), checksum] });
}

module.exports = { getDb, id, now, stableId, loadSchoolResolver, normalizeSubject, parseSubjectAndSet, alreadyApplied, markApplied };
