// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/cohortRegrade.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateQuestionFeedback: vi.fn(async () => ({
      whatWentCorrect: 'ok', needsAttention: '', nextStep: '', gradingReasoning: 'ok', model: 'test-model',
    })),
    publishSubmissionReport: vi.fn(async () => null),
    refreshTeacherReportModules: vi.fn(async () => ({ updated: 0 })),
  };
});

import {
  DEFAULT_COHORT_REGRADE_ITEM_LEASE_MS,
  DEFAULT_COHORT_REGRADE_ITEM_MAX_ATTEMPTS,
  REGRADE_ITEM_LEASE_EXPIRED_ERROR,
  claimRegradeItemStatement,
  expireStaleRegradeItemsStatements,
  regradeItemLeaseDecision,
  regradeItemLeaseMs,
  regradeItemMaxAttempts,
} from '../../api/_lib/regradeItemLease.js';
import { processCohortRegradeStep } from '../../api/vl-queue.js';
import { createRecheckTestDatabase } from './helpers/recheckTestDatabase.js';

const NOW = new Date('2026-10-07T10:00:00.000Z');

describe('regrade item lease decisions', () => {
  it('defaults to a 10 minute lease and 3 attempts, honouring env overrides', () => {
    expect(regradeItemLeaseMs({})).toBe(DEFAULT_COHORT_REGRADE_ITEM_LEASE_MS);
    expect(regradeItemLeaseMs({ COHORT_REGRADE_ITEM_LEASE_MS: '120000' })).toBe(120_000);
    expect(regradeItemLeaseMs({ COHORT_REGRADE_ITEM_LEASE_MS: '5' })).toBe(DEFAULT_COHORT_REGRADE_ITEM_LEASE_MS);
    expect(regradeItemMaxAttempts({})).toBe(DEFAULT_COHORT_REGRADE_ITEM_MAX_ATTEMPTS);
    expect(regradeItemMaxAttempts({ COHORT_REGRADE_ITEM_MAX_ATTEMPTS: '5' })).toBe(5);
    expect(regradeItemMaxAttempts({ COHORT_REGRADE_ITEM_MAX_ATTEMPTS: '0' })).toBe(DEFAULT_COHORT_REGRADE_ITEM_MAX_ATTEMPTS);
  });

  it('requeues an expired item until it has been claimed max attempts times, then fails it', () => {
    expect(regradeItemLeaseDecision({ attemptCount: 0 })).toBe('requeue');
    expect(regradeItemLeaseDecision({ attemptCount: 2 })).toBe('requeue');
    expect(regradeItemLeaseDecision({ attemptCount: 3 })).toBe('fail');
    expect(regradeItemLeaseDecision({ attemptCount: 1, maxAttempts: 1 })).toBe('fail');
  });

  it('builds the expiry batch with the cutoff and attempt bound, scoped to the run', () => {
    const [fail, requeue] = expireStaleRegradeItemsStatements({ runId: 'run_1', now: NOW, leaseMs: 10 * 60_000, maxAttempts: 3 });
    const cutoff = '2026-10-07T09:50:00.000Z';
    expect(fail.sql).toContain("SET state = 'failed'");
    expect(fail.sql).toContain("state = 'processing'");
    expect(fail.sql).toContain('COALESCE(attempt_count, 0) >= ?');
    expect(fail.args).toEqual([`${REGRADE_ITEM_LEASE_EXPIRED_ERROR} after 3 attempt(s)`, NOW.toISOString(), 'run_1', cutoff, 3]);
    expect(requeue.sql).toContain("SET state = 'queued', started_at = NULL");
    expect(requeue.sql).toContain('COALESCE(attempt_count, 0) < ?');
    expect(requeue.args).toEqual([`${REGRADE_ITEM_LEASE_EXPIRED_ERROR}; requeued`, 'run_1', cutoff, 3]);
  });

  it('claims the oldest queued item and counts the attempt', () => {
    const claim = claimRegradeItemStatement({ runId: 'run_1', now: NOW });
    expect(claim.sql).toContain("SET state = 'processing', started_at = ?");
    expect(claim.sql).toContain('attempt_count = COALESCE(attempt_count, 0) + 1');
    expect(claim.sql).toContain('RETURNING *');
    expect(claim.args).toEqual([NOW.toISOString(), 'run_1']);
  });

  it('runs the expiry batch before claiming when driven through a mocked db', async () => {
    const db = {
      batch: vi.fn(async () => []),
      execute: vi.fn(async ({ sql }) => {
        if (/RETURNING \*/.test(sql)) return { rows: [] };
        if (/FROM regrade_items WHERE run_id = \?/.test(sql)) return { rows: [{ state: 'completed', submission_question_id: 'q1', output_json: JSON.stringify({ reportVersionId: 'rv' }) }] };
        if (/SELECT i\.state/.test(sql)) return { rows: [] };
        if (/SELECT id, status, submission_id FROM recheck_requests/.test(sql)) return { rows: [] };
        return { rows: [], rowsAffected: 1 };
      }),
    };
    await processCohortRegradeStep(db, { username: 'oci_worker', role: 'skyll_admin', school: '' }, { id: 'run_1', status: 'running', scope: '{}' });
    expect(db.batch).toHaveBeenCalled();
    const [statements, mode] = db.batch.mock.calls[0];
    expect(mode).toBe('write');
    expect(statements.map((statement) => statement.sql)).toEqual(expireStaleRegradeItemsStatements({ runId: 'run_1' }).map((statement) => statement.sql));
    const claimCall = db.execute.mock.calls.find(([statement]) => /RETURNING \*/.test(statement.sql));
    expect(claimCall).toBeTruthy();
    expect(db.batch.mock.invocationCallOrder[0]).toBeLessThan(db.execute.mock.invocationCallOrder[db.execute.mock.calls.indexOf(claimCall)]);
  });
});

describe('regrade item lease against a real schema', () => {
  let ctx;
  beforeEach(async () => { ctx = await createRecheckTestDatabase(); });
  afterEach(async () => { await ctx.close(); });

  const actor = { username: 'oci_worker', role: 'skyll_admin', school: '' };
  const snapshot = (questionId, submissionId) => JSON.stringify({
    questionId, submissionId, questionNumber: 'Q1', approvedMarks: 2, marksTotal: 5, attempted: true,
    studentAnswer: 'answer', payload: { studentAnswer: { attempted: true, studentWrote: 'answer' }, grade: { marks: 1, allocated: 5, status: 'partial' } },
  });

  async function seedRun({ stuckAttempts, stuckStartedAt }) {
    await ctx.db.batch([
      { sql: "INSERT INTO test_submissions (id, test_id, student_id, status) VALUES ('sub_a', 'test_a', 'stu_a', 'published')" },
      { sql: `INSERT INTO submission_questions (id, submission_id, school, subject, question_number, student_name, payload_json, ai_marks, approved_marks, marks_total, status, review_revision, regraded_revision, updated_at)
              VALUES ('q_stuck', 'sub_a', 'Alpha', 'Physics', 'Q1', 'Asha', '{}', 1, 2, 5, 'published', 2, 0, '2026-10-01T00:00:00.000Z')` },
      { sql: `INSERT INTO submission_questions (id, submission_id, school, subject, question_number, student_name, payload_json, ai_marks, approved_marks, marks_total, status, review_revision, regraded_revision, updated_at)
              VALUES ('q_fresh', 'sub_a', 'Alpha', 'Physics', 'Q2', 'Asha', '{}', 1, 2, 5, 'published', 2, 0, '2026-10-01T00:00:00.000Z')` },
      { sql: `INSERT INTO submission_questions_v2 (id, submission_id, exam_set_question_id, question_number, ai_marks, approved_marks, status, review_revision, regraded_revision, evidence_json, source_asset_ids_json, created_at, updated_at)
              VALUES ('q_stuck', 'sub_a', 'esq_1', 'Q1', 1, 2, 'published', 2, 0, '{}', '[]', '', '')` },
      { sql: `INSERT INTO submission_questions_v2 (id, submission_id, exam_set_question_id, question_number, ai_marks, approved_marks, status, review_revision, regraded_revision, evidence_json, source_asset_ids_json, created_at, updated_at)
              VALUES ('q_fresh', 'sub_a', 'esq_2', 'Q2', 1, 2, 'published', 2, 0, '{}', '[]', '', '')` },
      { sql: `INSERT INTO regrade_runs (id, scope, status, requested_by, requested_at)
              VALUES ('run_a', '{"school":"Alpha","subject":"Physics","grade":"11","test_id":"test_a"}', 'running', 'admin', '2026-10-01T00:00:00.000Z')` },
      { sql: `INSERT INTO regrade_items (id, run_id, submission_id, submission_question_id, revision, state, input_snapshot_json, started_at, attempt_count)
              VALUES ('item_stuck', 'run_a', 'sub_a', 'q_stuck', 2, 'processing', ?, ?, ?)`, args: [snapshot('q_stuck', 'sub_a'), stuckStartedAt, stuckAttempts] },
      { sql: `INSERT INTO regrade_items (id, run_id, submission_id, submission_question_id, revision, state, input_snapshot_json)
              VALUES ('item_fresh', 'run_a', 'sub_a', 'q_fresh', 2, 'queued', ?)`, args: [snapshot('q_fresh', 'sub_a')] },
    ], 'write');
  }

  const itemStates = async () => Object.fromEntries((await ctx.db.execute('SELECT id, state, attempt_count, error FROM regrade_items ORDER BY rowid')).rows.map((row) => [row.id, { state: row.state, attempts: Number(row.attempt_count), error: row.error }]));

  it('requeues an item stuck in processing past the lease and processes the freshly queued one first', async () => {
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    await seedRun({ stuckAttempts: 1, stuckStartedAt: stale });
    const run = (await ctx.db.execute("SELECT * FROM regrade_runs WHERE id = 'run_a'")).rows[0];

    await processCohortRegradeStep(ctx.db, actor, run);
    let states = await itemStates();
    // item_stuck (rowid 1) was requeued and claimed again; item_fresh waits.
    expect(states.item_stuck).toMatchObject({ state: 'completed', attempts: 2 });
    expect(states.item_fresh).toMatchObject({ state: 'queued', attempts: 0 });

    await processCohortRegradeStep(ctx.db, actor, run);
    states = await itemStates();
    expect(states.item_fresh).toMatchObject({ state: 'completed', attempts: 1 });
  });

  it('fails an item whose lease expired after the maximum attempts so the run can finish as partial', async () => {
    const stale = new Date(Date.now() - 11 * 60_000).toISOString();
    await seedRun({ stuckAttempts: 3, stuckStartedAt: stale });
    const run = (await ctx.db.execute("SELECT * FROM regrade_runs WHERE id = 'run_a'")).rows[0];

    await processCohortRegradeStep(ctx.db, actor, run);
    const states = await itemStates();
    expect(states.item_stuck).toMatchObject({ state: 'failed', attempts: 3 });
    expect(states.item_stuck.error).toContain(REGRADE_ITEM_LEASE_EXPIRED_ERROR);
    expect(states.item_fresh).toMatchObject({ state: 'completed', attempts: 1 });

    const result = await processCohortRegradeStep(ctx.db, actor, run);
    expect(result.done).toBe(true);
    expect(result.run.status).toBe('partial');
    expect(result.run.failedItems).toHaveLength(1);
    expect((await ctx.db.execute("SELECT status FROM regrade_runs WHERE id = 'run_a'")).rows[0].status).toBe('partial');
  });

  it('leaves an item that is still inside its lease alone', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    await seedRun({ stuckAttempts: 1, stuckStartedAt: recent });
    const run = (await ctx.db.execute("SELECT * FROM regrade_runs WHERE id = 'run_a'")).rows[0];

    await processCohortRegradeStep(ctx.db, actor, run);
    const states = await itemStates();
    expect(states.item_stuck).toMatchObject({ state: 'processing', attempts: 1 });
    expect(states.item_fresh).toMatchObject({ state: 'completed', attempts: 1 });
    // Nothing left to claim; the run stays open because item_stuck is still leased.
    const result = await processCohortRegradeStep(ctx.db, actor, run);
    expect(result.done).toBe(false);
  });
});
