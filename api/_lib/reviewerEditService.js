import { randomUUID } from 'node:crypto';
import { inActorSchool } from './schoolScope.js';
import { RecheckContractError } from './recheckCollectionService.js';
import { logMirrorFailure, syncQuestionReview, syncV2Question } from './canonicalSubmissions.js';
import { parseMcqMarkScheme } from '../../apps/processing-worker/gradeResult.js';

function reject(status, message) {
  throw new RecheckContractError(status, message);
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** Lowest allowed override: 0 normally, or MCQ negative penalty when the rubric defines one. */
export function overrideMarksBounds(question = {}) {
  const marksTotal = Number(question.marks_total) || 0;
  const payload = parseJson(question.payload_json);
  const rubricText = [
    question.marking_rubric,
    payload.markingRubric,
    payload.question?.marking_rubric,
    question.exam_instructions,
  ].filter(Boolean).join('\n');
  const responseType = String(
    question.expected_response_type
    || payload.expectedResponseType
    || payload.question?.expected_response_type
    || '',
  ).toLowerCase();
  const scheme = responseType === 'mcq' || /negative\s*marks?|-\s*\d+\s*(?:mark|in\s+all\s+other)/i.test(rubricText)
    ? parseMcqMarkScheme(rubricText, marksTotal)
    : null;
  return {
    min: scheme ? Number(scheme.incorrect) : 0,
    max: marksTotal,
    scheme,
  };
}

/** Canonical-only load — legacy fallback removed (Phase B cutover). */
async function loadQuestion(db, actor, questionId) {
  const canonical = await db.execute({
    sql: `SELECT v.id,
                 sc.display_name AS school,
                 e.school_id AS school_id,
                 v.render_json AS payload_json,
                 v.review_revision,
                 v.regraded_revision,
                 v.approved_marks,
                 v.ai_marks,
                 COALESCE(esq.max_marks, 0) AS marks_total,
                 esq.rubric_json AS set_rubric_json,
                 json_extract(esq.rubric_json, '$.marking_rubric') AS marking_rubric,
                 json_extract(esq.rubric_json, '$.expected_response_type') AS expected_response_type
          FROM submission_questions_v2 v
          JOIN submissions s ON s.id = v.submission_id
          JOIN exams e ON e.id = s.exam_id
          JOIN schools sc ON sc.id = e.school_id
          LEFT JOIN exam_set_questions esq ON esq.id = v.exam_set_question_id
          WHERE v.id = ?`,
    args: [questionId],
  });
  const question = canonical.rows[0];
  if (!question) reject(404, 'Item not found');
  if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolId: question.school_id }))) {
    reject(403, 'School access denied');
  }
  return question;
}

async function recheckTransitionOperations(db, questionId, actor, now, uuid, note) {
  const result = await db.execute({
    sql: `SELECT id, status FROM recheck_requests
          WHERE submission_question_id = ? AND status IN ('open', 'in_review')`,
    args: [questionId],
  });
  return result.rows.flatMap((request) => {
    const operations = [];
    if (request.status === 'open') {
      operations.push({
        sql: `INSERT INTO recheck_events (
                id, recheck_request_id, actor_user_id, event_type,
                before_json, after_json, created_at
              ) VALUES (?, ?, ?, 'status_in_review', ?, ?, ?)`,
        args: [
          `recheck_event_${uuid()}`,
          request.id,
          actor.username,
          JSON.stringify({ status: 'open' }),
          JSON.stringify({ status: 'in_review' }),
          now,
        ],
      });
    }
    operations.push(
      {
        sql: `UPDATE recheck_requests
              SET status = 'awaiting_regrade',
                  taken_by = CASE WHEN status = 'open' THEN ? ELSE taken_by END,
                  taken_at = CASE WHEN status = 'open' THEN ? ELSE taken_at END
              WHERE id = ? AND status IN ('open', 'in_review')`,
        args: [actor.username, now, request.id],
      },
      {
        sql: `INSERT INTO recheck_events (
                id, recheck_request_id, actor_user_id, event_type,
                before_json, after_json, note, created_at
              ) VALUES (?, ?, ?, 'awaiting_regrade', ?, ?, ?, ?)`,
        args: [
          `recheck_event_${uuid()}`,
          request.id,
          actor.username,
          JSON.stringify({ status: 'in_review' }),
          JSON.stringify({ status: 'awaiting_regrade' }),
          note,
          now,
        ],
      },
    );
    return operations;
  });
}

export async function editAnswerEvidence(db, actor, questionId, studentAnswer, options = {}) {
  if (!['teacher', 'admin', 'skyll_admin'].includes(actor.role)) reject(403, 'Reviewer access required');
  if (!studentAnswer || typeof studentAnswer !== 'object' || Array.isArray(studentAnswer)) {
    reject(400, 'studentAnswer required');
  }
  const question = await loadQuestion(db, actor, questionId);
  const payload = JSON.parse(question.payload_json || '{}');
  const before = payload.studentAnswer || {};
  const after = { ...before, ...studentAnswer };
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return {
      changed: false,
      studentAnswer: before,
      reviewRevision: Number(question.review_revision || 0),
      regradedRevision: Number(question.regraded_revision || 0),
    };
  }

  const now = options.now?.() || new Date().toISOString();
  const uuid = options.uuid || randomUUID;
  payload.studentAnswer = after;
  payload.editedBy = actor.username;
  payload.editedAt = now;
  const encoded = JSON.stringify(payload);
  const transitions = await recheckTransitionOperations(
    db,
    questionId,
    actor,
    now,
    uuid,
    'Reviewer corrected the answer evidence; the report will update after regrade.',
  );
  await db.batch([
    // Canonical write (primary for review UI).
    {
      sql: `UPDATE submission_questions_v2
            SET render_json = ?, review_revision = review_revision + 1, updated_at = ?
            WHERE id = ?`,
      args: [encoded, now, questionId],
    },
    // Legacy dual-write during bake.
    {
      sql: `UPDATE submission_questions
            SET payload_json = ?, review_revision = review_revision + 1, updated_at = ?
            WHERE id = ?`,
      args: [encoded, now, questionId],
    },
    {
      sql: `INSERT INTO question_review_events (
              id, submission_question_id, actor_user_id, event_type,
              before_json, after_json, created_at
            ) VALUES (?, ?, ?, 'ocr_edited', ?, ?, ?)`,
      args: [
        `review_event_${uuid()}`,
        questionId,
        actor.username,
        JSON.stringify(before),
        JSON.stringify(after),
        now,
      ],
    },
    ...transitions,
  ], 'write');
  await syncV2Question(db, questionId, now).catch((error) => logMirrorFailure('answer_evidence', error));
  return {
    changed: true,
    studentAnswer: after,
    editedBy: actor.username,
    editedAt: now,
    reviewRevision: Number(question.review_revision || 0) + 1,
    regradedRevision: Number(question.regraded_revision || 0),
  };
}

export async function saveReviewDecision(db, actor, questionId, input = {}, options = {}) {
  if (!['teacher', 'admin', 'skyll_admin'].includes(actor.role)) reject(403, 'Reviewer access required');
  const question = await loadQuestion(db, actor, questionId);
  const allowedStates = new Set(['approved', 'reviewed', 'flagged']);
  const nextState = input.status || 'reviewed';
  if (!allowedStates.has(nextState)) reject(400, 'Unsupported review state');

  const hasOverride = input.overrideMarks !== undefined
    && input.overrideMarks !== null
    && input.overrideMarks !== '';
  const override = hasOverride ? Number(input.overrideMarks) : null;
  const { min: marksMin, max: marksTotal } = overrideMarksBounds(question);
  if (hasOverride && (!Number.isFinite(override) || override < marksMin || override > marksTotal)) {
    reject(400, `Corrected marks must be between ${marksMin} and ${marksTotal}`);
  }
  const currentMarks = Number(question.approved_marks ?? question.ai_marks ?? 0);
  // A question held without any mark (a diagram the worker could not check) has
  // nothing to compare against, so a mark entered on it is a change, 0 included.
  // Otherwise review_revision stays 0 and the next grade overwrites the teacher's 0.
  const unmarked = question.approved_marks == null && question.ai_marks == null;
  const markChanged = hasOverride && (unmarked || override !== currentMarks);
  const now = options.now?.() || new Date().toISOString();
  const uuid = options.uuid || randomUUID;
  const before = { marks: currentMarks, reviewRevision: Number(question.review_revision || 0) };
  const after = {
    marks: hasOverride ? override : currentMarks,
    state: nextState,
    reviewRevision: Number(question.review_revision || 0) + (markChanged ? 1 : 0),
  };
  const transitions = markChanged
    ? await recheckTransitionOperations(
      db,
      questionId,
      actor,
      now,
      uuid,
      'Reviewer corrected the marks; the report will update after regrade.',
    )
    : [];

  await db.batch([
    {
      sql: `INSERT INTO question_reviews (
              submission_question_id, state, approved_marks, reviewer_id,
              reason, revision, approved_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(submission_question_id) DO UPDATE SET
              state = excluded.state,
              approved_marks = excluded.approved_marks,
              reviewer_id = excluded.reviewer_id,
              reason = excluded.reason,
              revision = question_reviews.revision + 1,
              approved_at = excluded.approved_at,
              updated_at = excluded.updated_at`,
      args: [
        questionId,
        nextState,
        hasOverride ? override : null,
        actor.username,
        input.comment || null,
        now,
        now,
      ],
    },
    {
      sql: `INSERT INTO review_decisions (
              submission_question_id, state, approved_marks, reviewer_id,
              reason, revision, approved_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(submission_question_id) DO UPDATE SET
              state = excluded.state,
              approved_marks = excluded.approved_marks,
              reviewer_id = excluded.reviewer_id,
              reason = excluded.reason,
              revision = review_decisions.revision + 1,
              approved_at = excluded.approved_at,
              updated_at = excluded.updated_at`,
      args: [
        questionId,
        nextState,
        hasOverride ? override : null,
        actor.username,
        input.comment || null,
        now,
        now,
      ],
    },
    {
      sql: `UPDATE submission_questions_v2
            SET approved_marks = COALESCE(?, approved_marks),
                review_revision = review_revision + ?,
                updated_at = ?
            WHERE id = ?`,
      args: [hasOverride ? override : null, markChanged ? 1 : 0, now, questionId],
    },
    {
      sql: `UPDATE submission_questions
            SET approved_marks = COALESCE(?, approved_marks),
                review_revision = review_revision + ?,
                updated_at = ?
            WHERE id = ?`,
      args: [hasOverride ? override : null, markChanged ? 1 : 0, now, questionId],
    },
    {
      sql: `INSERT INTO question_review_events (
              id, submission_question_id, actor_user_id, event_type,
              before_json, after_json, comment, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        `review_event_${uuid()}`,
        questionId,
        actor.username,
        markChanged ? 'marks_overridden' : 'review_decided',
        JSON.stringify(before),
        JSON.stringify(after),
        input.comment || null,
        now,
      ],
    },
    ...transitions,
  ], 'write');
  await Promise.all([
    syncV2Question(db, questionId, now),
    syncQuestionReview(db, questionId, now),
  ]).catch((error) => logMirrorFailure('review_decision', error));
  return { changed: markChanged, marks: after.marks, reviewRevision: after.reviewRevision };
}
