// @vitest-environment node
// Teacher dashboard cohort cache: entries carry a source watermark and are
// rebuilt when the exam's submissions move on; degraded payloads are never
// cached; the overview honours the academic-year filter. Runs the real handler
// against an in-memory database with the production schema.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDatabase } from './helpers/schemaDatabase.js';

const state = vi.hoisted(() => ({ db: null, failHotspots: false, sql: [] }));

vi.mock('../../api/_lib/auth.js', () => ({
  database: () => ({
    execute: async (statement) => {
      state.sql.push(statement.sql);
      if (state.failHotspots && statement.sql.includes('FROM submission_questions_v2')) throw new Error('hotspots down');
      return state.db.execute(statement);
    },
  }),
  ensureAuthTables: async () => {},
  requireUser: async () => ({ username: 'teacher_a', role: 'teacher', school: 'Alpha', school_id: 'sch_a' }),
}));

import handler from '../../api/teacher-dashboard.js';

const T = '2026-09-01T10:00:00.000Z';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function load(query = {}) {
  state.sql = [];
  const res = response();
  await handler({ method: 'GET', query }, res);
  expect(res.statusCode).toBe(200);
  return res.body;
}

async function seed(db) {
  const rows = [
    ['INSERT INTO academic_years (id, school_id, label, is_current, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['ay_now', 'sch_a', '2026-27', 1, T, T]],
    ['INSERT INTO academic_years (id, school_id, label, is_current, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['ay_old', 'sch_a', '2025-26', 0, T, T]],
    ['INSERT INTO subjects (id, school_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['subj_a', 'sch_a', 'Physics', T, T]],
    ['INSERT INTO tests (id, school, school_id, title, subject, grade, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['test_1', 'Alpha', 'sch_a', 'Unit 1', 'Physics', '9th', 'published', 'seed', T, T]],
    ['INSERT INTO tests (id, school, school_id, title, subject, grade, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['test_2', 'Alpha', 'sch_a', 'Unit 2', 'Physics', '9th', 'published', 'seed', T, T]],
    ['INSERT INTO tests (id, school, school_id, title, subject, grade, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['test_old', 'Alpha', 'sch_a', 'Last year', 'Physics', '9th', 'published', 'seed', T, T]],
    ['INSERT INTO exams (id, source_test_id, school_id, subject_id, academic_year_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['exam_1', 'test_1', 'sch_a', 'subj_a', 'ay_now', 'Unit 1', 'delivered', T, T]],
    ['INSERT INTO exams (id, source_test_id, school_id, subject_id, academic_year_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['exam_2', 'test_2', 'sch_a', 'subj_a', 'ay_now', 'Unit 2', 'delivered', T, T]],
    ['INSERT INTO exams (id, source_test_id, school_id, subject_id, academic_year_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ['exam_old', 'test_old', 'sch_a', 'subj_a', 'ay_old', 'Last year', 'delivered', T, T]],
    ['INSERT INTO students (id, school, school_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['stu_1', 'Alpha', 'sch_a', 'Asha', T, T]],
    ['INSERT INTO students (id, school, school_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['stu_2', 'Alpha', 'sch_a', 'Ravi', T, T]],
    ['INSERT INTO submissions (id, exam_id, student_id, status, score, max_marks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['sub_1', 'exam_1', 'stu_1', 'graded', 8, 10, T, T]],
    // Mid-grading: Ravi's paper has no score yet.
    ['INSERT INTO submissions (id, exam_id, student_id, status, score, max_marks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['sub_2', 'exam_1', 'stu_2', 'processing', null, null, T, T]],
    ['INSERT INTO submissions (id, exam_id, student_id, status, score, max_marks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['sub_3', 'exam_2', 'stu_1', 'graded', 6, 10, T, T]],
    ['INSERT INTO submissions (id, exam_id, student_id, status, score, max_marks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['sub_old', 'exam_old', 'stu_1', 'graded', 0, 10, T, T]],
  ];
  await db.batch(rows.map(([sql, args]) => ({ sql, args })), 'write');
}

async function cacheRow(examId) {
  const row = (await state.db.execute({ sql: 'SELECT payload_json FROM cohort_report_cache WHERE exam_id = ?', args: [examId] })).rows[0];
  return row ? JSON.parse(row.payload_json) : null;
}

describe('teacher dashboard cohort cache', () => {
  beforeEach(async () => {
    state.db = await createSchemaDatabase();
    state.failHotspots = false;
    await seed(state.db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('reads every exam cache entry in one query and reuses fresh entries', async () => {
    const first = await load();
    expect(first.report.cohort_reports.test_1.overview.evaluated_students).toBe(1);
    expect((await cacheRow('exam_1')).source_watermark).toBe(`2|${T}`);
    expect(state.sql.filter((sql) => sql.includes('FROM cohort_report_cache'))).toHaveLength(1);

    const second = await load();
    expect(state.sql.filter((sql) => sql.includes('FROM cohort_report_cache'))).toHaveLength(1);
    expect(state.sql.some((sql) => sql.includes('FROM submission_questions_v2'))).toBe(false);
    expect(second.report.cohort_reports).toEqual(first.report.cohort_reports);
    // The watermark is cache bookkeeping, not part of the response.
    expect(second.report.cohort_reports.test_1).not.toHaveProperty('source_watermark');
    expect(Object.keys(second.report.cohort_reports)).toEqual(Object.keys(first.report.cohort_reports));
  });

  it('recomputes a cohort when its submissions change after it was cached', async () => {
    await load();
    // Ravi's paper finishes grading after the teacher first opened the exam.
    await state.db.execute({ sql: "UPDATE submissions SET status = 'graded', score = 4, max_marks = 10, updated_at = ? WHERE id = 'sub_2'", args: ['2026-09-02T10:00:00.000Z'] });
    const body = await load();
    expect(body.report.cohort_reports.test_1.overview).toMatchObject({ evaluated_students: 2, average_percentage: 60 });
    expect((await cacheRow('exam_1')).source_watermark).toBe('2|2026-09-02T10:00:00.000Z');
    // The untouched exam is still served from cache.
    // (One hotspot query per recomputed exam; the topic query runs alongside it.)
    expect(state.sql.filter((sql) => sql.includes('FROM submission_questions_v2') && sql.includes('zero_count'))).toHaveLength(1);
  });

  it('rebuilds a legacy cache entry that has no watermark', async () => {
    await state.db.execute({
      sql: 'INSERT INTO cohort_report_cache (exam_id, school_id, payload_json, computed_at) VALUES (?, ?, ?, ?)',
      args: ['exam_1', 'sch_a', JSON.stringify({ overview: { evaluated_students: 99 }, segmentation: {} }), T],
    });
    const body = await load();
    expect(body.report.cohort_reports.test_1.overview.evaluated_students).toBe(1);
  });

  it('serves but never caches a cohort whose hotspots failed to load', async () => {
    state.failHotspots = true;
    const body = await load();
    expect(body.report.cohort_reports.test_1.exam_hotspots).toEqual([]);
    expect(await cacheRow('exam_1')).toBeNull();

    state.failHotspots = false;
    await load();
    expect(await cacheRow('exam_1')).not.toBeNull();
  });

  it('applies the academic-year filter to the overview as well as the exam list', async () => {
    const current = await load();
    expect(current.exams.map((exam) => exam.id).sort()).toEqual(['exam_1', 'exam_2']);
    // Last year's 0/10 is excluded: (80% + 60%) / 2.
    expect(current.report.cohort_report.overview).toMatchObject({ evaluated_students: 2, average_performance: '70%' });

    const all = await load({ year: 'all' });
    expect(all.report.cohort_report.overview).toMatchObject({ evaluated_students: 3, average_performance: '47%' });
  });
});
