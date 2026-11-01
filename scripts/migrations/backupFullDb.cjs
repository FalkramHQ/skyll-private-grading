#!/usr/bin/env node
/* Full database backup (Turso or self-hosted sqld): schema + all table rows -> execution/db_backups/full_<ts>/ */
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');

require('dotenv').config({ path: process.env.SKYLL_ENV_PATH || path.resolve(__dirname, '../..', '.env'), quiet: true, override: true });

const dbUrl = process.env.TURSO_DATABASE_URL || process.env.VITE_DB_URL;
const authToken = process.env.TURSO_AUTH_TOKEN || process.env.VITE_DB_TOKEN;
if (!dbUrl || !authToken) throw new Error('Missing Turso configuration.');

const MAX_PAGE = 500;

function isTooLarge(error) {
  return /RESPONSE_TOO_LARGE|too large/i.test(String(error?.message || error?.code || ''));
}

/**
 * Writes one table as a JSON array, streamed to disk. Pages shrink when the
 * server refuses a response as too large (self-hosted sqld caps response size;
 * report payloads can be big) and grow back afterwards.
 */
async function dumpTable(db, table, file) {
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, '[');
  let offset = 0;
  let pageSize = MAX_PAGE;
  let count = 0;
  try {
    for (;;) {
      let page;
      try {
        page = await db.execute(`SELECT * FROM "${table}" LIMIT ${pageSize} OFFSET ${offset}`);
      } catch (error) {
        if (!isTooLarge(error) || pageSize === 1) throw new Error(`${table} at row ${offset}: ${error.message}`);
        pageSize = Math.max(1, Math.floor(pageSize / 2));
        continue;
      }
      for (const row of page.rows) {
        fs.writeSync(fd, `${count ? ',' : ''}${JSON.stringify(row)}`);
        count += 1;
      }
      if (page.rows.length < pageSize) break;
      offset += page.rows.length;
      pageSize = Math.min(MAX_PAGE, pageSize * 2);
    }
  } finally {
    fs.writeSync(fd, ']');
    fs.closeSync(fd);
  }
  return count;
}

async function main() {
  const db = createClient({ url: dbUrl, authToken });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(__dirname, '../../execution/db_backups', `full_${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const objects = (await db.execute(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)).rows;
  fs.writeFileSync(path.join(outDir, '_schema.sql'), objects.filter((o) => o.sql).map((o) => `${o.sql};`).join('\n\n'));

  const tables = objects.filter((o) => o.type === 'table').map((o) => o.name);
  const manifest = { created_at: new Date().toISOString(), tables: {} };
  for (const table of tables) {
    manifest.tables[table] = await dumpTable(db, table, path.join(outDir, `${table}.json`));
    process.stdout.write(`  ${table}: ${manifest.tables[table]}\n`);
  }
  fs.writeFileSync(path.join(outDir, '_manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`Backup complete: ${outDir}`);
}

main().catch((error) => { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; });
