import { beforeEach, describe, expect, it, vi } from 'vitest';

const canonical = vi.hoisted(() => ({ resolveSchoolId: vi.fn() }));
vi.mock('../../api/_lib/canonicalSubmissions.js', () => canonical);

import { loadAnswerLocations } from '../../api/_lib/answerLocationService.js';

function fakeDb({ school = 'Alpha School', assets = [], ocr = [], questions = [] } = {}) {
  const execute = vi.fn(async ({ sql }) => {
    if (sql.includes('FROM test_students ts JOIN tests t')) return { rows: school ? [{ school }] : [] };
    if (sql.includes('FROM file_assets')) return { rows: assets };
    if (sql.includes('FROM asset_ocr_runs')) return { rows: ocr };
    if (sql.includes('FROM submission_questions_v2')) return { rows: questions };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { execute };
}

const teacher = { role: 'teacher', school_id: 'school_a', username: 'teach' };
const args = { testId: 'test_1', testStudentId: 'ts_1' };

describe('loadAnswerLocations', () => {
  beforeEach(() => {
    canonical.resolveSchoolId.mockImplementation(async (_db, name) => (name === 'Alpha School' ? 'school_a' : 'school_b'));
  });

  it('requires both ids', async () => {
    await expect(loadAnswerLocations(fakeDb(), teacher, { testId: 'test_1' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns 404 for an unknown test student', async () => {
    await expect(loadAnswerLocations(fakeDb({ school: null }), teacher, args)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("denies a teacher from another school, but lets platform staff through", async () => {
    const db = fakeDb({ school: 'Beta School' });
    await expect(loadAnswerLocations(db, teacher, args)).rejects.toMatchObject({ statusCode: 403 });
    await expect(loadAnswerLocations(db, { role: 'skyll_admin' }, args)).resolves.toMatchObject({ pageCount: 0 });
  });

  it('numbers pages in upload order and searches the original OCR answer, not a reviewer edit', async () => {
    const db = fakeDb({
      assets: [
        { id: 'asset_p1', created_at: '2026-10-01T00:00:00Z' },
        { id: 'asset_p2', created_at: '2026-10-01T00:01:00Z' },
        { id: 'asset_p3', created_at: '2026-10-01T00:02:00Z' },
      ],
      ocr: [
        { asset_id: 'asset_p2', markdown: '', pages_json: JSON.stringify([{ index: 0, markdown: 'Q2 lenses converge light rays' }]) },
        { asset_id: 'asset_p1', markdown: 'Q1 centigrade is a temperature scale', pages_json: null },
      ],
      questions: [
        {
          id: 'sq_2',
          question_number: 'Q2',
          evidence_json: JSON.stringify({ student_answer: 'lenses converge light rays' }),
          render_json: JSON.stringify({ studentAnswer: { studentWrote: 'reviewer corrected wording' } }),
        },
        { id: 'sq_1', question_number: 'Q1', evidence_json: JSON.stringify({ student_answer: 'centigrade is a temperature scale' }), render_json: '{}' },
        { id: 'sq_3', question_number: 'Q3', evidence_json: '{}', render_json: '{}' },
      ],
    });

    const result = await loadAnswerLocations(db, teacher, args);

    expect(result.pageCount).toBe(3);
    expect(result.locations.map((row) => [row.questionNumber, row.page, row.match])).toEqual([
      ['Q1', 1, 'unique'],
      ['Q2', 2, 'unique'],
      ['Q3', 2, 'inferred'],
    ]);
    expect(result.locations[2]).toMatchObject({ id: 'sq_3', answered: false });
    const ocrCall = db.execute.mock.calls.find(([query]) => query.sql.includes('FROM asset_ocr_runs'));
    expect(ocrCall[0].args).toEqual(['asset_p1', 'asset_p2', 'asset_p3']);
  });
});
