// Logic behind scripts/repairSubmissionScores.mjs and scripts/backfillAiMarks.mjs.
// Takes a libSQL client so tests can run it against the production schema.

import { randomUUID } from 'node:crypto';
import { findScoreMismatches, loadSubmissionScoring, reportTotals, syncReportTotals } from '../../apps/processing-worker/submissionScore.js';
import { syncCanonicalSubmission } from '../../api/_lib/canonicalSubmissions.js';

function parse(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index], index); }
  }));
  return results;
}

/**
 * Submissions whose stored score (test_submissions, submissions or the
 * published report) differs from the live total of their question marks.
 * Only submissions that already have a score or a published report, and whose
 * questions are all graded, are considered; in-progress tests are skipped.
 * Submissions with teacher changes still waiting for a cohort regrade
 * (review_revision > regraded_revision) are counted but left alone: their score
 * is meant to change when the teacher runs the regrade.
 */
export async function findStaleSubmissions(db, { school = null, testId = null, concurrency = 8 } = {}) {
  const filters = [];
  const args = [];
  if (school) { filters.push('t.school = ?'); args.push(school); }
  if (testId) { filters.push('s.test_id = ?'); args.push(testId); }
  const candidates = (await db.execute({
    sql: `SELECT s.id, s.test_id, t.school, t.subject FROM test_submissions s JOIN tests t ON t.id = s.test_id
          WHERE (s.score IS NOT NULL OR EXISTS (SELECT 1 FROM report_versions r WHERE r.submission_id = s.id AND r.status = 'published'))
            AND EXISTS (SELECT 1 FROM submission_questions q WHERE q.submission_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM submission_questions q WHERE q.submission_id = s.id AND q.ai_marks IS NULL AND q.approved_marks IS NULL)
            ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
          ORDER BY t.school, s.test_id, s.id`,
    args,
  })).rows;
  const pending = new Set((await db.execute({
    sql: `SELECT DISTINCT q.submission_id FROM submission_questions q JOIN test_submissions s ON s.id = q.submission_id JOIN tests t ON t.id = s.test_id
          WHERE q.review_revision > q.regraded_revision ${filters.length ? `AND ${filters.join(' AND ')}` : ''}`,
    args,
  })).rows.map((row) => row.submission_id));
  const checked = await mapLimit(candidates.filter((row) => !pending.has(row.id)), concurrency, async (row) => {
    const report = (await db.execute({
      sql: "SELECT id, version, payload_json FROM report_versions WHERE submission_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1",
      args: [row.id],
    })).rows[0] || null;
    const payload = report ? parse(report.payload_json) : null;
    const storedPlan = (payload?.term1?.subjects || payload?.subjects || [])[0]?.scoring_plan || null;
    const live = await loadSubmissionScoring(db, row.id, { fallbackPlan: storedPlan });
    if (!live || !(live.scoring.total > 0)) return null;
    const expected = { score: live.scoring.score, total: live.scoring.total };
    const mismatches = await findScoreMismatches(db, row.id, expected);
    return mismatches.length ? { submissionId: row.id, testId: row.test_id, school: row.school, subject: row.subject, expected, mismatches, live, report } : null;
  });
  const pendingRegrade = candidates.filter((row) => pending.has(row.id)).length;
  return { checked: candidates.length - pendingRegrade, pendingRegrade, stale: checked.filter(Boolean) };
}

/**
 * Re-totals one stale submission: both score tables, and when the published
 * report's total is wrong, a new report version carrying the corrected totals
 * only (no model regeneration, no student notification). Idempotent: a
 * submission that already matches is left alone by findStaleSubmissions.
 */
export async function repairSubmission(db, stale, { now = new Date().toISOString() } = {}) {
  const { submissionId, expected, live, report, subject } = stale;
  const ops = [
    { sql: 'UPDATE test_submissions SET score = ?, max_marks = ?, updated_at = ? WHERE id = ?', args: [expected.score, expected.total, now, submissionId] },
    { sql: 'UPDATE submissions SET score = ?, max_marks = ?, updated_at = ? WHERE id = ?', args: [expected.score, expected.total, now, submissionId] },
    { sql: 'UPDATE cohort_report_cache SET invalidated_at = ? WHERE exam_id = (SELECT exam_id FROM submissions WHERE id = ?) AND invalidated_at IS NULL', args: [now, submissionId] },
  ];
  let reportVersion = null;
  if (report && stale.mismatches.some((m) => m.place === 'report')) {
    const previous = parse(report.payload_json);
    const { report: next, synced } = syncReportTotals(previous, live, subject);
    if (synced) {
      next.workflow = { ...(next.workflow || {}), score_repair: { at: now, previous: reportTotals(previous) } };
      const version = Number((await db.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS version FROM report_versions WHERE submission_id = ?', args: [submissionId] })).rows[0]?.version || 0) + 1;
      reportVersion = version;
      ops.push(
        { sql: "UPDATE report_versions SET status = 'superseded', superseded_at = ? WHERE id = ?", args: [now, report.id] },
        { sql: `INSERT INTO report_versions (id, submission_id, version, status, workflow_run_id, generated_at, published_at, payload_json, username, school, exam_id, student_id)
                SELECT ?, submission_id, ?, 'published', 'score_repair', ?, ?, ?, username, school, exam_id, student_id FROM report_versions WHERE id = ?`,
          args: [`report_${randomUUID()}`, version, now, now, JSON.stringify(next), report.id] },
      );
    }
  }
  await db.batch(ops, 'write');
  // A missing canonical row (lost mirror) is recreated from test_submissions.
  if (stale.mismatches.some((m) => m.place === 'submissions' && m.score == null && m.max_marks == null)) {
    await syncCanonicalSubmission(db, submissionId, now);
  }
  const remaining = await findScoreMismatches(db, submissionId, expected);
  return { submissionId, reportVersion, remaining };
}

/**
 * Regraded questions whose ai_marks was overwritten with the teacher's mark
 * (the cohort regrade did this before it was fixed), with the AI mark
 * recovered from the earliest regrade snapshot, else from the first
 * marks_overridden event. Questions whose recovered mark equals the current
 * one (an answer-text-only edit) are skipped.
 */
export async function findOverwrittenAiMarks(db, { school = null, page = 500 } = {}) {
  // Only the mark fields are read (json_extract): snapshots carry the whole
  // question payload and would exceed the response limit in bulk.
  const firstSnapshot = (path) => `(SELECT json_extract(r.snapshot_json, '${path}') FROM submission_questions_v2 x
      JOIN submission_question_revisions r ON r.submission_question_id = x.id WHERE x.id = q.id ORDER BY r.revision ASC, r.created_at ASC LIMIT 1)`;
  const rows = [];
  let after = '';
  for (;;) {
    const batch = (await db.execute({
      sql: `SELECT q.id, q.ai_marks, q.approved_marks,
                   ${firstSnapshot('$.payload.grade.marks')} AS snapshot_marks,
                   ${firstSnapshot('$.payload.question.marks_obtained')} AS snapshot_question_marks,
                   (SELECT json_extract(e.before_json, '$.marks') FROM question_review_events e
                    WHERE e.submission_question_id = q.id AND e.event_type = 'marks_overridden' ORDER BY e.created_at ASC LIMIT 1) AS override_marks
            FROM submission_questions_v2 q
            ${school ? 'JOIN submissions s ON s.id = q.submission_id JOIN exams e ON e.id = s.exam_id JOIN schools sc ON sc.id = e.school_id' : ''}
            WHERE q.status = 'regraded' AND q.ai_marks IS NOT NULL AND q.ai_marks = q.approved_marks AND q.id > ?
            ${school ? 'AND sc.display_name = ?' : ''}
            ORDER BY q.id LIMIT ${Number(page)}`,
      args: school ? [after, school] : [after],
    })).rows;
    rows.push(...batch);
    if (batch.length < page) break;
    after = batch[batch.length - 1].id;
  }
  const found = [];
  let unrecoverable = 0;
  for (const row of rows) {
    const fromSnapshot = row.snapshot_marks ?? row.snapshot_question_marks;
    const fromEvent = row.override_marks;
    const candidate = [fromSnapshot, fromEvent].find((value) => value != null && Number.isFinite(Number(value)));
    if (candidate == null) { unrecoverable += 1; continue; }
    const aiMarks = Number(candidate);
    if (aiMarks === Number(row.ai_marks)) continue;
    found.push({ questionId: row.id, current: Number(row.ai_marks), aiMarks, source: candidate === fromSnapshot ? 'regrade_snapshot' : 'override_event' });
  }
  return { checked: rows.length, found, unrecoverable };
}

/** Restores ai_marks on both question tables; only touches rows still overwritten. */
export async function restoreAiMarks(db, found, { now = new Date().toISOString(), chunk = 100 } = {}) {
  let restored = 0;
  for (let start = 0; start < found.length; start += chunk) {
    const ops = found.slice(start, start + chunk).flatMap((item) => [
      { sql: 'UPDATE submission_questions_v2 SET ai_marks = ?, updated_at = ? WHERE id = ? AND ai_marks = approved_marks', args: [item.aiMarks, now, item.questionId] },
      { sql: 'UPDATE submission_questions SET ai_marks = ?, updated_at = ? WHERE id = ? AND ai_marks = approved_marks', args: [item.aiMarks, now, item.questionId] },
    ]);
    const results = await db.batch(ops, 'write');
    restored += results.filter((result, index) => index % 2 === 0 && result.rowsAffected > 0).length;
  }
  return restored;
}
