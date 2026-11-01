/**
 * Context builders for AI surfaces (tutor, hive, copilot).
 */

import { loadMasteryEstimates } from './masteryRead.js';
import { releasedExamSql } from './studentRelease.js';

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function resolveStudentIdentity(db, { schoolId, studentId, username, userId, selfUsername }) {
  const sid = String(studentId || '').trim();
  const login = String(username || '').trim();
  const uid = String(userId || '').trim();

  if (sid) {
    const row = (await db.execute({
      sql: `SELECT st.id AS student_id, st.display_name, sc.display_name AS school,
                   (SELECT uc.login_id FROM student_user_links sul
                    JOIN user_credentials uc ON uc.user_id = sul.user_id
                    WHERE sul.student_id = st.id AND uc.status = 'active'
                    ORDER BY uc.is_primary DESC LIMIT 1) AS username,
                   (SELECT enrollment.standard FROM student_enrollments enrollment
                    JOIN academic_years year ON year.id = enrollment.academic_year_id
                    WHERE enrollment.student_id = st.id AND enrollment.status = 'active'
                      AND year.school_id = st.school_id AND year.is_current = 1
                    ORDER BY enrollment.updated_at DESC LIMIT 1) AS class_name
            FROM students st
            JOIN schools sc ON sc.id = st.school_id
            WHERE st.id = ? AND st.school_id = ?
            LIMIT 1`,
      args: [sid, schoolId],
    }).catch(() => ({ rows: [] }))).rows[0];
    if (row) {
      return {
        studentId: row.student_id,
        username: row.username || login || undefined,
        name: row.display_name || null,
        className: row.class_name || null,
        school: row.school || null,
        resolved: true,
      };
    }
  }

  if (login) {
    const row = (await db.execute({
      sql: `SELECT sul.student_id, st.display_name, sc.display_name AS school, uc.login_id AS username,
                   (SELECT enrollment.standard FROM student_enrollments enrollment
                    JOIN academic_years year ON year.id = enrollment.academic_year_id
                    WHERE enrollment.student_id = st.id AND enrollment.status = 'active'
                      AND year.school_id = st.school_id AND year.is_current = 1
                    ORDER BY enrollment.updated_at DESC LIMIT 1) AS class_name
            FROM user_credentials uc
            JOIN student_user_links sul ON sul.user_id = uc.user_id
            JOIN students st ON st.id = sul.student_id
            JOIN schools sc ON sc.id = st.school_id
            WHERE uc.login_id = ? AND st.school_id = ?
            LIMIT 1`,
      args: [login, schoolId],
    }).catch(() => ({ rows: [] }))).rows[0];
    if (row) {
      return {
        studentId: row.student_id,
        username: row.username,
        name: row.display_name || null,
        className: row.class_name || null,
        school: row.school || null,
        resolved: true,
      };
    }
  }

  if (uid) {
    const row = (await db.execute({
      sql: `SELECT sul.student_id, st.display_name, sc.display_name AS school,
                   (SELECT uc.login_id FROM user_credentials uc
                    WHERE uc.user_id = sul.user_id AND uc.status = 'active'
                    ORDER BY uc.is_primary DESC LIMIT 1) AS username,
                   (SELECT enrollment.standard FROM student_enrollments enrollment
                    JOIN academic_years year ON year.id = enrollment.academic_year_id
                    WHERE enrollment.student_id = st.id AND enrollment.status = 'active'
                      AND year.school_id = st.school_id AND year.is_current = 1
                    ORDER BY enrollment.updated_at DESC LIMIT 1) AS class_name
            FROM student_user_links sul
            JOIN students st ON st.id = sul.student_id
            JOIN schools sc ON sc.id = st.school_id
            WHERE sul.user_id = ? AND st.school_id = ?
            LIMIT 1`,
      args: [uid, schoolId],
    }).catch(() => ({ rows: [] }))).rows[0];
    if (row) {
      return {
        studentId: row.student_id,
        username: row.username || undefined,
        name: row.display_name || null,
        className: row.class_name || null,
        school: row.school || null,
        resolved: true,
      };
    }
  }

  // FLKRM-382: an identifier that does not resolve inside `schoolId` must not
  // be used to read data anyway — that read is unscoped and crosses schools.
  // The one exception is a caller reading their own profile by their own
  // login and has no linked student record anywhere (older accounts with
  // legacy DNA only). A linked student is always resolved through its school.
  const self = Boolean(login) && login === String(selfUsername || '').trim()
    && !(await db.execute({
      sql: `SELECT 1 FROM user_credentials uc JOIN student_user_links sul ON sul.user_id = uc.user_id
            WHERE uc.login_id = ? LIMIT 1`,
      args: [login],
    }).catch(() => ({ rows: [{}] }))).rows.length;
  return {
    studentId: '',
    username: self ? login : undefined,
    name: null,
    className: null,
    school: null,
    resolved: self,
  };
}

async function loadDna(db, { schoolId, studentId, username }) {
  if (studentId) {
    const v2 = (await db.execute({
      sql: 'SELECT dna_json, exam_count, question_count, updated_at FROM learner_dna_v2 WHERE student_id = ? AND school_id = ? LIMIT 1',
      args: [studentId, schoolId],
    }).catch(() => ({ rows: [] }))).rows[0];
    if (v2?.dna_json) {
      return {
        dna: parseJson(v2.dna_json, null),
        examCount: Number(v2.exam_count) || 0,
        questionCount: Number(v2.question_count) || 0,
        updatedAt: v2.updated_at || null,
      };
    }
  }
  if (username) {
    const legacy = (await db.execute({
      sql: 'SELECT dna_json, exam_count, question_count, updated_at FROM learner_dna WHERE username = ? LIMIT 1',
      args: [username],
    }).catch(() => ({ rows: [] }))).rows[0];
    if (legacy?.dna_json) {
      return {
        dna: parseJson(legacy.dna_json, null),
        examCount: Number(legacy.exam_count) || 0,
        questionCount: Number(legacy.question_count) || 0,
        updatedAt: legacy.updated_at || null,
      };
    }
  }
  return { dna: null, examCount: 0, questionCount: 0, updatedAt: null };
}

async function loadSignals(db, { schoolId, studentId, limit = 60, releasedOnly = true }) {
  if (!studentId) return [];
  const result = await db.execute({
    sql: `SELECT id, submission_id, submission_question_id, exam_id, question_number, topic,
                 marks_obtained, marks_total, concept_tags_json, misconception, strength,
                 method_note, next_practice, confidence, evidence_refs_json, extracted_at
          FROM evidence_signals
          WHERE school_id = ? AND student_id = ? AND status = 'active'${releasedOnly ? ` AND ${releasedExamSql('evidence_signals.exam_id')}` : ''}
          ORDER BY extracted_at DESC
          LIMIT ?`,
    args: [schoolId, studentId, limit],
  }).catch(() => ({ rows: [] }));

  return result.rows.map((row) => ({
    id: row.id,
    submissionId: row.submission_id,
    submissionQuestionId: row.submission_question_id,
    examId: row.exam_id,
    questionNumber: row.question_number,
    topic: row.topic,
    marksObtained: row.marks_obtained,
    marksTotal: row.marks_total,
    conceptTags: parseJson(row.concept_tags_json, []),
    misconception: row.misconception,
    strength: row.strength,
    methodNote: row.method_note,
    nextPractice: row.next_practice,
    confidence: row.confidence,
    evidenceRefs: parseJson(row.evidence_refs_json, []),
    extractedAt: row.extracted_at,
  }));
}

async function loadRecentReports(db, { schoolId, username, studentId, limit = 8, releasedOnly = true }) {
  // report_versions carries the school display name; a login can have reports
  // in more than one school, so scope to this one.
  const args = [schoolId];
  const clauses = ["status = 'published'", 'school = (SELECT display_name FROM schools WHERE id = ?)'];
  if (releasedOnly) clauses.push(releasedExamSql('report_versions.exam_id'));
  if (username) {
    clauses.push('username = ?');
    args.push(username);
  } else if (studentId) {
    clauses.push('student_id = ?');
    args.push(studentId);
  } else {
    return [];
  }
  args.push(limit);
  const result = await db.execute({
    sql: `SELECT id, username, school, submission_id, student_id, published_at, payload_json
          FROM report_versions
          WHERE ${clauses.join(' AND ')}
          ORDER BY published_at DESC
          LIMIT ?`,
    args,
  }).catch(() => ({ rows: [] }));

  return result.rows.map((row) => {
    const payload = parseJson(row.payload_json, {});
    const exam = (payload.exams || [])[0] || {};
    return {
      reportVersionId: row.id,
      username: row.username,
      school: row.school,
      submissionId: row.submission_id,
      studentId: row.student_id,
      publishedAt: row.published_at,
      examId: exam.id || null,
      examName: exam.name || null,
      subject: payload.term1?.subjects?.[0]?.name || null,
    };
  });
}

async function loadSynthesisRuns(db, { schoolId, studentId, limit = 12 }) {
  if (!studentId) return [];
  const result = await db.execute({
    sql: `SELECT id, status, trigger_source, input_signal_ids_json, diff_json, model,
                 synthesizer_version, error, started_at, completed_at
          FROM dna_synthesis_runs
          WHERE school_id = ? AND student_id = ?
          ORDER BY started_at DESC
          LIMIT ?`,
    args: [schoolId, studentId, limit],
  }).catch(() => ({ rows: [] }));

  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    triggerSource: row.trigger_source,
    inputSignalIds: parseJson(row.input_signal_ids_json, []),
    diff: parseJson(row.diff_json, null),
    model: row.model,
    synthesizerVersion: row.synthesizer_version,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

/**
 * @typedef {object} StudentContext
 * @property {string} studentId
 * @property {string} schoolId
 * @property {string} [username]
 * @property {string|null} name
 * @property {string|null} className
 * @property {string|null} school
 * @property {boolean} resolved  false when the student is not in `schoolId`; every data field is then empty
 * @property {object|null} dna
 * @property {number} examCount
 * @property {number} questionCount
 * @property {string|null} dnaUpdatedAt
 * @property {object[]} recentReports
 * @property {object[]} signals
 * @property {object[]} synthesisRuns
 * @property {object[]} mastery
 */

/**
 * Build a school-scoped student context pack for AI / Hive surfaces.
 *
 * @param {object} db
 * @param {{ schoolId: string, studentId?: string, username?: string, userId?: string, selfUsername?: string, signalLimit?: number, reportLimit?: number, runLimit?: number, includeUnreleased?: boolean }} identity
 *   includeUnreleased: staff callers only; students see reports and signals from released tests.
 *   selfUsername: the caller's own login, set only when they are reading their own profile.
 * @returns {Promise<StudentContext>}
 */
export async function buildStudentContext(db, identity = {}) {
  const schoolId = String(identity.schoolId || '').trim();
  if (!schoolId) throw new Error('schoolId is required');
  if (!db) throw new Error('database client is required');

  const resolved = await resolveStudentIdentity(db, identity);
  if (!resolved.resolved) {
    return {
      studentId: '', schoolId, username: undefined, name: null, className: null, school: null, resolved: false,
      dna: null, examCount: 0, questionCount: 0, dnaUpdatedAt: null,
      recentReports: [], signals: [], synthesisRuns: [], mastery: [],
    };
  }
  const [{ dna, examCount, questionCount, updatedAt }, signals, recentReports, synthesisRuns, mastery] = await Promise.all([
    loadDna(db, { ...resolved, schoolId }),
    loadSignals(db, { schoolId, studentId: resolved.studentId, limit: identity.signalLimit || 60, releasedOnly: !identity.includeUnreleased }),
    loadRecentReports(db, {
      schoolId,
      username: resolved.username,
      studentId: resolved.studentId,
      limit: identity.reportLimit || 8,
      releasedOnly: !identity.includeUnreleased,
    }),
    loadSynthesisRuns(db, {
      schoolId,
      studentId: resolved.studentId,
      limit: identity.runLimit || 12,
    }),
    loadMasteryEstimates(db, { schoolId, studentId: resolved.studentId }),
  ]);

  return {
    studentId: resolved.studentId,
    schoolId,
    username: resolved.username,
    name: resolved.name,
    className: resolved.className,
    school: resolved.school,
    resolved: true,
    dna,
    examCount,
    questionCount,
    dnaUpdatedAt: updatedAt,
    recentReports,
    signals,
    synthesisRuns,
    mastery,
  };
}

/**
 * Build a cohort/exam context pack for teacher AI.
 *
 * @param {object} db
 * @param {{ schoolId: string, examId?: string, testId?: string, className?: string, subject?: string }} scope
 * @returns {Promise<object>}
 */
export async function buildCohortContext(db, scope = {}) {
  const schoolId = String(scope.schoolId || '').trim();
  if (!schoolId) throw new Error('schoolId is required');
  if (!db) throw new Error('database client is required');

  const examId = String(scope.examId || '').trim();
  const testId = String(scope.testId || '').trim();
  const className = String(scope.className || '').trim();
  const subject = String(scope.subject || '').trim();

  const schoolRow = (await db.execute({
    sql: 'SELECT display_name FROM schools WHERE id = ? LIMIT 1',
    args: [schoolId],
  }).catch(() => ({ rows: [] }))).rows[0];

  const hotspotArgs = [schoolId];
  let hotspotSql = `SELECT topic, COUNT(*) AS n,
           SUM(CASE WHEN marks_total > 0 AND marks_obtained * 1.0 / marks_total < 0.5 THEN 1 ELSE 0 END) AS weak_n,
           GROUP_CONCAT(DISTINCT substr(misconception, 1, 80)) AS samples
    FROM evidence_signals
    WHERE school_id = ? AND status = 'active' AND topic IS NOT NULL AND TRIM(topic) != ''`;
  if (examId) {
    hotspotSql += ' AND exam_id = ?';
    hotspotArgs.push(examId);
  }
  hotspotSql += ' GROUP BY topic ORDER BY weak_n DESC, n DESC LIMIT 12';

  const hotspots = (await db.execute({
    sql: hotspotSql,
    args: hotspotArgs,
  }).catch(() => ({ rows: [] }))).rows.map((row) => ({
    topic: row.topic,
    signalCount: Number(row.n) || 0,
    weakCount: Number(row.weak_n) || 0,
    sampleMisconceptions: String(row.samples || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 3),
  }));

  const reportArgs = [schoolId];
  let reportSql = `SELECT COUNT(DISTINCT rv.submission_id) AS reports,
                          COUNT(DISTINCT rv.student_id) AS students,
                          MAX(rv.published_at) AS latest_published
                   FROM report_versions rv
                   JOIN schools sc ON sc.display_name = rv.school
                   WHERE sc.id = ? AND rv.status = 'published'`;
  if (examId) {
    reportSql += ' AND rv.exam_id = ?';
    reportArgs.push(examId);
  }
  const reportStats = (await db.execute({
    sql: reportSql,
    args: reportArgs,
  }).catch(() => ({ rows: [{}] }))).rows[0] || {};

  const dnaArgs = [schoolId];
  let dnaJoin = '';
  let dnaClause = '';
  if (className) {
    dnaJoin = `JOIN student_enrollments enrollment ON enrollment.student_id = dna.student_id AND enrollment.status = 'active'
               JOIN academic_years year ON year.id = enrollment.academic_year_id AND year.school_id = dna.school_id AND year.is_current = 1`;
    dnaClause = ' AND enrollment.standard = ?';
    dnaArgs.push(className);
  }
  const modeRows = (await db.execute({
    sql: `SELECT json_extract(dna.dna_json, '$.primary_mode.mode_id') AS mode_id, COUNT(*) AS n
          FROM learner_dna_v2 dna
          ${dnaJoin}
          WHERE dna.school_id = ?${dnaClause}
            AND json_extract(dna.dna_json, '$.primary_mode.mode_id') IS NOT NULL
          GROUP BY mode_id
          ORDER BY n DESC`,
    args: dnaArgs,
  }).catch(() => ({ rows: [] }))).rows;

  const signalTotal = (await db.execute({
    sql: `SELECT COUNT(*) AS n FROM evidence_signals WHERE school_id = ? AND status = 'active'`,
    args: [schoolId],
  }).catch(() => ({ rows: [{ n: 0 }] }))).rows[0]?.n || 0;

  const curriculum = subject
    ? (await db.execute({
      sql: `SELECT id, grade, topic FROM curriculum_standards
            WHERE LOWER(board) = 'cbse' AND LOWER(subject) = LOWER(?)
            ORDER BY grade, topic LIMIT 40`,
      args: [subject],
    }).catch(() => ({ rows: [] }))).rows
    : [];

  return {
    schoolId,
    schoolName: schoolRow?.display_name || null,
    examId,
    testId,
    className: className || null,
    subject: subject || null,
    overview: {
      publishedReports: Number(reportStats.reports) || 0,
      studentsWithReports: Number(reportStats.students) || 0,
      latestPublishedAt: reportStats.latest_published || null,
      activeSignals: Number(signalTotal) || 0,
      dnaProfiles: modeRows.reduce((sum, row) => sum + (Number(row.n) || 0), 0),
      primaryModes: modeRows.map((row) => ({
        modeId: row.mode_id,
        count: Number(row.n) || 0,
      })),
    },
    hotspots,
    curriculumTopics: curriculum.map((row) => ({
      id: row.id,
      grade: row.grade,
      topic: row.topic,
    })),
  };
}

export const EVIDENCE_MIN_SIGNALS = 5;
export const COHORT_MIN_SIGNALS = 10;

/**
 * Evidence gate for AI generation (“no data → no generation”).
 * Levels: 'none' (no DNA and no signals), 'thin' (below minimum), 'ok'.
 */
export function assessEvidenceReadiness(context = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const signals = Array.isArray(ctx.signals) ? ctx.signals.length : 0;
  const hasDna = Boolean(ctx.dna);
  const base = { signals, needed: EVIDENCE_MIN_SIGNALS };
  if (signals === 0 && !hasDna) {
    return { ...base, level: 'none', reason: 'No learning evidence yet. Signals are created after graded exams are processed.' };
  }
  if (signals < EVIDENCE_MIN_SIGNALS) {
    return { ...base, level: 'thin', reason: `Only ${signals} evidence signal${signals === 1 ? '' : 's'} available; at least ${EVIDENCE_MIN_SIGNALS} from graded exams are needed.` };
  }
  return { ...base, level: 'ok', reason: null };
}

/** Total signal volume backing cohort hotspots (teacher-side gate). */
export function cohortSignalCount(context = {}) {
  return (Array.isArray(context?.hotspots) ? context.hotspots : [])
    .reduce((sum, row) => sum + (Number(row.signalCount) || 0), 0);
}

export class InsufficientEvidenceError extends Error {
  constructor(evidence) {
    super(evidence?.reason || 'Insufficient learning evidence');
    this.name = 'InsufficientEvidenceError';
    this.evidence = evidence;
  }
}
