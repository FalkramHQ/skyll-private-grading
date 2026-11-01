// Published assessment reports in the CRM (FLKRM-326, CRM-009): the hub list
// and the in-place report panel, plus an extended profile view. All reads come
// from canonical tables — `submissions` and `report_versions` — so the CRM
// never double-counts legacy mirrors during the dual-write bake window.
//
// These handlers are registered under /api/auth/crm/reports/* with the
// `crm.reports.read` capability, scoped by the existing CRM request context.

import { z } from 'zod';
import { crmErrors } from './errors.js';

const LATEST = 90; // days: default horizon for the default list query.

const listQuery = z.object({
  batchId: z.string().max(128).optional(),
  examId: z.string().max(128).optional(),
  q: z.string().trim().max(120).optional(),
}).passthrough();

const detailQuery = z.object({ submissionId: z.string().min(1).max(128) });

// The router validates each route's query with these before calling the handler.
export { listQuery as reportListQuery, detailQuery };

/** One row per published submission: score, scope, and a review flag. */
function serializeListRow(row) {
  return {
    submissionId: row.submission_id,
    studentId: row.student_id,
    studentName: row.student_name,
    rosterKey: row.roster_key || null,
    reportUsername: row.username || null,
    examId: row.exam_id,
    examName: row.exam_name,
    subject: row.subject || null,
    batchId: row.batch_id,
    batchName: row.batch_name,
    score: row.score === null ? null : Number(row.score),
    maxMarks: row.max_marks === null ? null : Number(row.max_marks),
    publishedAt: row.published_at,
    reviewPending: Number(row.review_pending) === 1,
  };
}

async function studentsById(db, scope, ids) {
  if (!ids.length) return {};
  const inList = ids.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT s.id, s.display_name AS student_name, s.roster_key, su.id AS username
          FROM students s
          LEFT JOIN student_user_links sul ON sul.student_id = s.id AND sul.school_id = s.school_id
          LEFT JOIN users su ON su.id = sul.user_id
          WHERE s.id IN (${inList}) AND s.school_id = ?`,
    args: [...ids, scope.schoolId],
  });
  return Object.fromEntries(result.rows.map((row) => [row.id, row]));
}

/** `review_pending`: any question with a non-zero review revision OR an open
 * review decision. This is what a teacher flagged; the CRM shows the flag but
 * never grades or rechecks. */
async function reviewPendingFlags(db, scope, submissionIds) {
  if (!submissionIds.length) return {};
  const inList = submissionIds.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT submission_id, COUNT(*) AS flagged
          FROM submission_questions_v2 qv
          JOIN submissions s ON s.id = qv.submission_id AND s.school_id = qv.submission_id
          WHERE qv.submission_id IN (${inList}) AND s.school_id = ?
            AND (qv.review_revision > 0 OR EXISTS (
              SELECT 1 FROM question_reviews qr
              WHERE qr.submission_question_id = qv.id
                AND qr.state NOT IN ('approved', 'rejected')
            ))
          GROUP BY submission_id`,
    args: [...submissionIds, scope.schoolId],
  });
  return Object.fromEntries(result.rows.map((row) => [row.submission_id, Number(row.flagged)]));
}

/** Published report versions, one per submission, scoped to the chosen
 * filters. The default horizon keeps the common path small; every explicit
 * filter widens scope, never bypasses the 500-row cap. */
export async function listReports({ db, scope, input }) {
  const { batchId, examId, q } = listQuery.parse(input.query);
  const clauses = ['rv.status = ?', 'sub.school_id = ?'];
  const args = ['published', scope.schoolId];

  if (examId) {
    clauses.push('rv.exam_id = ?');
    args.push(examId);
  }
  if (batchId) {
    clauses.push(`sub.id IN (
      SELECT submission_id FROM submissions sb
      JOIN exam_batches eb ON eb.exam_id = sb.exam_id AND eb.school_id = sb.school_id
      JOIN exam_batches eb2 ON eb2.exam_id = sb.exam_id
      JOIN batch_memberships bm ON bm.batch_id = eb2.batch_id AND bm.school_id = sb.school_id
      WHERE eb2.batch_id = ? AND bm.student_id = sb.student_id AND bm.status = 'active'
    )`);
    args.push(batchId);
  }

  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    clauses.push(`EXISTS (
      SELECT 1 FROM students st
      WHERE st.id = sub.student_id AND st.school_id = ?
        AND (LOWER(st.display_name) LIKE LOWER(?) OR LOWER(st.roster_key) LIKE LOWER(?))
    )`);
    args.push(scope.schoolId, like, like);
  }

  const limit = 500;
  const result = await db.execute({
    sql: `SELECT sub.id AS submission_id, sub.student_id, sub.exam_id,
                 sub.score, sub.max_marks, rv.published_at,
                 st.display_name AS student_name, st.roster_key, su.id AS username,
                 e.name AS exam_name, sj.name AS subject, b.id AS batch_id, b.name AS batch_name,
                 COALESCE(rpf.flagged, 0) AS review_pending
          FROM submissions sub
          JOIN report_versions rv ON rv.submission_id = sub.id AND rv.status = 'published'
          JOIN students st ON st.id = sub.student_id AND st.school_id = sub.school_id
          LEFT JOIN student_user_links sul ON sul.student_id = sub.student_id AND sul.school_id = sub.school_id
          LEFT JOIN users su ON su.id = sul.user_id
          JOIN exams e ON e.id = sub.exam_id AND e.school_id = sub.school_id
          LEFT JOIN subjects sj ON sj.id = e.subject_id AND sj.school_id = e.school_id
          LEFT JOIN (
            SELECT sb.id AS submission_id, b.id AS batch_id
            FROM submissions sb
            JOIN exam_batches eb ON eb.exam_id = sb.exam_id AND eb.school_id = sb.school_id
            JOIN exam_batches eb2 ON eb2.exam_id = sb.exam_id
            JOIN batch_memberships bm ON bm.batch_id = eb2.batch_id AND bm.school_id = sb.school_id
            WHERE bm.status = 'active' AND bm.student_id = sb.student_id
          ) bb ON bb.submission_id = sub.id AND bb.school_id = sub.school_id
          LEFT JOIN batches b ON b.id = bb.batch_id AND b.school_id = sub.school_id
          LEFT JOIN (
            SELECT submission_id, COUNT(*) AS flagged
            FROM submission_questions_v2 qv
            JOIN submissions s ON s.id = qv.submission_id AND s.school_id = qv.submission_id
            WHERE qv.submission_id IN (${args.slice(2).map(() => '?').join(', ')})
              AND s.school_id = ?
              AND (qv.review_revision > 0 OR EXISTS (
                SELECT 1 FROM question_reviews qr
                WHERE qr.submission_question_id = qv.id
                  AND qr.state NOT IN ('approved', 'rejected')
              ))
            GROUP BY submission_id
          ) rpf ON rpf.submission_id = sub.id
          WHERE ${clauses.join(' AND ')}
          ORDER BY rv.published_at DESC, sub.id DESC
          LIMIT ${limit}`,
    args: [...args, scope.schoolId, ...args.slice(2), scope.schoolId, limit],
  });

  const ids = result.rows.map((row) => row.submission_id);
  const flags = ids.length ? await reviewPendingFlags(db, scope, ids) : {};
  const studentIds = [...new Set(ids.map((id) => {
    const row = result.rows.find((r) => r.submission_id === id);
    return row.student_id;
  }))];
  const students = studentIds.length ? await studentsById(db, scope, studentIds) : {};

  return {
    items: result.rows.map((row) => {
      const s = students[row.student_id] || {};
      const enriched = {
        ...serializeListRow(row),
        payloadJson: row.payload_json || null,
        reportUsername: s.username || null,
      };
      enriched.reviewPending = Number(flags[row.submission_id] || row.review_pending) > 0;
      return enriched;
    }),
    nextCursor: result.rows.length >= limit ? serializeCursor(limit) : null,
    filters: { batchId, examId, q },
  };
}

/** One published payload plus a per-section DTO for the report panel. The
 * payload is the exact published JSON (v2: term1.subjects/exams, learner_dna),
 * so the panel can render the full student-facing report verbatim. */
export async function getReportDetail({ db, scope, input }) {
  const { submissionId } = detailQuery.parse(input.query);

  const result = await db.execute({
    sql: `SELECT rv.id, rv.submission_id, rv.exam_id, rv.version, rv.payload_json,
                 rv.published_at, rv.username,
                 e.name AS exam_name, e.exam_date, sj.name AS subject,
                 sub.score, sub.max_marks, sub.status AS submission_status,
                 COALESCE(rpf.flagged, 0) AS review_pending,
                 (SELECT COUNT(*) FROM report_versions rv2
                  WHERE rv2.submission_id = rv.submission_id
                    AND rv2.version < rv.version) AS versionIndex
          FROM report_versions rv
          JOIN submissions sub ON sub.id = rv.submission_id AND sub.school_id = rv.school_id
          JOIN students st ON st.id = sub.student_id AND st.school_id = rv.school_id
          JOIN exams e ON e.id = rv.exam_id AND e.school_id = rv.school_id
          LEFT JOIN subjects sj ON sj.id = e.subject_id AND sj.school_id = rv.school_id
          LEFT JOIN (
            SELECT submission_id, COUNT(*) AS flagged
            FROM submission_questions_v2 qv
            JOIN submissions s ON s.id = qv.submission_id AND s.school_id = qv.submission_id
            WHERE qv.submission_id = ?
              AND s.school_id = ?
              AND (qv.review_revision > 0 OR EXISTS (
                SELECT 1 FROM question_reviews qr
                WHERE qr.submission_question_id = qv.id
                  AND qr.state NOT IN ('approved', 'rejected')
              ))
            GROUP BY submission_id
          ) rpf ON rpf.submission_id = rv.submission_id
          WHERE rv.submission_id = ? AND rv.status = 'published'
          ORDER BY rv.version DESC LIMIT 1`,
    args: [submissionId, scope.schoolId, submissionId, scope.schoolId],
  });

  if (!result.rows[0]) throw crmErrors.notFound();
  const row = result.rows[0];

  let payload;
  try {
    payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
  } catch {
    payload = {};
  }

  return {
    submissionId: row.submission_id,
    examId: row.exam_id,
    version: Number(row.version),
    versionIndex: Number(row.versionIndex),
    publishedAt: row.published_at,
    student: {
      id: row.submission_id, // legacy alias used by some callers
      name: row.student_name,
      rosterKey: row.roster_key,
      reportUsername: row.username,
    },
    exam: { id: row.exam_id, name: row.exam_name, date: row.exam_date, subject: row.subject },
    score: row.score === null ? null : Number(row.score),
    maxMarks: row.max_marks === null ? null : Number(row.max_marks),
    status: row.submission_status,
    reviewPending: Number(row.review_pending) > 0,
    payload,
    sections: buildSectionDTO(payload),
  };
}

/** Inline per-section DTOs so `students/detail` can fold them into the
 * progress rows — expanding a card makes zero extra network calls. */
export async function extendedStudentDetail({ db, scope, input }) {
  const { studentId } = z.object({ studentId: z.string().min(1).max(128) }).parse(input.query);

  const rows = await db.execute({
    sql: `SELECT rv.submission_id, rv.exam_id, rv.version, rv.payload_json, rv.published_at,
                 e.name AS exam_name, e.exam_date, sj.name AS subject,
                 sub.score, sub.max_marks, sub.status AS submission_status,
                 COALESCE(rpf.flagged, 0) AS review_pending
          FROM report_versions rv
          JOIN submissions sub ON sub.id = rv.submission_id AND sub.school_id = rv.school_id
          JOIN students st ON st.id = sub.student_id AND st.school_id = rv.school_id
          JOIN exams e ON e.id = rv.exam_id AND e.school_id = rv.school_id
          LEFT JOIN subjects sj ON sj.id = e.subject_id AND sj.school_id = rv.school_id
          LEFT JOIN (
            SELECT submission_id, COUNT(*) AS flagged
            FROM submission_questions_v2 qv
            JOIN submissions s ON s.id = qv.submission_id AND s.school_id = qv.submission_id
            WHERE qv.submission_id = rv.submission_id
              AND s.school_id = ?
              AND (qv.review_revision > 0 OR EXISTS (
                SELECT 1 FROM question_reviews qr
                WHERE qr.submission_question_id = qv.id
                  AND qr.state NOT IN ('approved', 'rejected')
              ))
            GROUP BY submission_id
          ) rpf ON rpf.submission_id = rv.submission_id
          WHERE rv.student_id = ? AND rv.school_id = ? AND rv.status = 'published'
          ORDER BY rv.published_at DESC`,
    args: [scope.schoolId, studentId, scope.schoolId],
  });

  return rows.rows.map((row) => {
    let payload;
    try {
      payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
    } catch {
      payload = {};
    }
    return {
      id: row.submission_id,
      examName: row.exam_name,
      subject: row.subject || null,
      date: row.published_at,
      score: row.score === null ? null : Number(row.score),
      maxMarks: row.max_marks === null ? null : Number(row.max_marks),
      status: row.submission_status,
      reviewStatus: null,
      reportPublished: true,
      reviewPending: Number(row.review_pending) > 0,
      payloadJson: row.payload_json,
      sections: buildSectionDTO(payload),
    };
  });
}

/** Build the section DTO the panel consumes from a published payload. */
function buildSectionDTO(payload) {
  if (!payload) return null;

  const rawSubjects = payload.subjects || payload.term1?.subjects || [];
  const subjects = rawSubjects
    .map((s) => ({
      name: s.name || s.subject,
      score: toNumber(s.score),
      maxMarks: toNumber(s.total) ?? toNumber(s.max_marks),
      pct:
        toNumber(s.score) !== null &&
        (toNumber(s.total) ?? toNumber(s.max_marks))
          ? Math.round(
              (toNumber(s.score) / (toNumber(s.total) ?? toNumber(s.max_marks))) * 100,
            )
          : null,
      sections: (Array.isArray(s.sections) ? s.sections : [])
        .map((sec) => ({
          name: sec.name,
          score: toNumber(sec.score),
          maxMarks: toNumber(sec.total) ?? toNumber(sec.max_marks),
          pct:
            sec.score !== null && sec.total
              ? Math.round((toNumber(sec.score) / toNumber(sec.total)) * 100)
              : null,
        }))
        .filter((sec) => sec.name),
      strengths: (Array.isArray(s.strengths) ? s.strengths : [])
        .map((st) => ({
          concept: st.concept || st.title,
          evidence: st.evidence || st.detail || '',
        }))
        .filter((st) => st.evidence || st.concept),
      misconceptions: (Array.isArray(s.misconceptions) ? s.misconceptions : [])
        .map((m) => ({
          issue: m.issue || m.title,
          what_student_did: m.what_student_did || '',
          what_this_means: m.what_this_means || '',
          impact: m.impact || '',
        }))
        .filter((m) => m.what_student_did || m.what_this_means),
      questions: (Array.isArray(s.questions) ? s.questions : [])
        .map((q) => ({
          number: q.number || q.question_number,
          summary: cleanLabel(q.summary || q.question_text || ''),
          marksObtained: toNumber(q.marks_obtained) ?? toNumber(q.score),
          marksTotal: toNumber(q.marks_total) ?? toNumber(q.total),
          status: q.status || (toNumber(q.marks_obtained) > 0 ? 'partial' : 'not_attempted'),
          question: q.question || q.question_text || '',
          student_answer: q.student_answer || q.response || '',
          correct_answer: q.correct_answer || q.answer || '',
          reasoning: q.grading_reason || q.diagnosis || '',
          parts: (Array.isArray(q.parts) ? q.parts : [])
            .map((p) => ({
              label: p.label || p.name,
              prompt: p.prompt || '',
              response: p.response || q.student_answer || '',
              marksObtained: toNumber(p.marks_obtained) ?? 0,
              marksTotal: toNumber(p.marks_total) ?? 0,
              status: ['correct', 'partial', 'incorrect', 'not_attempted'].includes(p.status)
                ? p.status
                : 'not_attempted',
            }))
            .filter((p) => p.marksTotal > 0),
        }))
        .filter((q) => q.number || q.summary),
      recommendations: (Array.isArray(s.recommendations) ? s.recommendations : [])
        .map((r) => ({
          topic: r.topic || r.title || '',
          action: r.action || r.strategy || '',
        }))
        .filter((r) => r.action),
    }))
    .filter((s) => s.name);

  const overall = payload.overall || {};
  const insights = payload.overall_insights || payload.insights || {};

  return {
    summary: {
      studentName: payload.student?.name || payload.student_name || 'Student',
      examTitle: payload.exam?.title || payload.exam?.name || payload.title || 'Assessment',
      examDate: payload.exam?.date || payload.generated_at || '',
      overallScore: toNumber(payload.overall?.score ?? payload.total_score),
      overallMax: toNumber(payload.overall?.max_marks ?? payload.total_max),
      overallPct:
        overall.score !== null && overall.max_marks
          ? Math.round((overall.score / overall.max_marks) * 100)
          : null,
      grade: payload.overall?.grade || payload.grade || '',
      status: payload.overall?.status || payload.status || '',
      caveat: payload.caveat || payload.low_confidence_caveat || '',
    },
    dna: normalizeInsights(insights),
    subjects,
  };
}

// ---- helpers ----

function toNumber(value) {
  return value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? null
    : Number(value);
}

function cleanLabel(value) {
  let text = String(value || '');
  text = text.replace(/^#{1,6}\s*/gm, '').replace(/\\n/g, ' ').replace(/\*\*/g, '');
  text = text.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+[.)]\s+/, '');
  text = text.replace(/\s+/g, ' ').replace(/\s+([:;,.])/g, '$1').replace(/[:.]$/, '').trim();
  return text;
}

function normalizeInsights(insights = {}) {
  const patterns = Array.isArray(insights.patterns) ? insights.patterns : [];
  const learningStyle =
    insights.learning_style ||
    insights.primary_mode?.description ||
    insights.pattern ||
    '';
  const nextMove = insights.next_move?.action
    ? { title: insights.next_move.title || '', action: insights.next_move.action }
    : null;
  return {
    patterns: patterns.map((p) => (typeof p === 'string' ? p : p.text || '')).filter(Boolean),
    learningStyle: cleanLabel(learningStyle),
    nextMove,
  };
}

/** Cursor helper for list pagination. The hub list is capped at 500; a cursor
 * signals "more" without exposing an offset. */
function serializeCursor(after) {
  return Buffer.from(JSON.stringify({ cursor: after })).toString('base64');
}
