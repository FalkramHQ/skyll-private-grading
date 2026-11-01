// Review queue / cohort regrade hot paths against real SQLite: aggregate run
// progress, one active run per test (migration 088), bounded revision-history
// fan-out, and race-safe report publication.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/llmGateway.js', () => ({
  callJsonModel: vi.fn(async () => { throw new Error('model offline in tests'); }),
}));
vi.mock('../../api/_lib/earlyWarning.js', () => ({ detectAndStoreEarlyWarning: vi.fn(async () => null) }));
// These tests cover publication races, not live re-totalling (see
// submission-score.test.js); with no live scoring the report totals are used.
vi.mock('../../apps/processing-worker/submissionScore.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadSubmissionScoring: vi.fn(async () => null),
}));

import { cohortRunView, createCohortRegrade, finishRunIfReady, loadRevisionHistory, retryFailedCohortRegrade } from '../../api/vl-queue.js';
import { publishSubmissionReport, refreshTeacherReportModules } from '../../api/_lib/cohortRegrade.js';
import { resetSchoolCache } from '../../api/_lib/canonicalSubmissions.js';
import { createRecheckTestDatabase, seedCanonicalQuestionStatements } from './helpers/recheckTestDatabase.js';

const { statements: migration088 } = createRequire(import.meta.url)('../../scripts/migrations/088_active_job_uniqueness.cjs');

const admin = { username: 'admin_a', role: 'admin', school: 'Alpha School', school_id: 'school_alpha' };
const scope = JSON.stringify({ school: 'Alpha School', subject: 'Physics', grade: '12', test_id: 'test_exam_alpha' });

let harness;
beforeEach(async () => { resetSchoolCache(); harness = await createRecheckTestDatabase(); });
afterEach(async () => { await harness.close(); });

async function seedRun(db, { id = 'run_a', status = 'running', runScope = scope } = {}) {
  await db.execute({
    sql: `INSERT INTO regrade_runs (id, school_id, scope, status, requested_by, requested_at)
          VALUES (?, 'school_alpha', ?, ?, 'admin_a', '2026-07-30T10:00:00.000Z')`,
    args: [id, runScope, status],
  });
  return (await db.execute({ sql: 'SELECT * FROM regrade_runs WHERE id = ?', args: [id] })).rows[0];
}

async function seedItem(db, id, state, output = null, questionId = 'question_a', runId = 'run_a') {
  await db.execute({
    sql: `INSERT INTO regrade_items (id, run_id, submission_id, submission_question_id, revision, state, output_json, error)
          VALUES (?, ?, 'submission_a', ?, 1, ?, ?, ?)`,
    args: [id, runId, questionId, state, output, state === 'failed' ? 'model timeout' : null],
  });
}

describe('cohort regrade progress', () => {
  it('counts states and module warnings in SQL and reads failed rows from canonical tables', async () => {
    const { db } = harness;
    // Canonical only: the legacy tables carry nothing for this question.
    await db.batch(seedCanonicalQuestionStatements({ questionId: 'question_a', submissionId: 'submission_a', questionNumber: 'Q7', includeLegacy: false }), 'write');
    const run = await seedRun(db);
    await seedItem(db, 'i1', 'completed', JSON.stringify({ reportModules: { refreshed: false } }), 'q1');
    await seedItem(db, 'i2', 'completed', JSON.stringify({ reportModules: { refreshed: true } }), 'q2');
    await seedItem(db, 'i3', 'completed', '{not json', 'q3');
    await seedItem(db, 'i4', 'queued', null, 'q4');
    await seedItem(db, 'i5', 'failed', null, 'question_a');

    const view = await cohortRunView(db, run);
    expect(view.progress).toEqual({ queued: 1, processing: 0, completed: 3, failed: 1 });
    expect(view.moduleWarnings).toBe(1);
    expect(view.testId).toBe('test_exam_alpha');
    expect(view.failedItems).toEqual([{ questionId: 'question_a', questionNumber: 'Q7', studentId: 'student_alpha', studentName: 'Asha', error: 'model timeout' }]);
  });

  it('skips the failed-row query when nothing failed', async () => {
    const run = await seedRun(harness.db);
    await seedItem(harness.db, 'i1', 'completed', '{}');
    const execute = vi.spyOn(harness.db, 'execute');
    const view = await cohortRunView(harness.db, run);
    expect(view.failedItems).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed or report-less output as unpublished when finishing', async () => {
    const { db } = harness;
    const run = await seedRun(db);
    await seedItem(db, 'i1', 'completed', JSON.stringify({ reportVersionId: 'report_1' }), 'q1');
    await seedItem(db, 'i2', 'completed', '{not json', 'q2');
    const finished = await finishRunIfReady(db, run, { now: () => '2026-07-30T11:00:00.000Z', refreshTeacherModules: async () => ({}) });
    expect(finished.status).toBe('partial');
    expect(JSON.parse(finished.output_manifest_json)).toMatchObject({ completed: 2, failed: 0, teacherModules: null });
  });

  it('publishes once every completed item records its report', async () => {
    const { db } = harness;
    const run = await seedRun(db);
    await seedItem(db, 'i1', 'completed', JSON.stringify({ reportVersionId: 'report_1' }), 'q1');
    await seedItem(db, 'i2', 'failed', null, 'q2');
    expect((await finishRunIfReady(db, run, { refreshTeacherModules: async () => ({}) })).status).toBe('partial');
    await db.execute("UPDATE regrade_items SET state = 'completed', output_json = '{\"reportVersionId\":\"report_2\"}' WHERE id = 'i2'");
    const finished = await finishRunIfReady(db, { ...run, status: 'running' }, { refreshTeacherModules: async () => ({ updated: 1 }) });
    expect(finished.status).toBe('published');
    expect(JSON.parse(finished.output_manifest_json)).toMatchObject({ completed: 2, failed: 0, teacherModules: { updated: 1, refreshed: true } });
  });
});

describe('one active cohort regrade per test (migration 088)', () => {
  async function seedChangedQuestion(db) {
    await db.batch([
      ...seedCanonicalQuestionStatements({ questionId: 'question_a', submissionId: 'submission_a', reviewRevision: 2, regradedRevision: 1 }),
      ...migration088.filter((sql) => sql.includes('regrade_runs')).map((sql) => ({ sql })),
    ], 'write');
  }

  it('matches the active run by scope.test_id, not a LIKE pattern', async () => {
    const { db } = harness;
    await seedChangedQuestion(db);
    // `_` is a LIKE wildcard: the old scan treated this run as test_exam_alpha's.
    await seedRun(db, { id: 'run_other', status: 'queued', runScope: JSON.stringify({ test_id: 'testXexamXalpha' }) });
    const created = await createCohortRegrade(db, admin, { school: 'Alpha School', subject: 'Physics', grade: '12', testId: 'test_exam_alpha' });
    expect(created).toMatchObject({ questionCount: 1, studentCount: 1 });
    expect(await createCohortRegrade(db, admin, { school: 'Alpha School', subject: 'Physics', grade: '12', testId: 'test_exam_alpha' }))
      .toEqual({ conflict: true, runId: created.runId });
  });

  it('turns a lost double-click race into a conflict on the winning run', async () => {
    const { db } = harness;
    await seedChangedQuestion(db);
    await seedRun(db, { id: 'run_winner', status: 'queued' });
    // The losing request read before the winner committed.
    let checked = false;
    const racing = {
      execute: async (statement) => {
        if (!checked && String(statement?.sql).includes("json_extract(scope, '$.test_id')")) {
          checked = true;
          return { rows: [] };
        }
        return db.execute(statement);
      },
      batch: (...args) => db.batch(...args),
    };
    const result = await createCohortRegrade(racing, admin, { school: 'Alpha School', subject: 'Physics', grade: '12', testId: 'test_exam_alpha' });
    expect(result).toEqual({ conflict: true, runId: 'run_winner' });
    expect((await db.execute('SELECT COUNT(*) AS n FROM regrade_runs')).rows[0].n).toBe(1);
    expect((await db.execute('SELECT COUNT(*) AS n FROM regrade_items')).rows[0].n).toBe(0);
  });

  it('refuses to resume a failed run while a newer run for the test is active', async () => {
    const { db } = harness;
    await seedChangedQuestion(db);
    await seedRun(db, { id: 'run_old', status: 'partial' });
    await seedItem(db, 'i1', 'failed', null, 'question_a', 'run_old');
    await seedRun(db, { id: 'run_new', status: 'queued' });
    await expect(retryFailedCohortRegrade(db, admin, 'run_old')).rejects.toMatchObject({ statusCode: 409 });
    expect((await db.execute("SELECT state FROM regrade_items WHERE id = 'i1'")).rows[0].state).toBe('failed');
  });
});

describe('revision history', () => {
  it('reads every chunk with at most six queries in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const db = {
      execute: vi.fn(async ({ args }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { rows: args.map((id) => ({ submission_question_id: id, revision: 1, snapshot_json: '{}', output_json: null })) };
      }),
    };
    const ids = Array.from({ length: 1000 }, (_, index) => `q${index}`);
    const history = await loadRevisionHistory(db, ids);
    expect(db.execute).toHaveBeenCalledTimes(Math.ceil(1000 / 75));
    expect(peak).toBe(6);
    expect(history.size).toBe(1000);
  });
});

describe('report publication', () => {
  const report = { student: { name: 'Asha' }, term1: { subjects: [{ name: 'Physics', score: 1, total: 5, questions: [{ number: 'Q1', marks_obtained: 1, marks_total: 5 }] }] } };
  const updates = [{
    question: { submission_question_id: 'question_a', question_number: 'Q1', subject: 'Physics', revision: 2 },
    snapshot: { approvedMarks: 4, marksTotal: 5, attempted: true, studentAnswer: 'v = u + at' },
    feedback: { whatWentCorrect: 'Correct equation.', needsAttention: '', nextStep: '', gradingReasoning: 'Fully correct.' },
  }];

  beforeEach(async () => {
    await harness.db.batch([
      'ALTER TABLE report_versions ADD COLUMN exam_id TEXT',
      'ALTER TABLE report_versions ADD COLUMN student_id TEXT',
      'ALTER TABLE submissions ADD COLUMN updated_at TEXT',
      'ALTER TABLE test_submissions ADD COLUMN score REAL',
      'ALTER TABLE test_submissions ADD COLUMN max_marks REAL',
      'ALTER TABLE test_submissions ADD COLUMN updated_at TEXT',
      ...seedCanonicalQuestionStatements({ questionId: 'question_a', submissionId: 'submission_a' }),
    ].map((sql) => (typeof sql === 'string' ? { sql } : sql)), 'write');
  });

  async function seedReport(db, id, version, status) {
    await db.execute({
      sql: `INSERT INTO report_versions (id, submission_id, version, status, generated_at, payload_json, username, school)
            VALUES (?, 'submission_a', ?, ?, '2026-07-30T10:00:00.000Z', ?, 'asha', 'Alpha School')`,
      args: [id, version, status, JSON.stringify(report)],
    });
  }

  async function versions(db) {
    return (await db.execute("SELECT id, version, status FROM report_versions WHERE submission_id = 'submission_a' ORDER BY version")).rows
      .map((row) => `${row.version}:${row.status}`);
  }

  it('allocates past a superseded version that sits above the published one', async () => {
    const { db } = harness;
    await seedReport(db, 'report_v2', 2, 'published');
    await seedReport(db, 'report_v3', 3, 'superseded');
    const published = await publishSubmissionReport(db, 'submission_a', updates, 'run_a');
    expect(published.version).toBe(4);
    expect(await versions(db)).toEqual(['2:superseded', '3:superseded', '4:published']);
    expect((await db.execute("SELECT score, max_marks FROM submissions WHERE id = 'submission_a'")).rows[0]).toMatchObject({ score: 4, max_marks: 5 });
    expect((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM report_modules WHERE report_version_id = ?', args: [published.reportId] })).rows[0].n).toBe(3);
  });

  it('retries on the new latest report when another publisher superseded it first', async () => {
    const { db } = harness;
    await seedReport(db, 'report_v1', 1, 'published');
    let raced = false;
    const racing = {
      execute: (...args) => db.execute(...args),
      batch: async (statements, mode) => {
        if (!raced) {
          raced = true;
          // Another publisher lands version 2 between our read and our write.
          await db.batch([
            { sql: "UPDATE report_versions SET status = 'superseded' WHERE id = 'report_v1'" },
            { sql: "INSERT INTO report_versions (id, submission_id, version, status, generated_at, payload_json, username, school) VALUES ('report_v2', 'submission_a', 2, 'published', 'x', ?, 'asha', 'Alpha School')", args: [JSON.stringify(report)] },
          ], 'write');
        }
        return db.batch(statements, mode);
      },
    };
    const published = await publishSubmissionReport(racing, 'submission_a', updates, 'run_a');
    expect(published.version).toBe(3);
    expect(await versions(db)).toEqual(['1:superseded', '2:superseded', '3:published']);
    // The losing attempt wrote nothing: modules exist only for the winner.
    expect((await db.execute('SELECT DISTINCT report_version_id FROM report_modules')).rows.map((row) => row.report_version_id)).toEqual([published.reportId]);
  });

  it('retries once on a version collision instead of failing', async () => {
    const { db } = harness;
    await seedReport(db, 'report_v1', 1, 'published');
    let raced = false;
    const racing = {
      execute: (...args) => db.execute(...args),
      batch: async (statements, mode) => {
        if (!raced) {
          raced = true;
          // A publisher that does not supersede (e.g. a held draft) takes version 2.
          await db.execute({ sql: "INSERT INTO report_versions (id, submission_id, version, status, generated_at, payload_json, username, school) VALUES ('report_x', 'submission_a', 2, 'draft', 'x', '{}', 'asha', 'Alpha School')" });
        }
        return db.batch(statements, mode);
      },
    };
    const published = await publishSubmissionReport(racing, 'submission_a', updates, 'run_a');
    expect(published.version).toBe(3);
    expect(await versions(db)).toEqual(['1:superseded', '2:draft', '3:published']);
  });
});

describe('teacher module refresh', () => {
  it('reports a database failure instead of claiming the cache was refreshed', async () => {
    const db = {
      execute: vi.fn(async () => { throw new Error('no such table: subjects'); }),
      batch: vi.fn(),
    };
    await expect(refreshTeacherReportModules(db, { school_id: 'school_alpha', scope })).rejects.toThrow('no such table');
    expect(db.batch).not.toHaveBeenCalled();
  });
});
