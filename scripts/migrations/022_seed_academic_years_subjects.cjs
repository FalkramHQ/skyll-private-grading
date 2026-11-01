#!/usr/bin/env node

/* Phase 0 seed: academic years + subjects per school; backfill school_id on tests/batches.
 * Idempotent: safe to re-run.
 *
 *   node scripts/migrations/022_seed_academic_years_subjects.cjs --dry-run
 *   node scripts/migrations/022_seed_academic_years_subjects.cjs --apply
 */
const { getDb, id, now, loadSchoolResolver, normalizeSubject, alreadyApplied, markApplied } = require('./_lib.cjs');

const migrationId = '022_seed_academic_years_subjects';
const apply = process.argv.includes('--apply');

async function main() {
  const db = getDb();
  console.log(`${migrationId}: ${apply ? 'APPLY' : 'DRY RUN'}`);
  if (apply && (await alreadyApplied(db, migrationId))) return console.log('Already applied; no changes made.');

  const resolver = await loadSchoolResolver(db);
  const ts = now();
  const log = { years: 0, subjects: 0, testsSchoolId: 0, batchesSchoolId: 0, unresolvedSchools: new Set() };

  // --- 1. Academic years: '2026-27' current for every school; 'Demo' where batches reference it.
  const demoSchools = new Set(
    (await db.execute(`SELECT DISTINCT school FROM batches WHERE academic_year = 'Demo'`)).rows.map((r) => r.school),
  );
  const yearStatements = [];
  for (const school of resolver.all) {
    const labels = [{ label: '2026-27', isCurrent: 1 }];
    if (demoSchools.has(school.display_name)) labels.push({ label: 'Demo', isCurrent: 0 });
    for (const { label, isCurrent } of labels) {
      const existing = await db.execute({ sql: 'SELECT id FROM academic_years WHERE school_id = ? AND label = ?', args: [school.id, label] });
      if (existing.rows.length) continue;
      log.years += 1;
      yearStatements.push({ sql: 'INSERT INTO academic_years (id, school_id, label, starts_on, ends_on, is_current, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)', args: [id('yr'), school.id, label, isCurrent, ts, ts] });
    }
  }

  // --- 2. Subjects: distinct normalized names per school from tests + submission_questions.
  const subjectSources = [
    await db.execute(`SELECT school, subject, COUNT(*) n FROM tests WHERE subject IS NOT NULL AND TRIM(subject) != '' GROUP BY school, subject`),
    await db.execute(`SELECT school, subject, COUNT(*) n FROM submission_questions WHERE subject IS NOT NULL AND TRIM(subject) != '' GROUP BY school, subject`),
  ];
  // schoolId -> Map(key -> {display, votes})
  const subjectsBySchool = new Map();
  for (const result of subjectSources) {
    for (const row of result.rows) {
      const schoolId = resolver.resolve(row.school);
      if (!schoolId) { log.unresolvedSchools.add(row.school); continue; }
      const norm = normalizeSubject(row.subject);
      if (!norm) continue;
      if (!subjectsBySchool.has(schoolId)) subjectsBySchool.set(schoolId, new Map());
      const bucket = subjectsBySchool.get(schoolId);
      const entry = bucket.get(norm.key) || { display: norm.display, votes: 0 };
      entry.votes += Number(row.n) || 0;
      bucket.set(norm.key, entry);
    }
  }
  const subjectStatements = [];
  for (const [schoolId, bucket] of subjectsBySchool) {
    for (const { display } of bucket.values()) {
      const existing = await db.execute({ sql: 'SELECT id FROM subjects WHERE school_id = ? AND name = ?', args: [schoolId, display] });
      if (existing.rows.length) continue;
      log.subjects += 1;
      subjectStatements.push({ sql: 'INSERT INTO subjects (id, school_id, name, code, status, created_at, updated_at) VALUES (?, ?, ?, NULL, \'active\', ?, ?)', args: [id('sub'), schoolId, display, ts, ts] });
    }
  }

  // --- 3. Backfill school_id on tests + batches from the text school column.
  const fixStatements = [];
  for (const table of ['tests', 'batches']) {
    const rows = (await db.execute(`SELECT id, school FROM ${table} WHERE school_id IS NULL OR school_id = ''`)).rows;
    for (const row of rows) {
      const schoolId = resolver.resolve(row.school);
      if (!schoolId) { log.unresolvedSchools.add(row.school); continue; }
      log[table === 'tests' ? 'testsSchoolId' : 'batchesSchoolId'] += 1;
      fixStatements.push({ sql: `UPDATE ${table} SET school_id = ? WHERE id = ?`, args: [schoolId, row.id] });
    }
  }

  console.log('Plan:', JSON.stringify({ ...log, unresolvedSchools: [...log.unresolvedSchools] }));
  if (!apply) return;

  await db.batch([...yearStatements, ...subjectStatements, ...fixStatements], 'write');
  await markApplied(db, migrationId, ['years', 'subjects', 'school_id backfill']);
  console.log(`Applied ${migrationId}.`);
}

main().catch((error) => { console.error(`${migrationId} failed: ${error.message}`); process.exitCode = 1; });
