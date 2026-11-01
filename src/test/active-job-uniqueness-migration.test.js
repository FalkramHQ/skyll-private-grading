// Migration 088: partial unique indexes allow one active test-level intake job
// and one active cohort regrade per test, on real SQLite.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';

const { statements, findBlockers } = createRequire(import.meta.url)('../../scripts/migrations/088_active_job_uniqueness.cjs');

let db;

beforeEach(async () => {
  db = createClient({ url: ':memory:' });
  await db.batch([
    `CREATE TABLE processing_jobs (id TEXT PRIMARY KEY, test_id TEXT NOT NULL, school TEXT NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL, payload_json TEXT NOT NULL, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL)`,
    `CREATE TABLE regrade_runs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, status TEXT NOT NULL,
      requested_by TEXT NOT NULL, requested_at TEXT NOT NULL)`,
  ], 'write');
});
afterEach(() => db.close());

const job = (id, type, status, testId = 'test_a') => ({
  sql: "INSERT INTO processing_jobs VALUES (?, ?, 'Alpha School', ?, ?, '{}', 'admin_a', '2026-07-30T10:00:00.000Z')",
  args: [id, testId, type, status],
});
const run = (id, status, scope) => ({
  sql: "INSERT INTO regrade_runs VALUES (?, ?, ?, 'admin_a', '2026-07-30T10:00:00.000Z')",
  args: [id, JSON.stringify(scope), status],
});

async function migrate() {
  await db.batch(statements.map((sql) => ({ sql })), 'write');
}

describe('088_active_job_uniqueness', () => {
  it('is idempotent', async () => {
    await migrate();
    await migrate();
    const indexes = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_one_active_%' ORDER BY name")).rows;
    expect(indexes.map((row) => row.name)).toEqual(['processing_jobs_one_active_stage_idx', 'regrade_runs_one_active_test_idx']);
  });

  it('allows one active singleton job per test and type', async () => {
    await migrate();
    await db.execute(job('j1', 'mistral_ocr', 'queued'));
    await expect(db.execute(job('j2', 'mistral_ocr', 'running'))).rejects.toThrow(/UNIQUE constraint failed/);
    // Finished history, other tests, and other singleton types are unaffected.
    await db.execute(job('j3', 'mistral_ocr', 'succeeded'));
    await db.execute(job('j4', 'mistral_ocr', 'failed_retryable'));
    await db.execute(job('j5', 'mistral_ocr', 'queued', 'test_b'));
    await db.execute(job('j6', 'build_rubric', 'queued'));
    await db.execute(job('j7', 'process_test', 'queued'));
    await expect(db.execute(job('j8', 'process_test', 'queued'))).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('leaves fan-out job types alone', async () => {
    await migrate();
    for (const id of ['g1', 'g2', 'g3']) await db.execute(job(id, 'grade_submission', 'queued'));
    for (const id of ['m1', 'm2']) await db.execute(job(id, 'materialize_evidence', 'queued'));
    expect((await db.execute('SELECT COUNT(*) AS n FROM processing_jobs')).rows[0].n).toBe(5);
  });

  it('allows one active regrade run per scope.test_id and indexes the lookup', async () => {
    await migrate();
    await db.execute(run('r1', 'queued', { school: 'Alpha School', test_id: 'test_a' }));
    await expect(db.execute(run('r2', 'running', { test_id: 'test_a' }))).rejects.toThrow(/UNIQUE constraint failed/);
    await db.execute(run('r3', 'published', { test_id: 'test_a' }));
    await db.execute(run('r4', 'queued', { test_id: 'test_b' }));
    // Legacy runs without a test id never conflict.
    await db.execute(run('r5', 'queued', { active_key: 'k1' }));
    await db.execute(run('r6', 'queued', { active_key: 'k2' }));
    const plan = await db.execute({
      sql: "EXPLAIN QUERY PLAN SELECT id FROM regrade_runs WHERE json_extract(scope, '$.test_id') = ? AND status IN ('queued', 'running') LIMIT 1",
      args: ['test_a'],
    });
    expect(plan.rows.map((row) => row.detail).join(' ')).toContain('regrade_runs_one_active_test_idx');
  });

  it('reports existing active duplicates before the indexes are created', async () => {
    await db.batch([
      job('j1', 'build_rubric', 'queued'), job('j2', 'build_rubric', 'running'),
      run('r1', 'queued', { test_id: 'test_a' }), run('r2', 'running', { test_id: 'test_a' }),
      { sql: "INSERT INTO regrade_runs VALUES ('r3', '{broken', 'queued', 'admin_a', 'x')" },
    ], 'write');
    const blockers = await findBlockers(db);
    expect(blockers.map((blocker) => blocker.rows.length)).toEqual([1, 1, 1]);
    expect(blockers[0].rows[0]).toMatchObject({ test_id: 'test_a', type: 'build_rubric', active: 2 });
    await expect(migrate()).rejects.toThrow();
  });
});
