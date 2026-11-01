/**
 * Deterministic early-warning detection after report publish.
 * Flags big score drops, zero-heavy scripts, and weak topic clusters.
 */

import { randomUUID } from 'node:crypto';

const DROP_POINTS = 15;
const ZERO_RATIO = 0.4;
const MIN_ZEROS = 3;
const WEAK_TOPIC_PCT = 40;

function text(value) {
  return String(value || '').trim();
}

function id(prefix = 'ew') {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function pct(score, total) {
  const denominator = Number(total) || 0;
  if (denominator <= 0) return null;
  return Math.round(((Number(score) || 0) / denominator) * 1000) / 10;
}

function subjectFromReport(report) {
  return report?.term1?.subjects?.[0] || null;
}

function scorePctFromReport(report) {
  const subject = subjectFromReport(report);
  if (!subject) return null;
  return pct(subject.score, subject.total);
}

function questionsFromReport(report) {
  const subject = subjectFromReport(report);
  return Array.isArray(subject?.questions) ? subject.questions : [];
}

/**
 * Pure evaluation — no DB. Returns null when the student is not at risk.
 *
 * @param {{ questions?: object[], score?: number, total?: number, priorPct?: number|null }} input
 */
export function evaluateEarlyWarning(input = {}) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const scorePct = pct(input.score, input.total);
  const priorPct = input.priorPct == null || Number.isNaN(Number(input.priorPct))
    ? null
    : Number(input.priorPct);

  const attempted = questions.filter((question) => {
    const status = text(question.status).toLowerCase();
    if (status === 'not_attempted') return false;
    return Number(question.marks_total || 0) > 0;
  });
  const zeros = attempted.filter((question) => Number(question.marks_obtained || 0) === 0);
  const zeroCount = zeros.length;
  const zeroRatio = attempted.length ? zeroCount / attempted.length : 0;

  const byTopic = new Map();
  for (const question of attempted) {
    const topic = text(question.topic) || 'General';
    const bucket = byTopic.get(topic) || { topic, obtained: 0, total: 0, zeros: 0 };
    bucket.obtained += Number(question.marks_obtained || 0);
    bucket.total += Number(question.marks_total || 0);
    bucket.zeros += Number(question.marks_obtained || 0) === 0 ? 1 : 0;
    byTopic.set(topic, bucket);
  }
  const weakTopics = [...byTopic.values()]
    .map((row) => ({
      topic: row.topic,
      pct: pct(row.obtained, row.total),
      zeros: row.zeros,
      questions: Math.max(1, Math.round(row.total > 0 ? row.total : 1)),
    }))
    .filter((row) => row.pct != null && row.pct < WEAK_TOPIC_PCT)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, 5);

  const reasons = [];
  if (scorePct != null && priorPct != null && scorePct <= priorPct - DROP_POINTS) {
    reasons.push({
      code: 'score_drop',
      detail: `Score dropped ${Math.round(priorPct - scorePct)} pts (${priorPct}% → ${scorePct}%).`,
      meta: { priorPct, scorePct, drop: Math.round((priorPct - scorePct) * 10) / 10 },
    });
  }
  if (zeroCount >= MIN_ZEROS || (attempted.length >= 4 && zeroRatio >= ZERO_RATIO)) {
    reasons.push({
      code: 'many_zeros',
      detail: `${zeroCount} zero-mark question${zeroCount === 1 ? '' : 's'} of ${attempted.length} attempted.`,
      meta: { zeroCount, attempted: attempted.length, zeroRatio: Math.round(zeroRatio * 100) / 100 },
    });
  }
  if (weakTopics.length >= 2 || (weakTopics.length === 1 && weakTopics[0].pct <= 25)) {
    reasons.push({
      code: 'weak_topics',
      detail: `Weak topics: ${weakTopics.map((row) => `${row.topic} (${row.pct}%)`).join(', ')}.`,
      meta: { topics: weakTopics },
    });
  }

  if (!reasons.length) return null;

  const severity = reasons.some((reason) => reason.code === 'score_drop')
    || zeroRatio >= 0.6
    || (scorePct != null && scorePct < 35)
    ? 'at_risk'
    : 'watch';

  return {
    severity,
    reasons,
    scorePct,
    priorPct,
    zeroCount,
    questionCount: attempted.length,
    weakTopics,
  };
}

async function loadPriorScorePct(db, { studentId, examId, submissionId }) {
  if (!studentId) return null;
  const result = await db.execute({
    sql: `SELECT payload_json, exam_id, submission_id
          FROM report_versions
          WHERE student_id = ?
            AND status = 'published'
            AND submission_id != ?
          ORDER BY COALESCE(published_at, generated_at) DESC
          LIMIT 8`,
    args: [studentId, submissionId || ''],
  }).catch(() => ({ rows: [] }));

  for (const row of result.rows) {
    if (examId && row.exam_id === examId) continue;
    const prior = scorePctFromReport(JSON.parse(row.payload_json || '{}'));
    if (prior != null) return prior;
  }
  return null;
}

/**
 * Evaluate + upsert an open warning for this submission (idempotent per submission).
 * Clears any open warning when the student no longer meets thresholds.
 */
export async function detectAndStoreEarlyWarning(db, {
  schoolId,
  studentId,
  examId = null,
  submissionId = null,
  username = null,
  studentName = null,
  report = null,
  at = new Date().toISOString(),
} = {}) {
  if (!db) throw new Error('database client is required');
  if (!schoolId || !studentId) throw new Error('schoolId and studentId are required');

  const subject = subjectFromReport(report);
  const questions = questionsFromReport(report);
  const priorPct = await loadPriorScorePct(db, { studentId, examId, submissionId });
  const evaluation = evaluateEarlyWarning({
    questions,
    score: subject?.score,
    total: subject?.total,
    priorPct,
  });

  const existing = await db.execute({
    sql: `SELECT id FROM early_warnings
          WHERE school_id = ? AND submission_id = ? AND status = 'open'
          ORDER BY created_at DESC LIMIT 1`,
    args: [schoolId, submissionId || ''],
  }).catch(() => ({ rows: [] }));

  if (!evaluation) {
    if (existing.rows[0]?.id) {
      await db.execute({
        sql: `UPDATE early_warnings SET status = 'resolved', updated_at = ? WHERE id = ?`,
        args: [at, existing.rows[0].id],
      });
      return { warning: null, resolved: true, warningId: existing.rows[0].id };
    }
    return { warning: null, resolved: false };
  }

  const payload = {
    id: existing.rows[0]?.id || id('ew'),
    schoolId,
    studentId,
    examId,
    submissionId,
    username: text(username) || null,
    studentName: text(studentName) || null,
    severity: evaluation.severity,
    reasons: evaluation.reasons,
    scorePct: evaluation.scorePct,
    priorPct: evaluation.priorPct,
    zeroCount: evaluation.zeroCount,
    questionCount: evaluation.questionCount,
  };

  if (existing.rows[0]?.id) {
    await db.execute({
      sql: `UPDATE early_warnings
            SET severity = ?, reasons_json = ?, score_pct = ?, prior_score_pct = ?,
                zero_count = ?, question_count = ?, username = ?, student_name = ?,
                exam_id = ?, updated_at = ?
            WHERE id = ?`,
      args: [
        payload.severity,
        JSON.stringify(payload.reasons),
        payload.scorePct,
        payload.priorPct,
        payload.zeroCount,
        payload.questionCount,
        payload.username,
        payload.studentName,
        payload.examId,
        at,
        payload.id,
      ],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO early_warnings (
              id, school_id, student_id, exam_id, submission_id, username, student_name,
              severity, reasons_json, score_pct, prior_score_pct, zero_count, question_count,
              status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      args: [
        payload.id,
        payload.schoolId,
        payload.studentId,
        payload.examId,
        payload.submissionId,
        payload.username,
        payload.studentName,
        payload.severity,
        JSON.stringify(payload.reasons),
        payload.scorePct,
        payload.priorPct,
        payload.zeroCount,
        payload.questionCount,
        at,
        at,
      ],
    });
  }

  return { warning: payload, resolved: false, warningId: payload.id };
}

export async function listEarlyWarnings(db, {
  schoolId,
  examId = null,
  status = 'open',
  limit = 40,
} = {}) {
  if (!db) throw new Error('database client is required');
  if (!schoolId) throw new Error('schoolId is required');

  const clauses = ['school_id = ?'];
  const args = [schoolId];
  if (status) {
    clauses.push('status = ?');
    args.push(status);
  }
  if (examId) {
    clauses.push('exam_id = ?');
    args.push(examId);
  }
  args.push(Math.max(1, Math.min(100, Number(limit) || 40)));

  const result = await db.execute({
    sql: `SELECT id, school_id, student_id, exam_id, submission_id, username, student_name,
                 severity, reasons_json, score_pct, prior_score_pct, zero_count, question_count,
                 status, created_at, updated_at
          FROM early_warnings
          WHERE ${clauses.join(' AND ')}
          ORDER BY CASE severity WHEN 'at_risk' THEN 0 ELSE 1 END, created_at DESC
          LIMIT ?`,
    args,
  }).catch(() => ({ rows: [] }));

  return result.rows.map((row) => {
    let reasons = [];
    try { reasons = JSON.parse(row.reasons_json || '[]'); } catch { reasons = []; }
    return {
      id: row.id,
      schoolId: row.school_id,
      studentId: row.student_id,
      examId: row.exam_id,
      submissionId: row.submission_id,
      username: row.username,
      studentName: row.student_name,
      severity: row.severity,
      reasons,
      scorePct: row.score_pct == null ? null : Number(row.score_pct),
      priorPct: row.prior_score_pct == null ? null : Number(row.prior_score_pct),
      zeroCount: Number(row.zero_count || 0),
      questionCount: Number(row.question_count || 0),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}
