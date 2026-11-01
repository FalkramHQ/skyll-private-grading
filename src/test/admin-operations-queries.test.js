// @vitest-environment node
// Operations list queries against the production schema: per-test job counts
// are not starved by a global job cap, child tables are aggregated per test,
// and publications come from canonical submissions.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDatabase } from './helpers/schemaDatabase.js';

const state = vi.hoisted(() => ({ db: null }));

vi.mock('../../api/_lib/auth.js', () => ({
  database: () => state.db,
  ensureAuthTables: async () => {},
  requireUser: async () => ({ username: 'admin_a', role: 'admin', school: 'Alpha', school_id: 'sch_a' }),
}));
vi.mock('../../api/_lib/intake.js', () => ({ ensureIntakeTables: async () => {} }));

import handler, { withStageCounts } from '../../server/admin/operations.js';

const at = (minute) => `2026-09-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function job(id, testId, type, status, requestedAt, extra = {}) {
  return {
    sql: `INSERT INTO processing_jobs (id, test_id, school, type, status, payload_json, requested_by, requested_at, progress_json)
          VALUES (?, ?, ?, ?, ?, '{}', 'seed', ?, ?)`,
    args: [id, testId, extra.school || 'Alpha', type, status, requestedAt, extra.progress || null],
  };
}

async function seed(db) {
  const T = at(0);
  const statements = [
    ...['test_busy', 'test_quiet'].map((id, index) => ({
      sql: 'INSERT INTO tests (id, school, school_id, title, subject, grade, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      args: [id, 'Alpha', 'sch_a', id, 'Physics', '9th', 'processing', 'seed', T, at(50 - index)],
    })),
    { sql: 'INSERT INTO tests (id, school, school_id, title, subject, grade, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: ['test_beta', 'Beta', 'sch_b', 'beta', 'Physics', '9th', 'processing', 'seed', T, at(59)] },
    // Three students and four assets on the busy test.
    ...[1, 2, 3].map((n) => ({
      sql: 'INSERT INTO test_students (id, test_id, student_id, student_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [`ts_${n}`, 'test_busy', `stu_${n}`, `Student ${n}`, n < 3 ? 'uploaded' : 'expected', T],
    })),
    ...[['as_1', 'answer_sheet', 'uploaded'], ['as_2', 'answer_sheet', 'uploaded'], ['qp', 'question_paper', 'uploaded'], ['pending', 'answer_sheet', 'registered']].map(([id, kind, status]) => ({
      sql: 'INSERT INTO file_assets (id, test_id, kind, storage_key, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [id, 'test_busy', kind, `k/${id}`, status, 'seed', T],
    })),
    // The quiet test's only job is older than every busy-test job.
    job('ocr_quiet', 'test_quiet', 'mistral_ocr', 'succeeded', at(1)),
    job('ocr_busy', 'test_busy', 'mistral_ocr', 'succeeded', at(2)),
    // 250 per-question grade jobs, more than the old global cap of 200.
    ...Array.from({ length: 250 }, (_, n) => job(`grade_${n}`, 'test_busy', 'grade_submission',
      n < 200 ? 'succeeded' : n < 240 ? 'queued' : n < 245 ? 'running' : 'failed_retryable', at(10 + (n % 20)))),
    job('grade_latest_running', 'test_busy', 'grade_submission', 'running', at(40), { progress: JSON.stringify({ steps: { grade: { status: 'running', detail: 'Q7' } } }) }),
    job('ocr_beta', 'test_beta', 'mistral_ocr', 'running', at(45), { school: 'Beta' }),
    // Canonical: two live submissions on the busy test's exam, one published.
    { sql: 'INSERT INTO exams (id, source_test_id, school_id, subject_id, academic_year_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', args: ['exam_busy', 'test_busy', 'sch_a', 'subj', 'ay', 'Busy', 'delivered', T, T] },
    ...[['sub_1', 'graded'], ['sub_2', 'graded'], ['sub_gone', 'archived']].map(([id, status], n) => ({
      sql: 'INSERT INTO submissions (id, exam_id, student_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, 'exam_busy', `stu_${n + 1}`, status, T, T],
    })),
    { sql: "INSERT INTO report_versions (id, submission_id, version, status, generated_at, published_at, payload_json) VALUES ('rv_1', 'sub_1', 1, 'published', ?, ?, '{}')", args: [T, at(30)] },
    // Legacy rows that must no longer be read.
    ...[1, 2, 3, 4, 5].map((n) => ({
      sql: "INSERT INTO test_submissions (id, test_id, student_id, status, created_at, updated_at) VALUES (?, 'test_busy', ?, 'graded', ?, ?)",
      args: [`legacy_${n}`, `legacy_stu_${n}`, T, T],
    })),
  ];
  await db.batch(statements, 'write');
}

describe('admin operations list queries', () => {
  beforeEach(async () => {
    state.db = await createSchemaDatabase();
    await seed(state.db);
  });

  it('reports full per-test job counts and the latest job of every test', async () => {
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(res.body.tests.map((test) => [test.id, test]));
    expect(Object.keys(byId).sort()).toEqual(['test_busy', 'test_quiet']);

    const busy = byId.test_busy;
    expect(busy.grading).toEqual({ queued: 40, running: 6, succeeded: 200, failed: 5 });
    expect(busy.assessment.processing.stages.grading).toEqual({ status: 'running', queued: 40, running: 6, succeeded: 200, failed: 5 });
    expect(busy.assessment.processing.stages.ocr).toEqual({ status: 'succeeded', queued: 0, running: 0, succeeded: 1, failed: 0 });
    expect(busy.assessment.processing.current).toMatchObject({ stage: 'grade_submission', status: 'running', detail: 'Q7' });
    expect(busy.jobRequestedAt).toBe(at(40));
    expect(busy.ocrJob).toMatchObject({ id: 'ocr_busy', status: 'succeeded' });

    // Previously cut off by the global LIMIT 200.
    expect(byId.test_quiet.ocrJob).toMatchObject({ id: 'ocr_quiet', status: 'succeeded' });
    expect(byId.test_quiet.jobStatus).toBe('succeeded');
  });

  it('aggregates students and assets per test without multiplying them', async () => {
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    const busy = res.body.tests.find((test) => test.id === 'test_busy');
    expect(busy).toMatchObject({ expectedStudents: 3, uploadedStudents: 2, answerSheets: 2 });
    const quiet = res.body.tests.find((test) => test.id === 'test_quiet');
    expect(quiet).toMatchObject({ expectedStudents: 0, uploadedStudents: 0, answerSheets: 0 });
  });

  it('reads publication progress from canonical submissions', async () => {
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    const busy = res.body.tests.find((test) => test.id === 'test_busy');
    expect(busy.assessment.publication).toEqual({ submissionCount: 2, publishedReportCount: 1, complete: false });
  });

  it('keeps counts the projection derived when no aggregate exists for a stage', () => {
    const assessment = { processing: { stages: { ocr: { status: 'queued', queued: 1, running: 0, succeeded: 0, failed: 0 }, grading: null } } };
    const counts = new Map([['grade_submission', { queued: 9, running: 0, succeeded: 0, failed: 0 }]]);
    expect(withStageCounts(assessment, counts).processing.stages).toEqual({
      ocr: { status: 'queued', queued: 1, running: 0, succeeded: 0, failed: 0 },
      grading: null,
    });
  });
});
