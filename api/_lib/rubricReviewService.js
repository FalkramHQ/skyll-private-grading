/**
 * Rubric review gate — load/edit/approve marking packages before grading.
 */
import { randomUUID } from 'node:crypto';
import { syncExamSetQuestionsFromRubric } from './canonicalSubmissions.js';
import { inActorSchool } from './schoolScope.js';
import { isAwaitingRubricReview } from '../../shared/workflowLifecycle.js';
import { DEFAULT_VISUAL_REQUIREMENT, suggestVisualRequirements } from '../../shared/visualRequirements.js';
import { checkRubricGate, effectiveTotal, OVERRIDE_REASON_MIN_CHARS, rubricGateEnabled, validOverrideReason } from '../../shared/rubricGate.js';

export { DEFAULT_VISUAL_REQUIREMENT, suggestVisualRequirements };

function id(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function assertSchoolAccess(db, actor, school) {
  // tests carries only the school name; inActorSchool resolves it to an id.
  if (actor.role !== 'skyll_admin' && !(await inActorSchool(db, actor, { schoolName: school }))) {
    const error = new Error('School access denied');
    error.statusCode = 403;
    throw error;
  }
}

export async function listRubricReviewQueue(db, actor) {
  const schoolClause = actor.role === 'skyll_admin' ? '' : 'AND t.school = ?';
  const args = actor.role === 'skyll_admin' ? [] : [actor.school];
  const rows = await db.execute({
    sql: `SELECT t.id AS test_id, t.title AS name, t.school, t.subject, t.grade, t.status, t.updated_at,
            r.version AS rubric_version, r.id AS rubric_id,
            json_extract(r.quality_json, '$.questionCount') AS question_count,
            json_extract(r.quality_json, '$.totalMarks') AS total_marks,
            json_extract(r.quality_json, '$.declaredTotalMarks') AS declared_total_marks,
            json_extract(r.quality_json, '$.effectiveTotalMarks') AS effective_total_marks
          FROM tests t
          LEFT JOIN exam_rubric_versions r ON r.test_id = t.id AND r.is_active = 1 AND r.status = 'succeeded'
          WHERE t.status IN ('rubric_ready_for_review', 'rubric_complete')
            ${schoolClause}
          ORDER BY t.updated_at DESC
          LIMIT 100`,
    args,
  });
  return rows.rows.map((row) => ({
    testId: row.test_id,
    name: row.name || row.test_id,
    school: row.school,
    subject: row.subject || '',
    grade: row.grade || '',
    status: row.status,
    updatedAt: row.updated_at,
    rubricVersion: row.rubric_version ?? null,
    rubricId: row.rubric_id || null,
    questionCount: Number(row.question_count || 0),
    totalMarks: Number(row.total_marks || 0),
    declaredTotalMarks: row.declared_total_marks == null ? null : Number(row.declared_total_marks),
    effectiveTotalMarks: row.effective_total_marks == null ? null : Number(row.effective_total_marks),
  }));
}

export async function loadRubricReviewPackage(db, actor, testId) {
  const test = await db.execute({ sql: 'SELECT * FROM tests WHERE id = ?', args: [testId] });
  if (!test.rows.length) {
    const error = new Error('Test not found');
    error.statusCode = 404;
    throw error;
  }
  const row = test.rows[0];
  await assertSchoolAccess(db, actor, row.school);

  const rubric = await db.execute({
    sql: `SELECT * FROM exam_rubric_versions
          WHERE test_id = ? AND is_active = 1 AND status = 'succeeded'
          ORDER BY version DESC LIMIT 1`,
    args: [testId],
  });
  if (!rubric.rows.length) {
    const error = new Error('No active marking rubric found for this assessment');
    error.statusCode = 404;
    throw error;
  }
  const packageRow = rubric.rows[0];
  const map = parseJson(packageRow.question_map_json, {});
  const quality = parseJson(packageRow.quality_json, {});
  const assets = await db.execute({
    sql: `SELECT kind, COUNT(*) AS count FROM file_assets
          WHERE test_id = ? AND status = 'uploaded' AND kind IN ('question_paper', 'answer_key', 'answer_sheet')
          GROUP BY kind`,
    args: [testId],
  });
  const counts = Object.fromEntries(assets.rows.map((item) => [item.kind, Number(item.count)]));
  // Gate results are computed from the package as it stands, never read from a stored copy.
  const gateEnabled = rubricGateEnabled({ school: row.school, schoolId: row.school_id });
  const gateResult = gateEnabled
    ? checkRubricGate({ exam: map.exam || {}, questions: map.questions || [], quality, key_check: map.key_check })
    : { errors: [], warnings: [] };

  return {
    testId,
    name: row.title || row.name || testId,
    school: row.school,
    subject: row.subject || '',
    grade: row.grade || '',
    status: row.status,
    awaitingRubricReview: isAwaitingRubricReview(row.status),
    rubric: {
      id: packageRow.id,
      version: packageRow.version,
      model: packageRow.model,
      exam: map.exam || {},
      questions: Array.isArray(map.questions) ? map.questions : [],
      quality,
      keyCheck: map.key_check || null,
      createdAt: packageRow.created_at,
      completedAt: packageRow.completed_at,
    },
    gate: {
      enabled: gateEnabled,
      errors: gateResult.errors,
      warnings: gateResult.warnings,
      overrideReasonMinChars: OVERRIDE_REASON_MIN_CHARS,
    },
    assets: {
      questionPaper: Number(counts.question_paper || 0) > 0,
      answerKey: Number(counts.answer_key || 0) > 0,
      answerSheets: Number(counts.answer_sheet || 0),
    },
    references: {
      questionPaperUrl: `/api/images/reference?testId=${encodeURIComponent(testId)}&kind=question_paper`,
      answerKeyUrl: `/api/images/reference?testId=${encodeURIComponent(testId)}&kind=answer_key`,
    },
  };
}

function normalizeVisualRequirements(value) {
  if (value == null || value === false) return null;
  if (value === true) return DEFAULT_VISUAL_REQUIREMENT;
  const text = String(value).trim();
  return text || null;
}

function normalizeQuestionEdits(questions = []) {
  if (!Array.isArray(questions) || !questions.length) {
    const error = new Error('questions[] is required');
    error.statusCode = 400;
    throw error;
  }
  return questions.map((question, index) => {
    const number = String(question.number || question.question_number || `Q${index + 1}`).trim();
    const marks = Number(question.marks_allocated ?? question.max_marks ?? 0);
    return {
      ...question,
      id: question.id || number,
      ...(question.mark_step != null && question.mark_step !== '' ? { mark_step: Number(question.mark_step) } : {}),
      number,
      question_text: String(question.question_text || ''),
      marks_allocated: Number.isFinite(marks) ? marks : 0,
      topic: String(question.topic || ''),
      expected_response_type: String(question.expected_response_type || 'other'),
      correct_answer_summary: String(question.correct_answer_summary || ''),
      accepted_variations: Array.isArray(question.accepted_variations) ? question.accepted_variations : [],
      marking_rubric: String(question.marking_rubric || ''),
      answer_key_evidence: String(question.answer_key_evidence || ''),
      question_source_pages: Array.isArray(question.question_source_pages) ? question.question_source_pages : [],
      answer_key_source_pages: Array.isArray(question.answer_key_source_pages) ? question.answer_key_source_pages : [],
      is_optional: Boolean(question.is_optional),
      selection_group: question.selection_group ?? null,
      visual_requirements: normalizeVisualRequirements(question.visual_requirements),
    };
  });
}

export { normalizeVisualRequirements };

const KEY_CHECK_RESOLUTIONS = new Set(['kept', 'alternative', 'corrected']);

/**
 * Record who resolved each key-check disagreement and when, and make "accept as an
 * alternative" true on the package even if the client did not add the answer itself.
 * Mutates `questions` (the normalised edits).
 */
export function stampKeyCheckResolutions(questions, previous = [], actor = {}) {
  const before = new Map(previous.map((q) => [q.number, q.key_check]));
  const at = new Date().toISOString();
  for (const q of questions) {
    const check = q.key_check;
    if (!check || typeof check !== 'object') continue;
    if (check.status !== 'open' && check.status !== 'none' && !KEY_CHECK_RESOLUTIONS.has(check.status)) check.status = 'open';
    const was = before.get(q.number)?.status;
    if (KEY_CHECK_RESOLUTIONS.has(check.status) && was !== check.status) {
      check.resolved_by = actor.username || null;
      check.resolved_at = at;
    }
    if (check.status === 'open') { delete check.resolved_by; delete check.resolved_at; }
    if (check.status === 'alternative' && check.checker_answer
      && !q.accepted_variations.some((value) => String(value).trim() === String(check.checker_answer).trim())) {
      q.accepted_variations = [...q.accepted_variations, String(check.checker_answer)];
    }
  }
  return questions;
}

export async function saveRubricReviewEdits(db, actor, { testId, questions, exam }) {
  const pack = await loadRubricReviewPackage(db, actor, testId);
  if (!pack.awaitingRubricReview) {
    const error = new Error('Rubric can only be edited while awaiting review');
    error.statusCode = 409;
    throw error;
  }
  const normalizedQuestions = normalizeQuestionEdits(questions);
  const totalMarks = normalizedQuestions.reduce((sum, q) => sum + Number(q.marks_allocated || 0), 0);
  const nextMap = {
    exam: {
      ...(pack.rubric.exam || {}),
      ...(exam && typeof exam === 'object' ? exam : {}),
      total_marks: totalMarks,
    },
    questions: normalizedQuestions,
    quality: {
      ...(pack.rubric.quality || {}),
      questionCount: normalizedQuestions.length,
      totalMarks,
    },
  };
  if (pack.rubric.keyCheck) nextMap.key_check = pack.rubric.keyCheck;
  if (pack.gate.enabled) {
    stampKeyCheckResolutions(normalizedQuestions, pack.rubric.questions, actor);
    // Re-validate the edited package. Keep the paper's printed total instead of
    // overwriting it with the raw sum, so a total mismatch stays visible.
    const declared = Number(pack.rubric.exam?.declared_total_marks ?? pack.rubric.quality?.declaredTotalMarks);
    if (Number.isFinite(declared) && declared > 0) {
      nextMap.exam.total_marks = declared;
      nextMap.exam.declared_total_marks = declared;
    }
    const { errors, warnings } = checkRubricGate(nextMap);
    nextMap.quality = {
      ...nextMap.quality,
      effectiveTotalMarks: effectiveTotal(normalizedQuestions, nextMap.exam.scoring_plan),
      // The old free-text warnings describe the package before these edits.
      warnings: [],
      gate: true,
      errors,
      gateWarnings: warnings,
    };
  }
  const at = new Date().toISOString();
  await db.execute({
    sql: `UPDATE exam_rubric_versions
          SET question_map_json = ?, quality_json = ?, completed_at = ?
          WHERE id = ?`,
    args: [JSON.stringify(nextMap), JSON.stringify(nextMap.quality), at, pack.rubric.id],
  });
  await syncExamSetQuestionsFromRubric(db, { testId, rubric: nextMap, at });
  return loadRubricReviewPackage(db, actor, testId);
}

export async function approveRubricAndMarkForGrading(db, actor, { testId, overrideReason } = {}) {
  const pack = await loadRubricReviewPackage(db, actor, testId);
  if (!pack.awaitingRubricReview) {
    const error = new Error('Assessment is not awaiting rubric review');
    error.statusCode = 409;
    throw error;
  }
  if (!pack.rubric.questions.length) {
    const error = new Error('Rubric has no questions to grade');
    error.statusCode = 409;
    throw error;
  }

  // Rubric gate: errors block approval unless an admin overrides with a written reason.
  let override = null;
  if (pack.gate.enabled && pack.gate.errors.length) {
    const reason = validOverrideReason(overrideReason);
    if (!reason) {
      const error = new Error(
        `${pack.gate.errors.length} rubric error(s) must be fixed before grading, `
        + `or approved with a reason of at least ${OVERRIDE_REASON_MIN_CHARS} characters.`,
      );
      error.statusCode = 409;
      throw error;
    }
    override = { reason, errors: pack.gate.errors.map(({ code, question }) => ({ code, question })) };
  }

  const active = await db.execute({
    sql: `SELECT id, status FROM processing_jobs
          WHERE test_id = ? AND type = 'materialize_evidence' AND status IN ('queued', 'running')
          ORDER BY requested_at DESC LIMIT 1`,
    args: [testId],
  });
  if (active.rows.length) {
    return {
      ok: true,
      reused: true,
      job: { id: active.rows[0].id, testId, status: active.rows[0].status },
      testStatus: 'evidence_queued',
    };
  }

  const at = new Date().toISOString();
  const jobId = id('job');
  await db.batch([
    {
      sql: `INSERT INTO processing_jobs
            (id, test_id, school, type, status, payload_json, requested_by, requested_at, progress_json)
            VALUES (?, ?, ?, 'materialize_evidence', 'queued', ?, ?, ?, ?)`,
      args: [
        jobId,
        testId,
        pack.school,
        JSON.stringify({
          rubric_version: pack.rubric.version,
          approved_by: actor.username,
          approved_at: at,
          ...(override ? { override_reason: override.reason, override_errors: override.errors } : {}),
        }),
        actor.username,
        at,
        JSON.stringify({
          steps: {
            evidence: {
              status: 'queued',
              detail: `Rubric approved by ${actor.username}; awaiting evidence materialization`,
            },
          },
        }),
      ],
    },
    {
      sql: "UPDATE tests SET status = 'evidence_queued', updated_at = ? WHERE id = ?",
      args: [at, testId],
    },
    // exam_rubric_versions has no approval columns; keep the bypass on the version itself.
    ...(override ? [{
      sql: `UPDATE exam_rubric_versions SET quality_json = json_set(COALESCE(quality_json, '{}'), '$.approval', json(?)) WHERE id = ?`,
      args: [JSON.stringify({ by: actor.username, at, overrideReason: override.reason, errors: override.errors }), pack.rubric.id],
    }] : []),
  ], 'write');

  return {
    ok: true,
    reused: false,
    job: { id: jobId, testId, status: 'queued' },
    testStatus: 'evidence_queued',
  };
}
