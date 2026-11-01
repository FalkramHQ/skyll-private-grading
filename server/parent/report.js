import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { resolveSubmissionOwner, submissionVisibleTo } from './contact.js';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { checkRateLimit } from '../../api/_lib/rateLimit.js';
import { releasedExamSql } from '../../api/_lib/studentRelease.js';
import { isTokenShape, openLink } from '../comms/links.js';
import { clientAddress } from '../crm/inquiry.js';

const TOKEN_EXPIRY_DAYS = 30;

const toNumber = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const textList = (value) => (Array.isArray(value) ? value : []).map((item) => (typeof item === 'string' ? item : item?.text || item?.topic || '')).filter(Boolean);

// Published payloads are schema v2 (`term1.subjects`, `exams[]`, v2 learner DNA);
// older v1 payloads kept subjects at the top level. Read both.
export function toParentView(payload = {}, token = {}) {
  const rawSubjects = payload.subjects || payload.term1?.subjects || payload.term1_subjects || [];
  const subjects = rawSubjects.map((s) => {
    const score = toNumber(s.score);
    const maxMarks = toNumber(s.max_marks ?? s.total);
    return {
      name: s.name || s.subject,
      score,
      maxMarks,
      percentage: toNumber(s.percentage) ?? (score !== null && maxMarks ? Math.round((score / maxMarks) * 100) : null),
      grade: s.grade || '',
      strengths: textList(s.strengths).slice(0, 3),
      improvements: textList(s.improvements || s.misconceptions).slice(0, 3),
      practice: (Array.isArray(s.recommendations) ? s.recommendations : [])
        .map((r) => ({ topic: r?.topic || '', action: r?.action || (typeof r === 'string' ? r : '') }))
        .filter((r) => r.action)
        .slice(0, 3),
    };
  });
  const scored = subjects.filter((s) => s.score !== null && s.maxMarks);
  const exam = payload.exam || payload.exams?.[0] || {};
  const dna = payload.learner_dna || null;
  return {
    studentName: payload.student?.name || payload.student_name || token.student_name || 'Student',
    schoolName: payload.student?.school || payload.school || token.school_name || '',
    className: payload.student?.class || payload.student?.grade || '',
    examTitle: exam.title || exam.name || payload.title || 'Assessment',
    examDate: exam.date || payload.generated_at || '',
    overallScore: toNumber(payload.overall?.score ?? payload.total_score) ?? (scored.length ? scored.reduce((sum, s) => sum + s.score, 0) : null),
    overallMax: toNumber(payload.overall?.max_marks ?? payload.total_max) ?? (scored.length ? scored.reduce((sum, s) => sum + s.maxMarks, 0) : null),
    overallGrade: payload.overall?.grade || payload.grade || '',
    subjects,
    learnerDna: dna ? {
      patterns: textList(dna.patterns),
      learningStyle: dna.learning_style || dna.primary_mode?.description || '',
      nextMove: dna.next_move?.action ? { title: dna.next_move.title || '', action: dna.next_move.action } : null,
    } : null,
  };
}

export async function ensureParentReportTables() {
  const db = database();
  await db.execute(`CREATE TABLE IF NOT EXISTS parent_report_tokens (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    submission_id TEXT NOT NULL,
    student_name TEXT,
    school_name TEXT,
    expires_at TEXT NOT NULL,
    opened_at TEXT,
    open_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS parent_report_tokens_token_idx ON parent_report_tokens (token)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS parent_report_tokens_submission_idx ON parent_report_tokens (submission_id)`);
}

export async function generateParentToken(submissionId, studentName, schoolName) {
  await ensureAuthTables();
  await ensureParentReportTables();
  const db = database();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  // Check if a valid token already exists for this submission
  const existing = await db.execute({
    sql: 'SELECT token, expires_at FROM parent_report_tokens WHERE submission_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
    args: [submissionId, now.toISOString()],
  });
  if (existing.rows.length > 0) {
    return { token: existing.rows[0].token, expiresAt: existing.rows[0].expires_at, isNew: false };
  }

  const raw = randomUUID() + '-' + submissionId + '-' + now.getTime();
  const token = createHash('sha256').update(raw).digest('base64url').slice(0, 32);

  await db.execute({
    sql: `INSERT INTO parent_report_tokens (id, token, submission_id, student_name, school_name, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [`prt_${randomUUID()}`, token, submissionId, studentName || null, schoolName || null, expiresAt.toISOString(), now.toISOString()],
  });

  return { token, expiresAt: expiresAt.toISOString(), isNew: true };
}

export async function validateParentToken(token) {
  await ensureParentReportTables();
  const db = database();
  const result = await db.execute({
    sql: 'SELECT submission_id, student_name, school_name, expires_at, opened_at, open_count FROM parent_report_tokens WHERE token = ?',
    args: [token],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

export async function recordParentOpen(token) {
  const db = database();
  await db.execute({
    sql: `UPDATE parent_report_tokens SET open_count = open_count + 1, opened_at = ? WHERE token = ?`,
    args: [new Date().toISOString(), token],
  });
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    // Generate a token (admin/teacher only)
    const user = await requireUser(req, res, ['skyll_admin', 'admin', 'teacher']);
    if (!user) return;
    const { submissionId, studentName, schoolName } = req.body || {};
    if (!submissionId) return res.status(400).json({ error: 'submissionId required' });
    // The link is public and serves the full report, so only mint it for a
    // submission in the caller's school (FLKRM-381). Another school's
    // submission is indistinguishable from a missing one.
    const owner = await resolveSubmissionOwner(submissionId);
    if (!(await submissionVisibleTo(owner, user))) return res.status(404).json({ error: 'Submission not found' });
    const scopedSchoolName = user.role === 'skyll_admin' ? (schoolName || owner.schoolName || user.school) : user.school;
    const result = await generateParentToken(submissionId, studentName, scopedSchoolName);
    return res.status(201).json(result);
  }

  if (req.method === 'GET') {
    // Validate a token and return report data (public)
    const { token } = req.query;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!token) return res.status(400).json({ error: 'Token required' });

    // CRM M2 phase 2 (D10): opening report links is rate-limited per address and per link.
    const [byAddress, byLink] = await Promise.all([
      checkRateLimit(`parent-link:${clientAddress(req)}`, { max: 60, windowMs: 60_000 }),
      checkRateLimit(`parent-link:${createHash('sha256').update(String(token)).digest('hex').slice(0, 32)}`, { max: 30, windowMs: 60_000 }),
    ]);
    if (byAddress || byLink) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });

    // Links sent on WhatsApp are stored hashed and can be revoked (crm_access_links);
    // older links still in parent_report_tokens work until they expire.
    let valid = null;
    if (isTokenShape(token)) {
      const { link, problem } = await openLink(database(), token, 'report');
      if (problem === 'expired' || problem === 'revoked') return res.status(410).json({ error: 'This link is no longer active. Ask the class for a new one.' });
      if (link) {
        const names = await database().execute({
          sql: 'SELECT st.display_name, sc.display_name AS school_name FROM students st LEFT JOIN schools sc ON sc.id = st.school_id WHERE st.id = ?',
          args: [link.student_id],
        });
        valid = { submission_id: link.submission_id, student_name: names.rows[0]?.display_name || null, school_name: names.rows[0]?.school_name || null, expires_at: link.expires_at };
      }
    }
    if (!valid) {
      valid = await validateParentToken(token);
      if (!valid) return res.status(401).json({ error: 'Invalid or expired link' });
      // Record the open
      await recordParentOpen(token);
    }

    // Fetch the report. Parents, like students, see it only once a teacher
    // has released the test.
    const db = database();
    const reportResult = await db.execute({
      sql: `SELECT payload_json, username, school FROM report_versions
            WHERE submission_id = ? AND status = ? AND ${releasedExamSql('report_versions.exam_id')}
            ORDER BY version DESC LIMIT 1`,
      args: [valid.submission_id, 'published'],
    });

    if (reportResult.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }

    const report = reportResult.rows[0];
    let payload;
    try {
      payload = typeof report.payload_json === 'string' ? JSON.parse(report.payload_json) : report.payload_json;
    } catch {
      payload = {};
    }

    const parentView = toParentView(payload, valid);

    return res.status(200).json({ report: parentView, expiresAt: valid.expires_at });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
