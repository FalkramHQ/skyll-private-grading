import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSchemaDatabase } from './helpers/schemaDatabase.js';
import {
  findScoreMismatches,
  gradeMarkStatements,
  loadSubmissionScoring,
  reportScoreMismatches,
  scoreQuestionRows,
  syncReportTotals,
  teacherKeptMarks,
} from '../../apps/processing-worker/submissionScore.js';
import { publishSubmissionReport, retotalSubmissionScore } from '../../api/_lib/cohortRegrade.js';
import { findOverwrittenAiMarks, findStaleSubmissions, repairSubmission, restoreAiMarks } from '../../scripts/lib/scoreRepair.mjs';

const T = '2026-10-21T10:00:00.000Z';
// "Answer any one of Q2 and Q3": best score counts.
const plan = { groups: [{ id: 'g1', choose: 1, units: [{ id: 'Q2', question_numbers: ['Q2'] }, { id: 'Q3', question_numbers: ['Q3'] }] }] };

const question = (number, { ai, approved = null, total = 10, status = 'partial', reviewRevision = 0 } = {}) => ({
  id: `q_${number}`, submission_id: 's1', question_id: `esq_${number}`, question_number: number,
  evidence_json: JSON.stringify({ attempted: true, source_pages: [1] }), source_asset_ids_json: '[]',
  ai_marks: ai, approved_marks: approved, marks_total: total, status: 'graded',
  review_revision: reviewRevision, payload_json: JSON.stringify({ grade: { marks: approved ?? ai, status } }),
});

// Q1 teacher 6 (AI 4), Q2 AI 5, Q3 AI 9 (chosen over Q2), Q4 evidence-blocked:
// 6 + 9 + 0 = 15 of 30.
const rows = [
  question('Q1', { ai: 4, approved: 6, reviewRevision: 1 }),
  question('Q2', { ai: 5 }),
  question('Q3', { ai: 9 }),
  question('Q4', { ai: 3, status: 'evidence_blocked' }),
];

const staleReport = {
  student: { name: 'Student' },
  term1: { subjects: [{ name: 'Physics', score: 8.5, total: 30, scoring_plan: plan, questions: rows.map((row) => ({ number: row.question_number, marks_obtained: 0, marks_total: 10 })) }] },
};

async function seed(db, { report = staleReport, rubric = true } = {}) {
  const ops = [
    { sql: "INSERT INTO tests (id, school, title, subject, grade, status, created_by, created_at, updated_at) VALUES ('t1', 'Alpha School', 'Unit test', 'Physics', '10', 'ready_for_review', 'x', ?, ?)", args: [T, T] },
    { sql: "INSERT INTO test_submissions (id, test_id, student_id, status, score, max_marks, created_at, updated_at) VALUES ('s1', 't1', 'st1', 'ready_for_review', 8.5, 30, ?, ?)", args: [T, T] },
    { sql: "INSERT INTO submissions (id, exam_id, student_id, status, score, max_marks, created_at, updated_at) VALUES ('s1', 'e1', 'st1', 'ready_for_review', 8.5, 30, ?, ?)", args: [T, T] },
    { sql: "INSERT INTO cohort_report_cache (exam_id, school_id, payload_json, computed_at) VALUES ('e1', 'school_a', '{}', ?)", args: [T] },
    ...rows.map((row) => ({
      // Reviewed questions are seeded as already regraded (nothing pending).
      sql: `INSERT INTO submission_questions (id, submission_id, question_id, question_number, evidence_json, source_asset_ids_json, ai_marks, approved_marks, marks_total, status, review_revision, regraded_revision, payload_json, subject, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Physics', ?, ?)`,
      args: [row.id, row.submission_id, row.question_id, row.question_number, row.evidence_json, row.source_asset_ids_json, row.ai_marks, row.approved_marks, row.marks_total, row.status, row.review_revision, row.review_revision, row.payload_json, T, T],
    })),
    ...rows.map((row) => ({
      sql: `INSERT INTO submission_questions_v2 (id, submission_id, exam_set_question_id, question_number, ai_marks, approved_marks, status, review_revision, evidence_json, source_asset_ids_json, render_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [row.id, row.submission_id, row.question_id, row.question_number, row.ai_marks, row.approved_marks, row.status, row.review_revision, row.evidence_json, row.source_asset_ids_json, row.payload_json, T, T],
    })),
  ];
  if (rubric) ops.push({ sql: "INSERT INTO exam_rubric_versions (id, test_id, job_id, version, status, model, source_ocr_run_ids_json, question_map_json, created_at, is_active) VALUES ('r1', 't1', 'j1', 1, 'succeeded', 'm', '[]', ?, ?, 1)", args: [JSON.stringify({ exam: { scoring_plan: plan }, questions: [] }), T] });
  if (report) ops.push({ sql: "INSERT INTO report_versions (id, submission_id, version, status, generated_at, published_at, payload_json, username, school) VALUES ('rv1', 's1', 1, 'published', ?, ?, ?, 'alpha_st1', 'Alpha School')", args: [T, T, JSON.stringify(report)] });
  await db.batch(ops, 'write');
}

const fakeAlerts = () => ({ send: vi.fn(async () => ({ sent: true })) });

describe('scoreQuestionRows', () => {
  it('prefers the teacher mark, zeroes evidence-blocked questions and applies choice rules', () => {
    const scoring = scoreQuestionRows(rows, plan);
    expect(scoring.score).toBe(15);
    expect(scoring.total).toBe(30);
    expect(scoring.questions.find((q) => q.number === 'Q2').counts_toward_score).toBe(false);
    expect(scoring.questions.find((q) => q.number === 'Q4').marks_obtained).toBe(0);
  });

  it('counts every question when there is no plan', () => {
    expect(scoreQuestionRows(rows, null)).toMatchObject({ score: 20, total: 40 });
  });

  it("counts a teacher's mark on a question the pipeline found no answer for", () => {
    // Kavya Q8.1: no answer captured, the teacher found it on the sheet and gave 3/3.
    const marked = question('Q4', { ai: null, approved: 3, status: 'evidence_blocked', reviewRevision: 2 });
    const scoring = scoreQuestionRows([...rows.slice(0, 3), marked], plan);
    expect(scoring.score).toBe(18);
    expect(scoring.questions.find((q) => q.number === 'Q4').marks_obtained).toBe(3);
  });
});

describe('syncReportTotals', () => {
  const live = { scoring: scoreQuestionRows(rows, plan), plan };

  it('writes the live marks and totals into the report subject', () => {
    const { report, synced } = syncReportTotals(staleReport, live, 'Physics');
    const subject = report.term1.subjects[0];
    expect(synced).toBe(true);
    expect(subject).toMatchObject({ score: 15, total: 30, status: 'developing' });
    expect(subject.questions.find((q) => q.number === 'Q1').marks_obtained).toBe(6);
    expect(staleReport.term1.subjects[0].score).toBe(8.5);
  });

  it('reports when it cannot find the subject', () => {
    const twoSubjects = { term1: { subjects: [{ name: 'Physics' }, { name: 'Chemistry' }] } };
    expect(syncReportTotals(twoSubjects, live, 'Biology').synced).toBe(false);
  });
});

describe('stored score checks and re-totalling', () => {
  let db;
  beforeEach(async () => {
    db = await createSchemaDatabase();
    // The report-module refresh calls a model; keep tests offline.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('loads the live total with the active rubric plan', async () => {
    await seed(db);
    const live = await loadSubmissionScoring(db, 's1');
    expect(live.scoring).toMatchObject({ score: 15, total: 30 });
    expect(live.submission).toMatchObject({ test_id: 't1', school: 'Alpha School' });
  });

  it('finds the stale score in both tables and the published report', async () => {
    await seed(db);
    const mismatches = await findScoreMismatches(db, 's1', { score: 15, total: 30 });
    expect(mismatches.map((m) => m.place)).toEqual(['test_submissions', 'submissions', 'report']);
  });

  it('treats a missing canonical row as a mismatch (lost mirror)', async () => {
    await seed(db);
    await db.execute("DELETE FROM submissions WHERE id = 's1'");
    await db.execute("UPDATE test_submissions SET score = 15 WHERE id = 's1'");
    const mismatches = await findScoreMismatches(db, 's1', { score: 15, total: 30 });
    expect(mismatches.map((m) => m.place)).toEqual(['submissions', 'report']);
  });

  it('re-totals a held submission (no published report) and invalidates the dashboard cache', async () => {
    await seed(db, { report: null });
    const alerts = fakeAlerts();
    expect(await retotalSubmissionScore(db, 's1', { alerts })).toEqual({ score: 15, total: 30 });
    const legacy = (await db.execute("SELECT score, max_marks FROM test_submissions WHERE id = 's1'")).rows[0];
    const canonical = (await db.execute("SELECT score, max_marks FROM submissions WHERE id = 's1'")).rows[0];
    expect(legacy).toMatchObject({ score: 15, max_marks: 30 });
    expect(canonical).toMatchObject({ score: 15, max_marks: 30 });
    expect((await db.execute("SELECT invalidated_at FROM cohort_report_cache WHERE exam_id = 'e1'")).rows[0].invalidated_at).toBeTruthy();
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it('publishes a regraded report re-totalled from live marks, even when the patch matches no question', async () => {
    await seed(db);
    const alerts = fakeAlerts();
    const unmatched = { question: { subject: 'Physics', question_number: 'Q99', submission_question_id: 'q_Q99', revision: 1 }, snapshot: { approvedMarks: 1, marksTotal: 1, attempted: true }, feedback: {} };
    const published = await publishSubmissionReport(db, 's1', [unmatched], 'run_1', { alerts });
    expect(published.version).toBe(2);
    const report = JSON.parse((await db.execute("SELECT payload_json FROM report_versions WHERE submission_id = 's1' AND status = 'published'")).rows[0].payload_json);
    expect(report.term1.subjects[0]).toMatchObject({ score: 15, total: 30 });
    expect((await db.execute("SELECT score FROM test_submissions WHERE id = 's1'")).rows[0].score).toBe(15);
    expect((await db.execute("SELECT score FROM submissions WHERE id = 's1'")).rows[0].score).toBe(15);
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it('alerts once per call with the count when stored scores are stale', async () => {
    const alerts = fakeAlerts();
    const log = vi.fn();
    const items = [
      { submissionId: 's1', expected: { score: 15, total: 30 }, mismatches: [{ place: 'submissions', score: 8.5, max_marks: 30 }] },
      { submissionId: 's2', expected: { score: 10, total: 30 }, mismatches: [{ place: 'report', score: 9, max_marks: 30 }] },
      { submissionId: 's3', expected: { score: 12, total: 30 }, mismatches: [] },
    ];
    expect(await reportScoreMismatches({ alerts, log, school: 'Alpha School', testId: 't1', source: 'build_reports', items })).toBe(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect(alerts.send).toHaveBeenCalledTimes(1);
    expect(alerts.send.mock.calls[0][1]).toMatchObject({ submissions: 2, submissionIds: 's1, s2', expected: '15/30', stored: 'submissions 8.5/30' });
    expect(alerts.send.mock.calls[0][2]).toEqual({ key: 't1' });
  });
});

describe('re-grade guard for teacher-reviewed questions', () => {
  let db;
  beforeEach(async () => { db = await createSchemaDatabase(); await seed(db); });

  it('knows the teacher mark only on a reviewed question', () => {
    expect(teacherKeptMarks({ review_revision: 1, approved_marks: 6 })).toBe(6);
    expect(teacherKeptMarks({ review_revision: 0, approved_marks: 6 })).toBe(null);
    expect(teacherKeptMarks({ review_revision: 2, approved_marks: null })).toBe(null);
  });

  it('refreshes ai_marks but keeps the teacher mark in both tables', async () => {
    await db.batch(gradeMarkStatements({ questionId: 'q_Q1', aiMarks: 2, payloadJson: '{}', completed: T }), 'write');
    await db.batch(gradeMarkStatements({ questionId: 'q_Q2', aiMarks: 7, payloadJson: '{}', completed: T }), 'write');
    for (const table of ['submission_questions', 'submission_questions_v2']) {
      const reviewed = (await db.execute(`SELECT ai_marks, approved_marks FROM ${table} WHERE id = 'q_Q1'`)).rows[0];
      const fresh = (await db.execute(`SELECT ai_marks, approved_marks FROM ${table} WHERE id = 'q_Q2'`)).rows[0];
      expect(reviewed).toMatchObject({ ai_marks: 2, approved_marks: 6 });
      expect(fresh).toMatchObject({ ai_marks: 7, approved_marks: 7 });
    }
  });
});

describe('repair and backfill scripts', () => {
  let db;
  beforeEach(async () => { db = await createSchemaDatabase(); });

  it('finds the stale submission, repairs scores and the report total, and is idempotent', async () => {
    await seed(db);
    const first = await findStaleSubmissions(db, { school: 'Alpha School' });
    expect(first.checked).toBe(1);
    expect(first.stale).toHaveLength(1);
    expect(first.stale[0].expected).toEqual({ score: 15, total: 30 });

    const result = await repairSubmission(db, first.stale[0], { now: T });
    expect(result).toMatchObject({ submissionId: 's1', reportVersion: 2, remaining: [] });
    const versions = (await db.execute("SELECT version, status, workflow_run_id, payload_json FROM report_versions WHERE submission_id = 's1' ORDER BY version")).rows;
    expect(versions.map((v) => v.status)).toEqual(['superseded', 'published']);
    const repaired = JSON.parse(versions[1].payload_json);
    expect(repaired.term1.subjects[0]).toMatchObject({ score: 15, total: 30 });
    expect(repaired.workflow.score_repair.previous).toEqual({ score: 8.5, total: 30 });
    expect(versions[1].workflow_run_id).toBe('score_repair');

    expect((await findStaleSubmissions(db)).stale).toHaveLength(0);
  });

  it('leaves submissions with teacher changes waiting for a regrade alone', async () => {
    await seed(db);
    await db.execute("UPDATE submission_questions SET review_revision = 2, regraded_revision = 1 WHERE id = 'q_Q1'");
    expect(await findStaleSubmissions(db)).toMatchObject({ checked: 0, pendingRegrade: 1, stale: [] });
  });

  it('allows a negative total from negative marking', async () => {
    await seed(db);
    await db.execute("UPDATE submission_questions SET ai_marks = -10, approved_marks = NULL, review_revision = 0 WHERE id IN ('q_Q1', 'q_Q3')");
    const { stale } = await findStaleSubmissions(db);
    expect(stale[0].expected.score).toBe(-5);
  });

  it('skips submissions with ungraded questions and other schools', async () => {
    await seed(db);
    expect((await findStaleSubmissions(db, { school: 'Beta School' })).checked).toBe(0);
    await db.execute("UPDATE submission_questions SET ai_marks = NULL, approved_marks = NULL WHERE id = 'q_Q2'");
    expect((await findStaleSubmissions(db)).checked).toBe(0);
  });

  it('restores the AI mark from the earliest regrade snapshot, else the first override event', async () => {
    await seed(db, { report: null });
    // Q1 and Q2 were regraded, which copied the teacher mark into ai_marks.
    await db.batch([
      { sql: "UPDATE submission_questions_v2 SET status = 'regraded', ai_marks = 6, approved_marks = 6 WHERE id IN ('q_Q1')" },
      { sql: "UPDATE submission_questions SET ai_marks = 6, approved_marks = 6 WHERE id = 'q_Q1'" },
      { sql: "UPDATE submission_questions_v2 SET status = 'regraded', ai_marks = 8, approved_marks = 8 WHERE id = 'q_Q2'" },
      { sql: "UPDATE submission_questions SET ai_marks = 8, approved_marks = 8 WHERE id = 'q_Q2'" },
      // Answer-text-only edit: snapshot AI mark equals the current mark.
      { sql: "UPDATE submission_questions_v2 SET status = 'regraded', ai_marks = 9, approved_marks = 9 WHERE id = 'q_Q3'" },
      { sql: "INSERT INTO submission_question_revisions (id, submission_question_id, revision, source, snapshot_json, created_at) VALUES ('rev1', 'q_Q1', 1, 'cohort_regrade_snapshot', ?, ?)", args: [JSON.stringify({ payload: { grade: { marks: 4 } } }), T] },
      { sql: "INSERT INTO submission_question_revisions (id, submission_question_id, revision, source, snapshot_json, created_at) VALUES ('rev2', 'q_Q1', 2, 'cohort_regrade_snapshot', ?, ?)", args: [JSON.stringify({ payload: { grade: { marks: 6 } } }), T] },
      { sql: "INSERT INTO question_review_events (id, submission_question_id, actor_user_id, event_type, before_json, after_json, created_at) VALUES ('ev1', 'q_Q2', 'teacher', 'marks_overridden', ?, '{}', ?)", args: [JSON.stringify({ marks: 5 }), T] },
      { sql: "INSERT INTO submission_question_revisions (id, submission_question_id, revision, source, snapshot_json, created_at) VALUES ('rev3', 'q_Q3', 1, 'cohort_regrade_snapshot', ?, ?)", args: [JSON.stringify({ payload: { grade: { marks: 9 } } }), T] },
    ], 'write');

    const { checked, found } = await findOverwrittenAiMarks(db);
    expect(checked).toBe(3);
    expect(found).toEqual([
      { questionId: 'q_Q1', current: 6, aiMarks: 4, source: 'regrade_snapshot' },
      { questionId: 'q_Q2', current: 8, aiMarks: 5, source: 'override_event' },
    ]);
    expect(await restoreAiMarks(db, found, { now: T })).toBe(2);
    for (const table of ['submission_questions', 'submission_questions_v2']) {
      const marks = (await db.execute(`SELECT id, ai_marks, approved_marks FROM ${table} WHERE id IN ('q_Q1', 'q_Q2') ORDER BY id`)).rows.map((r) => [r.id, r.ai_marks, r.approved_marks]);
      expect(marks).toEqual([['q_Q1', 4, 6], ['q_Q2', 5, 8]]);
    }
    expect((await findOverwrittenAiMarks(db)).found).toHaveLength(0);
  });
});
