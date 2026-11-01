import { createClient } from '@libsql/client/web';
import { randomUUID } from 'node:crypto';
import { ensureAuthTables, requireUser } from './_lib/auth.js';
import { inActorSchool } from './_lib/schoolScope.js';
import { internalError } from './_lib/httpError.js';
import { tursoAuthToken, tursoUrl } from './_lib/env.js';
import { applyFeedbackToQuestion, buildQuestionSnapshot, COHORT_REGRADE_WORKFLOW_VERSION, generateQuestionFeedback, parseJson, publishSubmissionReport, refreshTeacherReportModules, retotalSubmissionScore } from './_lib/cohortRegrade.js';
import { editAnswerEvidence } from './_lib/reviewerEditService.js';
import { loadAnswerLocations } from './_lib/answerLocationService.js';
import { claimRegradeItemStatement, expireStaleRegradeItemsStatements, regradeItemLeaseMs, regradeItemMaxAttempts } from './_lib/regradeItemLease.js';
import {
  approveRubricAndMarkForGrading,
  listRubricReviewQueue,
  loadRubricReviewPackage,
  saveRubricReviewEdits,
} from './_lib/rubricReviewService.js';
import { resolveSchoolId } from './_lib/canonicalSubmissions.js';
import { handleCors } from './_lib/cors.js';
import { indexIntakeAnswerSheetAssets } from './_lib/answerSheetAssets.js';
import { chunk, pushOutboxStatement, PUSH_EVENT_TYPES } from './_lib/pushOutbox.js';
import { withHarshZeroTag, resolveGradingLanguage } from '../shared/harshZero.js';
import { compareQuestionNumbers } from '../shared/questionNumberSort.js';
import { parseMcqMarkScheme } from '../apps/processing-worker/gradeResult.js';

// Regrades are durable OCI work. The browser creates a run and polls its
// progress; it never owns a model call or determines completion.
export const maxDuration = 60;

// Revision history is read in chunks of question IDs. A large cohort spans
// ~100 chunks, so run a few at a time rather than one round trip after another.
const REVISION_LOOKUP_BATCH_SIZE = 75;
const REVISION_LOOKUP_CONCURRENCY = 6;
// Upper bound on statements per libSQL write batch for bulk approvals.
const FINALIZE_BATCH_STATEMENTS = 200;

// Errors the review services throw on purpose (denied, not found, conflict)
// carry their HTTP status; anything else stays a generic 500 (FLKRM-386).
function httpError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''));
}

function errorResponse(res, err) {
  const status = Number(err?.statusCode || err?.status);
  if (status >= 400 && status < 500) return res.status(status).json({ error: err.message });
  return internalError(res, err, 'vl-queue');
}

const client = tursoUrl ? createClient({ url: tursoUrl, authToken: tursoAuthToken }) : null;

function parseKeyCheck(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

export function asReviewItem(row, stored, testById, canonicalTestIds, pageCountByStudent, assetKindsByTest, reportQuestions, revisionHistory) {
  // Legacy queue rows stored the complete review item. Intake rows store the
  // published question underneath `question` and keep its identity in columns.
  // Normalize both formats here so the reviewer never has to know the storage
  // version that created a cohort.
  const question = stored.question || stored;
  const testId = stored.test_id || stored.testId || row.test_id || question.test_id || question.testId;
  const inferredGrade = String(row.student_id || '').match(/^(\d+th)_/)?.[1] || '';
  const rawTest = testById.get(testId);
  // Keep this exported mapper backward-compatible with the lightweight maps
  // used by API tests and older callers while enriching real tests with title
  // and normalized subject metadata.
  const test = rawTest && typeof rawTest === 'object' ? rawTest : { grade: rawTest };
  const gradeLevel = stored.gradeLevel || question.gradeLevel || test?.grade || row.exam_grade || inferredGrade;
  const reportQuestion = reportQuestions.get(`${row.student_id}:${row.subject}:${row.question_number}`);
  const studentAnswer = stored.studentAnswer || {
    attempted: question.status !== 'not_attempted',
    studentWrote: question.student_answer || reportQuestion?.student_answer || '',
    optionLetter: question.option_letter || '',
    finalAnswer: question.final_answer || '',
    confidence: question.answer_confidence || 'medium',
  };
  const grade = stored.grade || {
    marks: question.marks_obtained ?? 0,
    allocated: question.marks_total ?? 0,
    status: question.status || 'incorrect',
    confidence: question.grading_confidence || 'medium',
  };

  const item = {
    ...stored,
    id: stored.id || row.id,
    school: row.school || stored.school,
    // Tests own their display metadata. Question payloads are historical
    // evidence and may contain an old shorthand such as "Bio" or "Maths".
    subject: test?.subject || stored.subject || row.subject,
    testId,
    examName: test?.title || stored.examName || '',
    // Backfilled reports used one synthetic test ID per student. Expose whether
    // this ID represents a real assessment so the client can group legacy rows
    // by their shared school/subject/grade rather than rendering duplicate cards.
    isCanonicalTest: canonicalTestIds.has(testId),
    studentId: stored.studentId || row.student_id,
    // A roster student can sit multiple tests. Assets are attached to the
    // test-specific record, so never use the roster ID to request pages.
    testStudentId: stored.testStudentId || row.test_student_id || row.student_id,
    studentName: stored.studentName || row.student_name,
    studentUsername: stored.studentUsername || row.student_username || '',
    // Submission totals are the canonical score after optional-question rules
    // have been applied. Do not reconstruct a paper total by summing the raw
    // question pool in the review UI.
    submissionScore: row.submission_score == null ? null : Number(row.submission_score),
    submissionMaxMarks: row.submission_max_marks == null ? null : Number(row.submission_max_marks),
    questionNumber: stored.questionNumber || row.question_number || question.number,
    gradeLevel,
    pageCount: stored.pageCount || pageCountByStudent.get(`${testId}:${row.test_student_id || row.student_id}`) || 0,
    hasQuestionPaper: assetKindsByTest.get(testId)?.has('question_paper') || false,
    hasAnswerKey: assetKindsByTest.get(testId)?.has('answer_key') || false,
    questionText: stored.questionText || question.question_text || question.summary || '',
    correctAnswer: stored.correctAnswer || question.correct_answer || reportQuestion?.correct_answer || '',
    markingRubric: stored.markingRubric || question.marking_rubric || '',
    marksAllocated: stored.marksAllocated ?? grade.allocated,
    marksMin: (() => {
      if (stored.marksMin != null && Number.isFinite(Number(stored.marksMin))) return Number(stored.marksMin);
      const rubricText = stored.markingRubric || question.marking_rubric || '';
      const responseType = String(stored.expectedResponseType || question.expected_response_type || '').toLowerCase();
      const allocated = Number(stored.marksAllocated ?? grade.allocated ?? 0);
      if (responseType !== 'mcq' && !/negative\s*marks?/i.test(rubricText)) return 0;
      return parseMcqMarkScheme(rubricText, allocated)?.incorrect ?? 0;
    })(),
    studentAnswer,
    grade,
    gradeRationale: stored.gradeRationale || {
      whatWentCorrect: question.what_went_correct || '',
      missingOrWrong: question.missing_or_wrong || '',
      reasoning: question.grading_reason || question.diagnosis || '',
    },
    isFlagged: stored.isFlagged ?? Boolean(question.review_required || row.review_status === 'flagged'),
    reviewPriority: stored.reviewPriority || (question.review_required || row.review_status === 'flagged' ? 'flagged' : 'normal'),
    reviewTags: stored.reviewTags || (question.review_required || row.review_status === 'flagged' ? ['flagged'] : []),
    expectedResponseType: stored.expectedResponseType || question.expected_response_type || '',
    revisionHistory: revisionHistory.get(row.id) || [],
    // Review flags beyond reviewTags: the better-matching question this answer
    // was credited under, and the rubric's independent key-check finding.
    duplicateOf: row.duplicate_of || null,
    keyCheck: parseKeyCheck(row.key_check_json),
  };
  // Backfill harsh_zero from live rationale so already-graded cohorts surface
  // without a regrade. Does not change marks.
  return withHarshZeroTag(item);
}

export async function loadCohortRun(db, id) {
  const result = await db.execute({ sql: 'SELECT * FROM regrade_runs WHERE id = ?', args: [id] });
  return result.rows[0] || null;
}

// regrade_items.output_json is written by this module, but one malformed row
// must not make a whole progress query throw; read it as a missing field.
const outputJson = (fn, path) => `CASE WHEN json_valid(output_json) THEN ${fn}(output_json, '${path}') END`;

export async function cohortRunView(db, run) {
  const scope = parseJson(run.scope, {});
  // The reviewer polls this every ~1.2s and the worker rebuilds it after every
  // item. Count in SQL; only failed rows are loaded, for display.
  const counts = await db.execute({
    sql: `SELECT state, COUNT(*) AS count,
                 SUM(CASE WHEN state = 'completed' AND ${outputJson('json_type', '$.reportModules.refreshed')} = 'false' THEN 1 ELSE 0 END) AS module_warnings
          FROM regrade_items WHERE run_id = ? GROUP BY state`,
    args: [run.id],
  });
  const progress = { queued: 0, processing: 0, completed: 0, failed: 0 };
  let moduleWarnings = 0;
  for (const row of counts.rows) {
    progress[row.state] = Number(row.count || 0);
    moduleWarnings += Number(row.module_warnings || 0);
  }
  const failed = progress.failed
    ? await db.execute({ sql: `SELECT i.submission_question_id, i.error, q.question_number, s.student_id, st.display_name AS student_name
                               FROM regrade_items i
                               LEFT JOIN submission_questions_v2 q ON q.id = i.submission_question_id
                               LEFT JOIN submissions s ON s.id = i.submission_id
                               LEFT JOIN students st ON st.id = s.student_id
                               WHERE i.run_id = ? AND i.state = 'failed' ORDER BY i.rowid`, args: [run.id] })
    : { rows: [] };
  return { id: run.id, status: run.status, school: scope.school || run.school || '', subject: scope.subject || run.subject || '', grade: scope.grade || run.grade || '', testId: scope.test_id || run.test_id || null, questionCount: run.question_count, studentCount: run.student_count,
    requestedAt: run.requested_at || null, startedAt: run.started_at || null, completedAt: run.completed_at || null,
    workflowVersion: run.workflow_version || null, progress,
    moduleWarnings,
    outputManifest: parseJson(run.output_manifest_json, null),
    failedItems: failed.rows.map((item) => ({
      questionId: item.submission_question_id,
      questionNumber: item.question_number || '',
      studentId: item.student_id || '',
      studentName: item.student_name || item.student_id || '',
      error: item.error,
    })) };
}

export async function retryFailedCohortRegrade(db, actor, runId) {
  const run = await loadCohortRun(db, runId);
  if (!run) throw httpError(404, 'Cohort regrade run not found');
  const scope = parseJson(run.scope, {});
  const runSchool = scope.school || run.school || '';
  if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: runSchool }))) throw httpError(403, 'School access denied');
  if (!['partial', 'failed'].includes(run.status)) throw new Error('Only a partial or failed regrade can be resumed');
  const failed = await db.execute({ sql: "SELECT id FROM regrade_items WHERE run_id = ? AND state = 'failed'", args: [runId] });
  if (!failed.rows.length) throw new Error('No failed questions are waiting to be retried');
  const now = new Date().toISOString();
  try {
    await db.batch([
      // A manual retry is a fresh budget: reset the lease attempt counter too.
      { sql: "UPDATE regrade_items SET state = 'queued', error = NULL, started_at = NULL, completed_at = NULL, attempt_count = 0 WHERE run_id = ? AND state = 'failed'", args: [runId] },
      { sql: "UPDATE regrade_runs SET status = 'queued', error = NULL, completed_at = NULL, requested_by = ?, requested_at = ? WHERE id = ?", args: [actor.username, now, runId] },
    ], 'write');
  } catch (error) {
    // Migration 088 allows one active run per test; a newer run already owns it.
    if (isUniqueViolation(error)) throw httpError(409, 'A cohort regrade is already active for this test');
    throw error;
  }
  return cohortRunView(db, { ...run, status: 'queued', requested_at: now, completed_at: null });
}

async function publishReadySubmission(db, runId, submissionId) {
  const items = await db.execute({
    sql: `SELECT i.id AS item_id, i.submission_id, i.submission_question_id, i.revision, i.state, i.input_snapshot_json, i.output_json,
                 q.question_number, q.subject
          FROM regrade_items i JOIN submission_questions q ON q.id = i.submission_question_id
          WHERE i.run_id = ? AND i.submission_id = ?`, args: [runId, submissionId],
  });
  if (!items.rows.length || items.rows.some((item) => item.state !== 'completed')) return null;
  if (items.rows.every((item) => parseJson(item.output_json, {}).reportVersionId)) return parseJson(items.rows[0].output_json, {}).reportVersionId;
  const updates = items.rows.map((item) => ({ question: item, snapshot: parseJson(item.input_snapshot_json), feedback: parseJson(item.output_json, {}).feedback }));
  const report = await publishSubmissionReport(db, submissionId, updates, runId);
  if (!report) {
    // No published report (held by a guardrail): nothing to patch, but the
    // stored score must still follow the regraded marks.
    await retotalSubmissionScore(db, submissionId).catch((error) => {
      console.warn(JSON.stringify({ event: 'held_score_retotal_failed', submissionId, error: String(error?.message || error) }));
    });
    return null;
  }
  const publishedAt = new Date().toISOString();
  await db.batch(items.rows.map((item) => {
    const output = parseJson(item.output_json, {});
    return { sql: 'UPDATE regrade_items SET output_json = ? WHERE id = ?', args: [JSON.stringify({ ...output, reportVersionId: report.reportId, reportVersion: report.version, reportModules: report.modules, publishedAt }), item.item_id] };
  }), 'write');
  return report.reportId;
}

export async function finishRunIfReady(db, run, options = {}) {
  if (['failed', 'partial'].includes(run.status)) return run;
  // Called after every item; aggregate in SQL rather than loading each item's
  // output_json. A completed item is published once it records its report.
  const totals = (await db.execute({
    sql: `SELECT COUNT(*) AS total,
                 SUM(CASE WHEN state IN ('queued', 'processing') THEN 1 ELSE 0 END) AS active,
                 SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed,
                 SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
                 SUM(CASE WHEN state != 'completed' OR COALESCE(${outputJson('json_extract', '$.reportVersionId')}, '') = '' THEN 1 ELSE 0 END) AS unpublished
          FROM regrade_items WHERE run_id = ?`,
    args: [run.id],
  })).rows[0] || {};
  if (Number(totals.active || 0) > 0) return run;
  const publicationIncomplete = Number(totals.unpublished || 0) > 0;
  const now = options.now?.() || new Date().toISOString();
  const uuid = options.uuid || randomUUID;
  let teacherModules = null;
  let projectionFailed = false;
  if (!publicationIncomplete) {
    try {
      const refresh = options.refreshTeacherModules || refreshTeacherReportModules;
      teacherModules = { ...(await refresh(db, run)), refreshed: true };
    } catch (error) {
      projectionFailed = true;
      teacherModules = { refreshed: false, error: error.message };
    }
  }
  const status = publicationIncomplete || projectionFailed ? 'partial' : 'published';
  if (status === 'published') {
    if (Number(totals.total || 0) > 0) {
      const waiting = await db.execute({
        sql: `SELECT id, status, submission_id FROM recheck_requests
              WHERE status = 'awaiting_regrade'
                AND submission_question_id IN (SELECT submission_question_id FROM regrade_items WHERE run_id = ?)`,
        args: [run.id],
      });
      if (waiting.rows.length) {
        const resolutionNote = 'Your reviewed correction has been applied. The updated report is now available.';
        // Resolve each recheck's student login + school so the resolution can be
        // pushed to their device; report_versions carries both for the submission.
        const submissionIds = [...new Set(waiting.rows.map((request) => request.submission_id).filter(Boolean))];
        const targets = submissionIds.length
          ? (await db.execute({ sql: `SELECT submission_id, username, school FROM report_versions WHERE status = 'published' AND submission_id IN (${submissionIds.map(() => '?').join(', ')})`, args: submissionIds })).rows
          : [];
        const targetBySubmission = new Map(targets.map((row) => [row.submission_id, row]));
        await db.batch(waiting.rows.flatMap((request) => {
          const ops = [
            { sql: "UPDATE recheck_requests SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ? AND status = 'awaiting_regrade'", args: ['skyll_processing_worker', now, resolutionNote, request.id] },
            { sql: `INSERT INTO recheck_events (id, recheck_request_id, actor_user_id, event_type, before_json, after_json, note, created_at)
                  SELECT ?, ?, 'skyll_processing_worker', 'resolved_after_regrade', ?, ?, ?, ?
                  WHERE changes() = 1`,
              args: [`recheck_event_${uuid()}`, request.id, JSON.stringify({ status: request.status }), JSON.stringify({ status: 'resolved' }), resolutionNote, now] },
          ];
          const target = targetBySubmission.get(request.submission_id);
          if (target?.username && target?.school) {
            ops.push(pushOutboxStatement({ school: target.school, username: target.username, eventType: PUSH_EVENT_TYPES.RECHECK_RESOLVED, title: 'Your recheck was resolved', body: resolutionNote, data: { screen: 'student', tab: 'recheck', submissionId: request.submission_id }, createdAt: now }));
          }
          return ops;
        }), 'write');
      }
    }
  }
  const manifest = JSON.stringify({ completed: Number(totals.completed || 0), failed: Number(totals.failed || 0), teacherModules });
  await db.execute({ sql: 'UPDATE regrade_runs SET status = ?, completed_at = ?, output_manifest_json = ? WHERE id = ?', args: [status, now, manifest, run.id] });
  return { ...run, status, completed_at: now, output_manifest_json: manifest };
}

// Matches the expression and predicate of regrade_runs_one_active_test_idx
// (migration 088) so the lookup is indexed instead of a LIKE scan of scope.
async function activeCohortRun(db, testId) {
  const active = await db.execute({
    sql: `SELECT id FROM regrade_runs WHERE json_extract(scope, '$.test_id') = ? AND status IN ('queued', 'running') LIMIT 1`,
    args: [testId],
  });
  return active.rows[0] || null;
}

export async function createCohortRegrade(db, actor, { school, subject, grade, testId, language }) {
  if (!school || !subject || !grade || !testId) throw new Error('school, subject, grade, and testId are required');
  if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: school }))) throw httpError(403, 'School access denied');
  const active = await activeCohortRun(db, testId);
  if (active) return { conflict: true, runId: active.id };
  const changed = await db.execute({
    sql: `SELECT q.id, q.submission_id, q.question_number, q.ai_marks, q.approved_marks,
                 q.review_revision, q.regraded_revision, q.render_json AS payload_json, q.status,
                 esq.max_marks AS marks_total, esq.question_text, esq.answer_key_text, esq.rubric_json,
                 sc.display_name AS school, COALESCE(sub.name, ?) AS subject,
                 COALESCE(st.display_name, s.student_id) AS student_name,
                 s.student_id, d.approved_marks AS decision_marks
          FROM submission_questions_v2 q
          JOIN submissions s ON s.id = q.submission_id
          JOIN exams e ON e.id = s.exam_id
          JOIN schools sc ON sc.id = e.school_id
          LEFT JOIN subjects sub ON sub.id = e.subject_id
          LEFT JOIN students st ON st.id = s.student_id
          LEFT JOIN exam_set_questions esq ON esq.id = q.exam_set_question_id
          LEFT JOIN question_reviews d ON d.submission_question_id = q.id
          WHERE sc.display_name = ? AND e.source_test_id = ?
            AND q.review_revision > q.regraded_revision
          ORDER BY q.submission_id, q.question_number`,
    args: [subject, school, testId],
  });
  if (!changed.rows.length) throw new Error('No reviewed OCR or mark changes are waiting to be regraded');
  const runId = `cohort_regrade_${randomUUID()}`;
  const now = new Date().toISOString();
  const students = new Set(changed.rows.map((row) => row.student_id));
  const examRow = (await db.execute({ sql: 'SELECT id FROM exams WHERE source_test_id = ? LIMIT 1', args: [testId] })).rows[0];
  const schoolId = await resolveSchoolId(db, school).catch(() => null);
  const resolvedLanguage = resolveGradingLanguage({ subject, explicit: language }) || language || null;
  const scope = JSON.stringify({ school, subject, grade, test_id: testId, language: resolvedLanguage });
  const ops = [{ sql: `INSERT INTO regrade_runs (id, exam_id, school_id, scope, status, requested_by, requested_at, question_count, student_count, workflow_version, input_manifest_json)
                      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    args: [runId, examRow?.id || null, schoolId, scope, actor.username, now, changed.rows.length, students.size, COHORT_REGRADE_WORKFLOW_VERSION, JSON.stringify(changed.rows.map((row) => ({ questionId: row.id, submissionId: row.submission_id, revision: row.review_revision })))] }];
  for (const row of changed.rows) {
    const snapshot = buildQuestionSnapshot(row, row.decision_marks == null ? null : { approved_marks: row.decision_marks });
    ops.push({ sql: `INSERT INTO regrade_items (id, run_id, submission_id, submission_question_id, revision, state, input_snapshot_json)
                     VALUES (?, ?, ?, ?, ?, 'queued', ?)`, args: [`cohort_regrade_item_${randomUUID()}`, runId, row.submission_id, row.id, Number(row.review_revision), JSON.stringify(snapshot)] });
    ops.push({ sql: `INSERT INTO submission_question_revisions (id, submission_question_id, revision, source, actor_user_id, cohort_regrade_run_id, snapshot_json, created_at)
                     VALUES (?, ?, ?, 'cohort_regrade_snapshot', ?, ?, ?, ?) ON CONFLICT(submission_question_id, revision) DO NOTHING`, args: [`question_revision_${randomUUID()}`, row.id, Number(row.review_revision), actor.username, runId, JSON.stringify(snapshot), now] });
  }
  try {
    await db.batch(ops, 'write');
  } catch (error) {
    // A double click can pass the check above twice. Migration 088's unique
    // index lets one run in; the other reports it as the active run.
    const winner = isUniqueViolation(error) ? await activeCohortRun(db, testId) : null;
    if (winner) return { conflict: true, runId: winner.id };
    throw error;
  }
  return { runId, questionCount: changed.rows.length, studentCount: students.size };
}

// The confirmation dialog needs to show exactly what "Regrade changes" would
// queue. Mirror createCohortRegrade's selection (same table, same revision
// predicate) but never insert: a stale card previews as zero questions
// instead of double-queuing already-regraded work.
export async function previewCohortRegrade(db, actor, { school, subject, grade, testId }) {
  if (!school || !subject || !grade || !testId) throw new Error('school, subject, grade, and testId are required');
  if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: school }))) throw httpError(403, 'School access denied');
  const changed = await db.execute({
    sql: `SELECT q.id, COALESCE(st.display_name, s.student_id) AS student_name, s.student_id
          FROM submission_questions_v2 q
          JOIN submissions s ON s.id = q.submission_id
          JOIN exams e ON e.id = s.exam_id
          JOIN schools sc ON sc.id = e.school_id
          LEFT JOIN students st ON st.id = s.student_id
          WHERE sc.display_name = ? AND e.source_test_id = ?
            AND q.review_revision > q.regraded_revision
          ORDER BY s.student_id, q.question_number`,
    args: [school, testId],
  });
  const byStudent = new Map();
  for (const row of changed.rows) {
    const entry = byStudent.get(row.student_id) || { studentId: row.student_id, studentName: row.student_name || row.student_id, questionCount: 0 };
    entry.questionCount += 1;
    byStudent.set(row.student_id, entry);
  }
  return { totalQuestions: changed.rows.length, students: [...byStudent.values()] };
}

export async function processCohortRegradeStep(db, actor, run) {
  if (['published', 'partial'].includes(run.status)) return { done: true, run: await cohortRunView(db, run) };
  const claimedAt = new Date();
  const startedAt = claimedAt.toISOString();
  // An item left 'processing' by a crashed worker or a timed-out API step
  // used to stay there forever, so the run never finished and new runs for
  // the test got 409. Expire stale leases first: requeue while attempts
  // remain, fail with 'lease expired' once they are exhausted.
  await db.batch(expireStaleRegradeItemsStatements({
    runId: run.id,
    now: claimedAt,
    leaseMs: regradeItemLeaseMs(),
    maxAttempts: regradeItemMaxAttempts(),
  }), 'write');
  // Claim exactly one item in SQL. Multiple reviewer tabs can safely drive the
  // same browser-visible run without asking the model to process it twice.
  const claim = await db.execute(claimRegradeItemStatement({ runId: run.id, now: claimedAt }));
  if (!claim.rows.length) { const finished = await finishRunIfReady(db, run); return { done: ['published', 'partial'].includes(finished.status), run: await cohortRunView(db, finished) }; }
  const item = claim.rows[0];
  await db.execute({ sql: "UPDATE regrade_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?", args: [startedAt, run.id] });
  const snapshot = parseJson(item.input_snapshot_json);
  try {
    const runScope = parseJson(run.scope, {});
    const feedback = await generateQuestionFeedback(
      snapshot,
      resolveGradingLanguage({ subject: runScope.subject, studentAnswer: snapshot.studentAnswer, explicit: runScope.language }),
    );
    const questionResult = await db.execute({
      sql: `SELECT id, submission_id FROM submission_questions_v2 WHERE id = ?
            UNION ALL
            SELECT id, submission_id FROM submission_questions WHERE id = ?
            LIMIT 1`,
      args: [item.submission_question_id, item.submission_question_id],
    });
    const question = questionResult.rows[0];
    if (!question) throw new Error('Question disappeared during regrade');
    const now = new Date().toISOString();
    const output = { feedback, model: feedback.model, regradedAt: now };
    const nextPayload = JSON.stringify(applyFeedbackToQuestion(snapshot, feedback, run.id, item.revision));
    await db.batch([
      // Canonical first.
      // ai_marks is left alone: it stays the AI's mark so AI-vs-teacher accuracy
      // can be measured; approved_marks carries the teacher's final mark.
      { sql: `UPDATE submission_questions_v2 SET render_json = ?, approved_marks = ?, regraded_revision = ?, status = 'regraded', updated_at = ? WHERE id = ?`, args: [nextPayload, snapshot.approvedMarks, item.revision, now, question.id] },
      // Legacy dual-write during bake.
      { sql: `UPDATE submission_questions SET payload_json = ?, approved_marks = ?, regraded_revision = ?, status = 'regraded', updated_at = ? WHERE id = ?`, args: [nextPayload, snapshot.approvedMarks, item.revision, now, question.id] },
      { sql: "UPDATE regrade_items SET state = 'completed', output_json = ?, completed_at = ? WHERE id = ?", args: [JSON.stringify(output), now, item.id] },
      { sql: `INSERT INTO question_review_events (id, submission_question_id, actor_user_id, event_type, before_json, after_json, comment, created_at)
              VALUES (?, ?, ?, 'ai_regraded', ?, ?, ?, ?)`, args: [`review_event_${randomUUID()}`, question.id, actor.username, JSON.stringify(snapshot), JSON.stringify(output), `Cohort regrade ${run.id}`, now] },
    ], 'write');
    await publishReadySubmission(db, run.id, item.submission_id);
  } catch (error) {
    await db.execute({ sql: "UPDATE regrade_items SET state = 'failed', error = ?, completed_at = ? WHERE id = ?", args: [error.message, new Date().toISOString(), item.id] });
  }
  const fresh = await loadCohortRun(db, run.id);
  const finished = await finishRunIfReady(db, fresh);
  return { done: ['published', 'partial'].includes(finished.status), run: await cohortRunView(db, finished) };
}

// A review revision is immutable once the regrade is queued. Return a compact
// audit trail so reviewers can compare the current explanation against the two
// immediately preceding published inputs without loading an unbounded event
// log for a large cohort.
export async function loadRevisionHistory(db, questionIds) {
  const revisionHistory = new Map();
  // Each question ID lives in exactly one chunk, so chunks can fill the map in
  // any order without interleaving one question's history.
  const loadChunk = async (batchQuestionIds) => {
    const placeholders = batchQuestionIds.map(() => '?').join(', ');
    try {
      const revisions = await db.execute({
        sql: `SELECT r.submission_question_id, r.revision, r.source, r.cohort_regrade_run_id,
                     r.snapshot_json, r.created_at, i.state, i.output_json
              FROM submission_question_revisions r
              LEFT JOIN regrade_items i
                ON i.submission_question_id = r.submission_question_id
               AND i.revision = r.revision
               AND i.run_id = r.cohort_regrade_run_id
              WHERE r.submission_question_id IN (${placeholders})
              ORDER BY r.submission_question_id, r.revision DESC, r.created_at DESC`,
        args: batchQuestionIds,
      });
      for (const revision of revisions.rows) {
        const history = revisionHistory.get(revision.submission_question_id) || [];
        if (history.length >= 3) continue;
        const snapshot = parseJson(revision.snapshot_json, {});
        const output = parseJson(revision.output_json, {});
        history.push({
          revision: Number(revision.revision || 0),
          source: revision.source || 'reviewed',
          runId: revision.cohort_regrade_run_id || null,
          createdAt: revision.created_at || null,
          state: revision.state || 'queued',
          studentAnswer: snapshot.studentAnswer || '',
          approvedMarks: snapshot.approvedMarks,
          marksTotal: snapshot.marksTotal,
          feedback: output.feedback || null,
        });
        revisionHistory.set(revision.submission_question_id, history);
      }
    } catch (error) {
      // Older canonical rows can predate the revision migration. Their review
      // experience remains available; only the optional history is omitted
      // until the migration has been applied.
      console.warn('Could not load question revision history', error.message);
    }
  };
  const chunks = chunk(questionIds, REVISION_LOOKUP_BATCH_SIZE);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(REVISION_LOOKUP_CONCURRENCY, chunks.length) }, async () => {
    while (next < chunks.length) await loadChunk(chunks[next++]);
  }));
  return revisionHistory;
}

// The landing view needs cohorts, not every question's OCR, grading evidence,
// report lookup, and revision history. Keep this aggregation in SQL so a
// multi-school review queue stays fast under normal load.
export async function loadReviewCohortSummary(db, clauses, args) {
  const summarySql =
    `SELECT sc.display_name AS school, sub.name AS stored_subject, COALESCE(e.source_test_id, e.id) AS test_id,
              t.id AS canonical_test_id, COALESCE(t.title, e.name) AS test_title,
              COALESCE(t.subject, sub.name) AS canonical_subject, COALESCE(t.grade, e.grade) AS canonical_grade,
              COUNT(*) AS total_questions,
              COUNT(DISTINCT s.student_id) AS total_students,
              -- One cohort can span several exam sittings; the newest sitting is
              -- the date the reviewer thinks of as "when this exam happened".
              MAX(e.exam_date) AS exam_date,
              SUM(CASE WHEN d.state IS NULL OR d.state != 'approved' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN COALESCE(d.state, q.status) = 'approved' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN d.state = 'flagged' OR q.status = 'flagged' THEN 1 ELSE 0 END) AS flagged,
              SUM(CASE WHEN q.review_revision > q.regraded_revision THEN 1 ELSE 0 END) AS changed_questions,
              COUNT(DISTINCT CASE WHEN q.review_revision > q.regraded_revision THEN s.student_id END) AS changed_students
       FROM submission_questions_v2 q
       JOIN submissions s ON s.id = q.submission_id
       JOIN exams e ON e.id = s.exam_id
       JOIN schools sc ON sc.id = e.school_id
       LEFT JOIN subjects sub ON sub.id = e.subject_id
       LEFT JOIN tests t ON t.id = e.source_test_id
       LEFT JOIN question_reviews d ON d.submission_question_id = q.id
       WHERE ${clauses.join(' AND ')}
       GROUP BY sc.display_name, sub.name, COALESCE(e.source_test_id, e.id), t.id, t.title, t.subject, COALESCE(t.grade, e.grade), e.name
       ORDER BY MAX(e.exam_date) DESC, sc.display_name, COALESCE(t.grade, e.grade), test_title, sub.name`;
  const summary = await db.execute({ sql: summarySql, args });
  return summary.rows.map((row) => ({
    school: row.school,
    testId: row.test_id,
    isCanonicalTest: Boolean(row.canonical_test_id),
    examName: row.test_title || '',
    subject: row.canonical_subject || row.stored_subject,
    gradeLevel: row.canonical_grade || '',
    // Nullable: exams predating the exam_date column have none. Callers sort
    // these last and exclude them from date-window filters.
    examDate: row.exam_date || '',
    totalQuestions: Number(row.total_questions || 0),
    totalStudents: Number(row.total_students || 0),
    pending: Number(row.pending || 0),
    approved: Number(row.approved || 0),
    flagged: Number(row.flagged || 0),
    changedQuestions: Number(row.changed_questions || 0),
    changedStudents: Number(row.changed_students || 0),
  }));
}

// A cohort is identified by school + canonical test ID (synthetic legacy test
// IDs are per-student for backfills, so the caller always passes a real test).
export function cohortOverrideKey(school, testId) {
  return `${school}\u0000${testId}`;
}

export async function loadCohortCompletionOverrides(db, schools = []) {
  const overrides = new Map();
  if (!schools.length) return overrides;
  const placeholders = schools.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT school, test_id, subject, grade, narrative, marked_in_review, pending_at_override, marked_by, marked_at
          FROM cohort_completion_overrides
          WHERE released_at IS NULL AND school IN (${placeholders})`,
    args: schools,
  });
  for (const row of result.rows) {
    overrides.set(cohortOverrideKey(row.school, row.test_id), {
      markedBy: row.marked_by,
      markedAt: row.marked_at,
      narrative: row.narrative || '',
      subject: row.subject || '',
      grade: row.grade || '',
      markedInReview: Number(row.marked_in_review || 0) === 1,
      pendingAtOverride: Number(row.pending_at_override || 0),
    });
  }
  return overrides;
}

// Count the work that is being overridden. Recorded with the marker so the
// confirmation the reviewer saw is preserved as evidence.
export async function countCohortPending(db, school, testId) {
  const result = await db.execute({
    sql: `SELECT SUM(CASE WHEN d.state IS NULL OR d.state != 'approved' THEN 1 ELSE 0 END) AS pending,
                 SUM(CASE WHEN q.review_revision > q.regraded_revision THEN 1 ELSE 0 END) AS changed
          FROM submission_questions_v2 q
          JOIN submissions s ON s.id = q.submission_id
          JOIN exams e ON e.id = s.exam_id
          JOIN schools sc ON sc.id = e.school_id
          LEFT JOIN question_reviews d ON d.submission_question_id = q.id
          WHERE sc.display_name = ? AND e.source_test_id = ?`,
    args: [school, testId],
  });
  const row = result.rows[0] || {};
  return { pending: Number(row.pending || 0), changedQuestions: Number(row.changed || 0) };
}

export async function markCohortComplete(db, actor, { school, testId, subject, grade, narrative, pending }) {
  if (!school || !testId) throw new Error('school and testId are required');
  if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: school }))) throw httpError(403, 'School access denied');
  const active = await db.execute({
    sql: 'SELECT id FROM cohort_completion_overrides WHERE released_at IS NULL AND school = ? AND test_id = ?',
    args: [school, testId],
  });
  if (active.rows.length) throw new Error('This cohort is already marked as done');
  const now = new Date().toISOString();
  const id = `cohort_completion_${randomUUID()}`;
  await db.execute({
    sql: `INSERT INTO cohort_completion_overrides
            (id, school, test_id, subject, grade, narrative, marked_in_review, pending_at_override, marked_by, marked_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    args: [id, school, testId, subject || null, grade || null, narrative || null, Number(pending || 0), actor.username, now],
  });
  return { id, school, testId, markedBy: actor.username, markedAt: now, pendingAtOverride: Number(pending || 0) };
}

export async function unmarkCohortComplete(db, actor, { school, testId }) {
  if (!school || !testId) throw new Error('school and testId are required');
  if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: school }))) throw httpError(403, 'School access denied');
  const active = await db.execute({
    sql: "SELECT id FROM cohort_completion_overrides WHERE released_at IS NULL AND school = ? AND test_id = ? LIMIT 1",
    args: [school, testId],
  });
  if (!active.rows.length) throw new Error('This cohort is not marked as done');
  const now = new Date().toISOString();
  // Retire rather than delete: the audit trail of the override survives the undo.
  await db.execute({
    sql: 'UPDATE cohort_completion_overrides SET released_by = ?, released_at = ? WHERE released_at IS NULL AND school = ? AND test_id = ?',
    args: [actor.username, now, school, testId],
  });
  return { ok: true, school, testId, releasedBy: actor.username, releasedAt: now };
}

/** Release state per canonical test: testId -> { releasedAt, releasedBy } for released tests. */
export async function loadTestReleases(db, testIds = []) {
  const releases = new Map();
  const ids = [...new Set(testIds.filter(Boolean))];
  if (!ids.length) return releases;
  const result = await db.execute({
    sql: `SELECT source_test_id, released_at, released_by FROM exams
          WHERE source_test_id IN (${ids.map(() => '?').join(', ')}) AND released_at IS NOT NULL`,
    args: ids,
  });
  for (const row of result.rows) releases.set(row.source_test_id, { releasedAt: row.released_at, releasedBy: row.released_by });
  return releases;
}

/**
 * "Release to students": students and parents see a test's reports only after
 * a teacher releases it. Sets exams.released_at once (no undo) and sends the
 * "Your report is ready" push for every report already published; the parent
 * WhatsApp planner picks the release up on its next pass. Reports built later
 * for a released test reach students straight away.
 */
export async function releaseTestToStudents(db, actor, { school, testId }, { now = () => new Date().toISOString() } = {}) {
  if (!school || !testId) throw httpError(400, 'school and testId are required');
  if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: school }))) throw httpError(403, 'School access denied');
  const exam = (await db.execute({
    sql: `SELECT e.id, e.released_at, e.released_by, t.title, t.subject
          FROM exams e JOIN schools sc ON sc.id = e.school_id
          LEFT JOIN tests t ON t.id = e.source_test_id
          WHERE e.source_test_id = ? AND sc.display_name = ? LIMIT 1`,
    args: [testId, school],
  })).rows[0];
  if (!exam) throw httpError(404, 'No graded results exist for this test yet');
  if (exam.released_at) return { alreadyReleased: true, testId, releasedAt: exam.released_at, releasedBy: exam.released_by, notified: 0 };
  const releasedAt = now();
  const reports = (await db.execute({
    sql: `SELECT rv.username, rv.submission_id, s.score, s.max_marks
          FROM report_versions rv LEFT JOIN submissions s ON s.id = rv.submission_id
          WHERE rv.exam_id = ? AND rv.status = 'published' AND rv.username IS NOT NULL`,
    args: [exam.id],
  })).rows;
  const title = exam.title || 'Your test';
  const pushes = reports.map((report) => pushOutboxStatement({
    school,
    username: report.username,
    eventType: PUSH_EVENT_TYPES.REPORT_PUBLISHED,
    title: 'Your report is ready',
    body: report.score == null
      ? `${title}: your report is ready. Tap to open it.`
      : `${title}: you scored ${report.score} out of ${report.max_marks} in ${exam.subject || 'this test'}. Tap to open your report.`,
    data: { screen: 'student', submissionId: report.submission_id, subject: exam.subject || null, testId },
    createdAt: releasedAt,
  }));
  // The released_at IS NULL guard makes a double click release (and notify) once.
  const [update] = await db.batch([
    { sql: 'UPDATE exams SET released_at = ?, released_by = ?, updated_at = ? WHERE id = ? AND released_at IS NULL', args: [releasedAt, actor.username, releasedAt, exam.id] },
  ], 'write');
  if (!update.rowsAffected) {
    const current = (await db.execute({ sql: 'SELECT released_at, released_by FROM exams WHERE id = ?', args: [exam.id] })).rows[0] || {};
    return { alreadyReleased: true, testId, releasedAt: current.released_at, releasedBy: current.released_by, notified: 0 };
  }
  for (const batch of chunk(pushes, 50)) await db.batch(batch, 'write');
  return { ok: true, testId, releasedAt, releasedBy: actor.username, notified: pushes.length };
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (!client) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (req.method === 'POST') {
    try {
      await ensureAuthTables();
      const actor = await requireUser(req, res, ['teacher', 'admin', 'skyll_admin']);
      if (!actor) return;
      const db = client;
      const action = req.body?.action;
      
      const SUPPORTED_ACTIONS = new Set([
        'start-cohort-regrade', 'preview-cohort-regrade', 'get-cohort-regrade',
        'retry-cohort-regrade', 'finalize-cohort', 'edit-answer', 'approve-cohort',
        'mark-cohort-complete', 'unmark-cohort-complete', 'release-to-students',
        'list-rubric-reviews', 'get-rubric-review', 'save-rubric-review', 'approve-rubric',
        'answer-locations',
      ]);
      if (!SUPPORTED_ACTIONS.has(action)) {
        return res.status(400).json({
          error: 'Unsupported action',
          supportedActions: [...SUPPORTED_ACTIONS],
        });
      }

      if (action === 'answer-locations') {
        return res.status(200).json(await loadAnswerLocations(db, actor, {
          testId: String(req.body?.testId || '').trim(),
          testStudentId: String(req.body?.testStudentId || '').trim(),
        }));
      }
      if (action === 'list-rubric-reviews') {
        if (!['admin', 'skyll_admin'].includes(actor.role)) return res.status(403).json({ error: 'Admin access required' });
        return res.status(200).json({ items: await listRubricReviewQueue(db, actor) });
      }
      if (action === 'get-rubric-review') {
        if (!['admin', 'skyll_admin'].includes(actor.role)) return res.status(403).json({ error: 'Admin access required' });
        if (!req.body?.testId) return res.status(400).json({ error: 'testId is required' });
        return res.status(200).json(await loadRubricReviewPackage(db, actor, req.body.testId));
      }
      if (action === 'save-rubric-review') {
        if (!['admin', 'skyll_admin'].includes(actor.role)) return res.status(403).json({ error: 'Admin access required' });
        if (!req.body?.testId) return res.status(400).json({ error: 'testId is required' });
        return res.status(200).json(await saveRubricReviewEdits(db, actor, req.body));
      }
      if (action === 'approve-rubric') {
        if (!['admin', 'skyll_admin'].includes(actor.role)) return res.status(403).json({ error: 'Admin access required' });
        if (!req.body?.testId) return res.status(400).json({ error: 'testId is required' });
        const result = await approveRubricAndMarkForGrading(db, actor, req.body);
        return res.status(result.reused ? 200 : 201).json(result);
      }

      if (action === 'start-cohort-regrade') {
        const created = await createCohortRegrade(db, actor, req.body);
        if (created.conflict) return res.status(409).json({ error: 'A cohort regrade is already active', runId: created.runId });
        return res.status(201).json({ ok: true, status: 'queued', ...created });
      }
      if (action === 'preview-cohort-regrade') {
        return res.status(200).json(await previewCohortRegrade(db, actor, req.body));
      }
      if (action === 'step-cohort-regrade') return res.status(409).json({ error: 'Cohort regrades are processed by the OCI worker. Poll the run status instead.' });
      if (action === 'get-cohort-regrade') {
        const run = await loadCohortRun(db, req.body?.runId);
        if (!run) return res.status(404).json({ error: 'Cohort regrade run not found' });
        const scope = parseJson(run.scope, {});
        const runSchool = scope.school || run.school || '';
        if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: runSchool }))) return res.status(403).json({ error: 'School access denied' });
        return res.status(200).json(await cohortRunView(db, run));
      }
      if (action === 'retry-cohort-regrade') {
        if (!req.body?.runId) return res.status(400).json({ error: 'runId is required' });
        return res.status(202).json({ ok: true, ...(await retryFailedCohortRegrade(db, actor, req.body.runId)) });
      }
      if (action === 'finalize-cohort') {
        const { school, subject, grade, testId } = req.body || {};
        if (!school || !testId) return res.status(400).json({ error: 'school and testId required' });
        if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: school }))) return res.status(403).json({ error: 'School access denied' });
        // One assessment, not every test sharing its school/subject/grade, and
        // never an archived sitting.
        const schoolId = actor.role === 'skyll_admin' ? await resolveSchoolId(db, school) : actor.school_id;
        if (!schoolId) return res.status(404).json({ error: 'School not found' });
        const itemsResult = await db.execute({
          sql: `SELECT q.id, COALESCE(d.state, 'pending') AS review_status
                FROM submission_questions_v2 q
                JOIN submissions s ON s.id = q.submission_id
                JOIN exams e ON e.id = s.exam_id
                LEFT JOIN question_reviews d ON d.submission_question_id = q.id
                WHERE e.school_id = ? AND COALESCE(e.source_test_id, e.id) = ?
                  AND s.status != 'archived' AND e.status != 'archived'`,
          args: [schoolId, testId],
        });
        const pending = itemsResult.rows.filter(r => r.review_status === 'pending').length;
        const isAuthorizedReviewer = ['admin', 'skyll_admin'].includes(actor.role);
        // FLKRM-117: authorized reviewers (admin/skyll_admin) may complete a review
        // while questions are still pending. Remaining pending items are auto-approved
        // (dual-write) so the exam can be published. Non-admin reviewers must still
        // clear every pending question before finalizing.
        if (pending > 0 && !isAuthorizedReviewer) return res.status(400).json({ error: `${pending} items still pending review` });
        const now = new Date().toISOString();
        let approved = 0;
        if (pending > 0 && isAuthorizedReviewer) {
          // Auto-approve each pending question exactly as approve-cohort does:
          // canonical + legacy dual-write, pending-only, with an audit event.
          const pendingIds = itemsResult.rows
            .filter((r) => r.review_status === 'pending')
            .map((r) => r.id)
            .filter((id) => id != null);
          // Three statements per question; keep each write batch near 200.
          for (const ids of chunk(pendingIds, Math.floor(FINALIZE_BATCH_STATEMENTS / 3))) {
            const results = await db.batch(ids.flatMap((id) => ([
              {
                sql: `INSERT INTO question_reviews (submission_question_id, state, reviewer_id, revision, approved_at, updated_at)
                      VALUES (?, 'approved', ?, 1, ?, ?)
                      ON CONFLICT(submission_question_id) DO UPDATE SET
                        state = 'approved', reviewer_id = excluded.reviewer_id,
                        revision = question_reviews.revision + 1, approved_at = excluded.approved_at, updated_at = excluded.updated_at
                      WHERE question_reviews.state = 'pending'`,
                args: [id, actor.username, now, now],
              },
              {
                sql: `INSERT INTO review_decisions (submission_question_id, state, reviewer_id, revision, approved_at, updated_at)
                      VALUES (?, 'approved', ?, 1, ?, ?)
                      ON CONFLICT(submission_question_id) DO UPDATE SET
                        state = 'approved', reviewer_id = excluded.reviewer_id,
                        revision = review_decisions.revision + 1, approved_at = excluded.approved_at, updated_at = excluded.updated_at
                      WHERE review_decisions.state = 'pending'`,
                args: [id, actor.username, now, now],
              },
              {
                sql: `INSERT INTO question_review_events (id, submission_question_id, actor_user_id, event_type, before_json, after_json, comment, created_at)
                      SELECT ?, ?, ?, 'review_decided', ?, ?, ?, ?
                      WHERE EXISTS (SELECT 1 FROM question_reviews WHERE submission_question_id = ? AND state = 'approved' AND approved_at = ? AND reviewer_id = ?)`,
                args: [`review_event_${randomUUID()}`, id, actor.username, JSON.stringify({ state: 'pending' }), JSON.stringify({ state: 'approved' }), 'Approved when the assessment review was completed', now, id, now, actor.username],
              },
            ])), 'write');
            approved += results.filter((_, index) => index % 3 === 0).reduce((sum, result) => sum + Number(result.rowsAffected || 0), 0);
          }
        }
        await db.execute({
          sql: `UPDATE exams SET status = 'published', updated_at = ?
                WHERE school_id = ? AND COALESCE(source_test_id, id) = ? AND status != 'archived'`,
          args: [now, schoolId, testId],
        });
        return res.status(200).json({ ok: true, school, subject, grade, testId, approved, status: 'finalized' });
      }



      if (action === 'release-to-students') {
        const { school, testId } = req.body || {};
        return res.status(200).json(await releaseTestToStudents(db, actor, { school, testId }));
      }

      if (action === 'mark-cohort-complete') {
        const { school, testId, subject, grade, narrative } = req.body || {};
        if (!school || !testId) return res.status(400).json({ error: 'school and testId required' });
        if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: school }))) return res.status(403).json({ error: 'School access denied' });
        const counts = await countCohortPending(db, school, testId);
        const result = await markCohortComplete(db, actor, { school, testId, subject, grade, narrative, pending: counts.pending });
        return res.status(201).json({ ok: true, ...result, ...counts });
      }
      if (action === 'unmark-cohort-complete') {
        const { school, testId } = req.body || {};
        if (!school || !testId) return res.status(400).json({ error: 'school and testId required' });
        if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: school }))) return res.status(403).json({ error: 'School access denied' });
        return res.status(200).json(await unmarkCohortComplete(db, actor, { school, testId }));
      }

      if (action === 'approve-cohort') {
        // "Approve all" for one student in one assessment (FLKRM-96). Admin-only,
        // and strictly scoped to the selected test: a student's other
        // assessments are never touched.
        if (!['admin', 'skyll_admin'].includes(actor.role)) return res.status(403).json({ error: 'Admin access required' });
        const { studentId, testId } = req.body || {};
        if (!studentId || !testId) return res.status(400).json({ error: 'studentId and testId required' });
        const studentRows = await db.execute({
          sql: `SELECT DISTINCT e.school_id AS school_id
                FROM submission_questions_v2 q
                JOIN submissions s ON s.id = q.submission_id
                JOIN exams e ON e.id = s.exam_id
                WHERE s.student_id = ? AND COALESCE(e.source_test_id, e.id) = ?`,
          args: [studentId, testId],
        });
        if (!studentRows.rows.length) return res.status(404).json({ error: 'Student review items not found' });
        if (actor.role !== 'skyll_admin' && (await Promise.all(studentRows.rows.map((row) => inActorSchool(db, actor, { schoolId: row.school_id })))).includes(false)) return res.status(403).json({ error: 'School access denied' });
        const now = new Date().toISOString();
        const pending = await db.execute({
          sql: `SELECT q.id
                FROM submission_questions_v2 q
                JOIN submissions s ON s.id = q.submission_id
                JOIN exams e ON e.id = s.exam_id
                LEFT JOIN question_reviews d ON d.submission_question_id = q.id
                WHERE s.student_id = ? AND COALESCE(e.source_test_id, e.id) = ?
                  AND COALESCE(d.state, 'pending') = 'pending'`,
          args: [studentId, testId],
        });
        let approved = 0;
        if (pending.rows.length) {
          // Only a still-pending decision is overwritten: a question someone
          // approved, flagged, or reviewed since the read above is left alone.
          const results = await db.batch(pending.rows.flatMap((row) => ([
            {
              sql: `INSERT INTO question_reviews (submission_question_id, state, reviewer_id, revision, approved_at, updated_at)
                    VALUES (?, 'approved', ?, 1, ?, ?)
                    ON CONFLICT(submission_question_id) DO UPDATE SET
                      state = 'approved', reviewer_id = excluded.reviewer_id,
                      revision = question_reviews.revision + 1, approved_at = excluded.approved_at, updated_at = excluded.updated_at
                    WHERE question_reviews.state = 'pending'`,
              args: [row.id, actor.username, now, now],
            },
            {
              // Legacy dual-write during bake (Phase C) so review_decisions cannot lag approve-cohort.
              sql: `INSERT INTO review_decisions (submission_question_id, state, reviewer_id, revision, approved_at, updated_at)
                    VALUES (?, 'approved', ?, 1, ?, ?)
                    ON CONFLICT(submission_question_id) DO UPDATE SET
                      state = 'approved', reviewer_id = excluded.reviewer_id,
                      revision = review_decisions.revision + 1, approved_at = excluded.approved_at, updated_at = excluded.updated_at
                    WHERE review_decisions.state = 'pending'`,
              args: [row.id, actor.username, now, now],
            },
            {
              // Same audit trail as a single approval (saveReviewDecision).
              sql: `INSERT INTO question_review_events (id, submission_question_id, actor_user_id, event_type, before_json, after_json, comment, created_at)
                    SELECT ?, ?, ?, 'review_decided', ?, ?, ?, ?
                    WHERE EXISTS (SELECT 1 FROM question_reviews WHERE submission_question_id = ? AND state = 'approved' AND approved_at = ? AND reviewer_id = ?)`,
              args: [`review_event_${randomUUID()}`, row.id, actor.username, JSON.stringify({ state: 'pending' }), JSON.stringify({ state: 'approved' }), 'Approved with "Approve all" for this student', now, row.id, now, actor.username],
            },
          ])), 'write');
          approved = results.filter((_, index) => index % 3 === 0).reduce((sum, result) => sum + Number(result.rowsAffected || 0), 0);
        }
        return res.status(200).json({ ok: true, studentId, testId, approved });
      }

      if (action === 'edit-answer') {
        const itemId = req.body?.itemId;
        if (!itemId) return res.status(400).json({ error: 'Missing item ID' });
        const result = await editAnswerEvidence(db, actor, itemId, req.body?.studentAnswer);
        return res.status(200).json({ ok: true, id: itemId, ...result });
      }
      return res.status(400).json({ error: 'Unsupported review queue action' });
    } catch (err) {
      return errorResponse(res, err);
    }
  }

  if (req.method === 'GET') {
    try {
      await ensureAuthTables();
      const user = await requireUser(req, res, ['teacher', 'admin', 'skyll_admin']);
      if (!user) return;
      const meta = {};

      if (String(req.query.rubricPending || '').trim() === 'true') {
        if (!['admin', 'skyll_admin'].includes(user.role)) return res.status(403).json({ error: 'Admin access required' });
        return res.status(200).json({ items: await listRubricReviewQueue(client, user) });
      }
      if (String(req.query.rubricTestId || '').trim()) {
        if (!['admin', 'skyll_admin'].includes(user.role)) return res.status(403).json({ error: 'Admin access required' });
        return res.status(200).json(await loadRubricReviewPackage(client, user, String(req.query.rubricTestId).trim()));
      }

      // Scope in SQL before parsing JSON. A school reviewer must never pay the
      // cost of loading every other school's queue into memory or the browser.
      const requestedSchool = user.role === 'skyll_admin' ? String(req.query.school || '').trim() : user.school;
      // An empty school drops every school predicate below; only platform staff
      // may list across schools (FLKRM-384).
      if (user.role !== 'skyll_admin' && !String(requestedSchool || '').trim()) {
        return res.status(403).json({ error: 'School access denied' });
      }
      const requestedSubject = String(req.query.subject || '').trim();
      const requestedTestId = String(req.query.testId || '').trim();
      const summaryOnly = String(req.query.summary || '').trim() === 'true';
      const includeArchived = user.role === 'skyll_admin' && String(req.query.includeArchived || '') === 'true';
      // Phase 4 cutover complete: always read canonical tables.
      const clauses = ['1 = 1'];
      const args = [];
      if (requestedSchool) {
        // Platform staff pick a school by name; everyone else is scoped to the
        // school pinned on their session (FLKRM-385).
        const schoolId = user.role === 'skyll_admin' ? await resolveSchoolId(client, requestedSchool) : user.school_id || null;
        clauses.push(schoolId ? 'e.school_id = ?' : '1 = 0');
        if (schoolId) args.push(schoolId);
      }
      // A canonical test ID is authoritative. Do not additionally filter by a
      // historical subject string, otherwise a renamed assessment renders an
      // empty review cohort even though all submission questions exist.
      if (requestedTestId) { clauses.push('COALESCE(e.source_test_id, e.id) = ?'); args.push(requestedTestId); }
      else if (requestedSubject) { clauses.push('LOWER(sub.name) = LOWER(?)'); args.push(requestedSubject); }
      if (!includeArchived) clauses.push("s.status != 'archived'", "e.status != 'archived'");
      // Exclude internal test-data schools from the review dashboard.
      clauses.push("sc.display_name NOT IN ('skyll', 'Skyll Play Review')");

      // The landing view needs cohorts, not every question's OCR, grading
      // evidence, report lookup, and revision history. Keep this aggregation
      // in SQL so a multi-school review queue stays fast under normal load.
      if (summaryOnly) {
        const cohorts = await loadReviewCohortSummary(client, clauses, args);
        // Phase 6: surface pending recheck requests by exam in the review dashboard.
        let rechecks = [];
        try {
          const recheckSql =
            `SELECT r.id, r.status, r.reason, r.requested_at, r.requested_by, r.requested_by_role,
                      COALESCE(e.source_test_id, e.id) AS test_id, COALESCE(t.title, e.name) AS exam_name,
                      q.question_number, COALESCE(st.display_name, s.student_id) AS student_name
               FROM recheck_requests r
               JOIN submission_questions_v2 q ON q.id = r.submission_question_id
               JOIN submissions s ON s.id = q.submission_id
               JOIN exams e ON e.id = s.exam_id
               JOIN schools sc ON sc.id = e.school_id
               LEFT JOIN tests t ON t.id = e.source_test_id
               LEFT JOIN students st ON st.id = s.student_id
               WHERE r.status IN ('open', 'in_review', 'awaiting_regrade')
                 AND (? = '' OR sc.display_name = ?)
               ORDER BY r.requested_at DESC LIMIT 50`;
          const recheckResult = await client.execute({ sql: recheckSql, args: [requestedSchool, requestedSchool] });
          rechecks = recheckResult.rows.map((row) => ({
            id: row.id, status: row.status, reason: row.reason, requestedAt: row.requested_at,
            requestedBy: row.requested_by, requestedByRole: row.requested_by_role,
            testId: row.test_id, examName: row.exam_name || '', questionNumber: row.question_number || '',
            studentName: row.student_name || '',
          }));
        } catch { /* recheck tables may not exist in fixtures */ }
        // Fold cohort status into the summary so the dashboard avoids a second round trip.
        let cohortStatuses = {};
        try {
          const csArgs = user.role !== 'skyll_admin' ? [user.school] : [];
          const csResult = await client.execute({
            sql: `SELECT sc.display_name AS school, sub.name AS subject, t.grade,
                          CASE WHEN SUM(CASE WHEN e.status NOT IN ('published', 'delivered') THEN 1 ELSE 0 END) = 0
                               THEN 'finalized' ELSE 'in_review' END AS status,
                          MAX(e.updated_at) AS finalized_at
                   FROM exams e
                   JOIN schools sc ON sc.id = e.school_id
                   JOIN subjects sub ON sub.id = e.subject_id
                   LEFT JOIN tests t ON t.id = e.source_test_id
                   ${user.role !== 'skyll_admin' ? 'WHERE sc.display_name = ?' : ''}
                   GROUP BY sc.display_name, sub.name, t.grade`,
            args: csArgs,
          });
          for (const row of csResult.rows) {
            cohortStatuses[`${row.school}|${row.subject}|${row.grade || ''}`] = {
              status: row.status,
              finalizedBy: row.status === 'finalized' ? 'system' : null,
              finalizedAt: row.status === 'finalized' ? row.finalized_at : null,
            };
          }
        } catch { /* non-critical */ }
        // FLKRM-351: an explicit "mark as done" override is an input to the
        // derived status. Attach it per cohort so the client honours it without
        // a second round trip. Cohorts without a real test ID cannot be marked.
        try {
          const schools = [...new Set(cohorts.map((cohort) => cohort.school).filter(Boolean))];
          const overrides = await loadCohortCompletionOverrides(client, schools);
          for (const cohort of cohorts) {
            if (!cohort.isCanonicalTest || !cohort.testId) continue;
            const override = overrides.get(cohortOverrideKey(cohort.school, cohort.testId));
            if (override) cohort.completionOverride = override;
          }
        } catch { /* override table may not exist in fixtures */ }
        // Students see a test only once it is released; the card shows which.
        try {
          const releases = await loadTestReleases(client, cohorts.filter((cohort) => cohort.isCanonicalTest).map((cohort) => cohort.testId));
          for (const cohort of cohorts) {
            if (!cohort.isCanonicalTest || !cohort.testId) continue;
            cohort.release = releases.get(cohort.testId) || null;
          }
        } catch { /* exams.released_at may not exist before migration 089 */ }
        return res.status(200).json({ cohorts, rechecks, cohortStatuses });
      }
      const itemsSql =
        `SELECT q.id, sc.display_name AS school, sub.name AS subject,
                  COALESCE(e.source_test_id, e.id) AS test_id, s.student_id,
                  s.score AS submission_score, s.max_marks AS submission_max_marks,
                  ts.id AS test_student_id, st.display_name AS student_name,
                  COALESCE(
                    (SELECT uc.login_id FROM user_credentials uc WHERE uc.user_id = st.user_id AND length(uc.login_id) = 6 LIMIT 1),
                    (SELECT uc.login_id FROM user_credentials uc WHERE uc.user_id = st.user_id AND uc.is_primary = 1 LIMIT 1),
                    (SELECT uc.login_id FROM student_user_links sul JOIN user_credentials uc ON uc.user_id = sul.user_id WHERE sul.student_id = st.id AND length(uc.login_id) = 6 LIMIT 1),
                    (SELECT uc.login_id FROM student_user_links sul JOIN user_credentials uc ON uc.user_id = sul.user_id WHERE sul.student_id = st.id LIMIT 1),
                    (SELECT rv.username FROM report_versions rv WHERE rv.student_id = s.student_id AND rv.status = 'published' ORDER BY rv.published_at DESC LIMIT 1)
                  ) AS student_username,
                  e.grade AS exam_grade,
                  q.question_number, q.render_json AS data,
                  json_extract(q.evidence_json, '$.duplicate_of') AS duplicate_of,
                  json_extract(esq.rubric_json, '$.key_check') AS key_check_json,
                  q.review_revision, q.regraded_revision,
                  COALESCE(d.state, q.status) AS review_status, d.reason AS review_comment, d.reviewer_id AS reviewed_by,
                  d.approved_at AS reviewed_at, d.approved_marks AS override_marks
           FROM submission_questions_v2 q
           JOIN submissions s ON s.id = q.submission_id
           JOIN exams e ON e.id = s.exam_id
           JOIN schools sc ON sc.id = e.school_id
           LEFT JOIN subjects sub ON sub.id = e.subject_id
           LEFT JOIN students st ON st.id = s.student_id
           LEFT JOIN test_students ts ON ts.test_id = e.source_test_id AND ts.student_id = s.student_id
           LEFT JOIN question_reviews d ON d.submission_question_id = q.id
           LEFT JOIN exam_set_questions esq ON esq.id = q.exam_set_question_id
           WHERE ${clauses.join(' AND ')} ORDER BY s.student_id, q.question_number`;
      const itemsResult = await client.execute({ sql: itemsSql, args });

      const payloads = itemsResult.rows.map((row) => JSON.parse(row.data || '{}'));
      // Canonical rows surface the exam id for synthetic (orphan) exams while
      // their render payload still carries the historical tst_* id the assets
      // and reports are keyed by — collect both so neither lookup misses.
      const testIds = [...new Set(itemsResult.rows
        .flatMap((row, index) => [row.test_id, payloads[index].test_id, payloads[index].testId, payloads[index].question?.test_id, payloads[index].question?.testId])
        .filter(Boolean))];
      const testById = new Map();
      if (testIds.length > 0) {
        const placeholders = testIds.map(() => '?').join(', ');
        const tests = await client.execute({ sql: `SELECT id, grade, subject, title FROM tests WHERE id IN (${placeholders})`, args: testIds });
        for (const test of tests.rows) testById.set(test.id, test);
      }
      const canonicalTestIds = new Set(testById.keys());
      const pageCountByStudent = new Map();
      const assetKindsByTest = new Map();
      if (testIds.length > 0) {
        const placeholders = testIds.map(() => '?').join(', ');
        const assets = await client.execute({
          sql: `SELECT test_id, test_student_id, kind, storage_key
                FROM file_assets
                WHERE test_id IN (${placeholders}) AND status = 'uploaded'
                ORDER BY created_at`,
          args: testIds,
        });
        // Group assets by test+student+kind, then compute deduplicated page counts
        const grouped = new Map();
        for (const asset of assets.rows) {
          if (!assetKindsByTest.has(asset.test_id)) assetKindsByTest.set(asset.test_id, new Set());
          assetKindsByTest.get(asset.test_id).add(asset.kind);
          if (asset.kind === 'answer_sheet' && asset.test_student_id) {
            const key = `${asset.test_id}:${asset.test_student_id}`;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(asset);
          }
        }
        for (const [key, rows] of grouped) {
          // Use the same deduplication logic as the image-serving endpoint
          pageCountByStudent.set(key, indexIntakeAnswerSheetAssets(rows).length);
        }
      }
      const questionIds = itemsResult.rows.map((row) => row.id).filter(Boolean);
      const revisionHistory = await loadRevisionHistory(client, questionIds);

      const mappedItems = itemsResult.rows.map((row, index) => {
        // No report-question fallback: reports are keyed by submission ID,
        // never the roster student ID on the row, so that lookup never matched.
        const data = asReviewItem(row, payloads[index], testById, canonicalTestIds, pageCountByStudent, assetKindsByTest, new Map(), revisionHistory);
        return {
          ...data,
          reviewStatus: row.review_status,
          reviewComment: row.review_comment,
          reviewedBy: row.reviewed_by,
          reviewedAt: row.reviewed_at,
          overrideMarks: row.override_marks,
          reviewRevision: Number(row.review_revision || 0),
          regradedRevision: Number(row.regraded_revision || 0),
          needsRegrade: Number(row.review_revision || 0) > Number(row.regraded_revision || 0),
        };
      });
      // Defence in depth behind the SQL scope: compare school ids, not names (FLKRM-389).
      // Check each distinct school once, not once per question.
      const visibleSchools = new Map();
      if (user.role !== 'skyll_admin') {
        const schools = [...new Set(mappedItems.map((item) => item.school))];
        const checks = await Promise.all(schools.map((school) => inActorSchool(client, user, { schoolName: school })));
        schools.forEach((school, index) => visibleSchools.set(school, checks[index]));
      }
      const items = user.role === 'skyll_admin' ? mappedItems : mappedItems.filter((item) => visibleSchools.get(item.school));

      // Natural sort by student_id then question number (shared/questionNumberSort.js).
      items.sort((a, b) => {
        const sidCmp = (a.studentId || '').localeCompare(b.studentId || '');
        if (sidCmp !== 0) return sidCmp;
        return compareQuestionNumbers(a.questionNumber, b.questionNumber);
      });

      return res.status(200).json({
        ...meta,
        items,
        pending: items.filter(i => i.reviewStatus === 'pending').length,
        approved: items.filter(i => i.reviewStatus === 'approved').length,
        overridden: items.filter(i => i.overrideMarks !== null).length,
      });
    } catch (err) {
      return errorResponse(res, err);
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
