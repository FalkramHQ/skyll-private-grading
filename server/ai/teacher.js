import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { resolveSchoolId } from '../../api/_lib/canonicalSubmissions.js';
import { checkRateLimit } from '../../api/_lib/rateLimit.js';
import { InsufficientEvidenceError } from '../../api/_lib/contextBuilder.js';
import { handleCors } from '../../api/_lib/cors.js';
import { internalError } from '../../api/_lib/httpError.js';
import {
  generateBriefing,
  generateInterventions,
  generateLessonPlan,
  generateParentReport,
  generateQuiz,
  runTeacherCopilot,
} from '../../api/_lib/teacherAi.js';
import { listEarlyWarnings } from '../../api/_lib/earlyWarning.js';
import { computeCurriculumCoverage } from '../../api/_lib/curriculumCoverage.js';
import { listAiArtifacts, saveAiArtifact } from '../../api/_lib/aiArtifacts.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

async function schoolIdForUser(db, user) {
  if (user.school_id) return user.school_id;
  if (!user.school) return null;
  return resolveSchoolId(db, user.school);
}

async function teacherGate(req, res) {
  await ensureAuthTables();
  const user = await requireUser(req, res, ['teacher', 'admin', 'skyll_admin']);
  if (!user) return null;
  const db = database();
  const schoolId = await schoolIdForUser(db, user);
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? parseBody(req) : {};
  const scopedSchoolId = String(
    body.schoolId || req.query?.schoolId || schoolId || '',
  ).trim();
  if (!scopedSchoolId && user.role !== 'skyll_admin') {
    res.status(403).json({ error: 'School access denied' });
    return null;
  }
  if (!scopedSchoolId) {
    res.status(400).json({ error: 'schoolId is required' });
    return null;
  }
  if (user.role !== 'skyll_admin' && scopedSchoolId !== schoolId) {
    res.status(403).json({ error: 'School access denied' });
    return null;
  }
  return { user, db, schoolId: scopedSchoolId, body };
}

function scopeFrom(body, query = {}) {
  return {
    className: String(body.className || body.cls || query.class || query.cls || '').trim() || null,
    subject: String(body.subject || query.subject || '').trim() || null,
    examId: String(body.examId || query.examId || '').trim() || null,
    topic: String(body.topic || '').trim() || null,
  };
}

async function persistArtifact(db, { user, schoolId, type, scope, payload }) {
  try {
    await saveAiArtifact(db, {
      schoolId,
      userId: user.user_id,
      type,
      scope,
      payload,
    });
  } catch {
    /* persistence is best-effort; never block generation */
  }
}

/** POST /api/ai/copilot */
export async function postCopilot(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const gate = await teacherGate(req, res);
    if (!gate) return;
    const { user, db, schoolId, body } = gate;
    if (await checkRateLimit(`copilot:${user.user_id || user.username}`, { max: 20, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many copilot requests. Try again shortly.' });
    }
    const question = String(body.question || body.message || '').trim();
    if (!question) return res.status(400).json({ error: 'question is required' });
    if (question.length > 2000) return res.status(400).json({ error: 'question is too long' });
    const scope = scopeFrom(body);
    const result = await runTeacherCopilot(db, {
      schoolId,
      question,
      className: scope.className,
      subject: scope.subject,
      examId: scope.examId,
      history: Array.isArray(body.history) ? body.history : [],
    });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof InsufficientEvidenceError) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ ok: false, reason: 'insufficient_data', evidence: error.evidence });
    }
    return internalError(res, error, 'ai/copilot');
  }
}

/** POST /api/ai/lesson-plan */
export async function postLessonPlan(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const gate = await teacherGate(req, res);
    if (!gate) return;
    const { user, db, schoolId, body } = gate;
    if (await checkRateLimit(`lesson:${user.user_id || user.username}`, { max: 12, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many lesson-plan requests. Try again shortly.' });
    }
    const scope = scopeFrom(body);
    const plan = await generateLessonPlan(db, {
      schoolId,
      subject: scope.subject || 'Mathematics',
      topic: scope.topic,
      className: scope.className,
      examId: scope.examId,
    });
    await persistArtifact(db, { user, schoolId, type: 'lesson_plan', scope, payload: plan });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ plan });
  } catch (error) {
    if (error instanceof InsufficientEvidenceError) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ ok: false, reason: 'insufficient_data', evidence: error.evidence });
    }
    return internalError(res, error, 'ai/lesson-plan');
  }
}

/** POST /api/ai/quiz-gen */
export async function postQuizGen(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const gate = await teacherGate(req, res);
    if (!gate) return;
    const { user, db, schoolId, body } = gate;
    if (await checkRateLimit(`quiz:${user.user_id || user.username}`, { max: 12, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many quiz-gen requests. Try again shortly.' });
    }
    const scope = scopeFrom(body);
    const topics = Array.isArray(body.topics)
      ? body.topics
      : String(body.topic || '')
        .split('|')
        .map((topic) => topic.trim())
        .filter(Boolean);
    const quiz = await generateQuiz(db, {
      schoolId,
      subject: scope.subject || 'Mathematics',
      topics: topics.length ? topics : null,
      className: scope.className,
      count: Number(body.count) || 5,
      persistBank: body.persistBank !== false,
    });
    await persistArtifact(db, { user, schoolId, type: 'quiz', scope, payload: quiz });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(201).json({ quiz });
  } catch (error) {
    if (error instanceof InsufficientEvidenceError) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ ok: false, reason: 'insufficient_data', evidence: error.evidence });
    }
    return internalError(res, error, 'ai/quiz-gen');
  }
}

/** GET|POST /api/ai/briefing — morning briefing (client may cache for the day). */
export async function briefing(req, res) {
  if (handleCors(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    const gate = await teacherGate(req, res);
    if (!gate) return;
    const { user, db, schoolId, body } = gate;
    if (await checkRateLimit(`briefing:${user.user_id || user.username}`, { max: 10, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many briefing requests. Try again shortly.' });
    }
    const scope = scopeFrom(body, req.query || {});
    const result = await generateBriefing(db, {
      schoolId,
      className: scope.className,
      subject: scope.subject,
      examId: scope.examId,
    });
    const warnings = await listEarlyWarnings(db, {
      schoolId,
      examId: scope.examId,
      status: 'open',
      limit: 12,
    }).catch(() => []);
    const watchNames = warnings.slice(0, 5).map((row) => row.studentName || row.username).filter(Boolean);
    const briefing = {
      ...result,
      warnings,
      watch_students_hint: watchNames.length
        ? `Watch: ${watchNames.join(', ')}${warnings.length > watchNames.length ? ` (+${warnings.length - watchNames.length} more)` : ''}`
        : result.watch_students_hint,
    };
    res.setHeader('Cache-Control', 'private, max-age=1800');
    return res.status(200).json({ briefing });
  } catch (error) {
    if (error instanceof InsufficientEvidenceError) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ ok: false, reason: 'insufficient_data', evidence: error.evidence });
    }
    return internalError(res, error, 'ai/briefing');
  }
}

/** POST /api/ai/intervention */
export async function postIntervention(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const gate = await teacherGate(req, res);
    if (!gate) return;
    const { user, db, schoolId, body } = gate;
    if (await checkRateLimit(`intervention:${user.user_id || user.username}`, { max: 12, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many intervention requests. Try again shortly.' });
    }
    const scope = scopeFrom(body);
    const result = await generateInterventions(db, {
      schoolId,
      className: scope.className,
      subject: scope.subject,
      examId: scope.examId,
    });
    await persistArtifact(db, { user, schoolId, type: 'intervention', scope, payload: result });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof InsufficientEvidenceError) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ ok: false, reason: 'insufficient_data', evidence: error.evidence });
    }
    return internalError(res, error, 'ai/intervention');
  }
}

/** GET /api/ai/warnings — open early-warning flags for the school/exam. */
export async function getWarnings(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const gate = await teacherGate(req, res);
    if (!gate) return;
    const { user, db, schoolId } = gate;
    if (await checkRateLimit(`warnings:${user.user_id || user.username}`, { max: 30, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many warning requests. Try again shortly.' });
    }
    const scope = scopeFrom({}, req.query || {});
    const warnings = await listEarlyWarnings(db, {
      schoolId,
      examId: scope.examId,
      status: String(req.query?.status || 'open'),
      limit: Number(req.query?.limit) || 40,
    });
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json({ warnings, count: warnings.length });
  } catch (error) {
    return internalError(res, error, 'ai/warnings');
  }
}

/** GET /api/ai/coverage — syllabus chapters tested vs missing. */
export async function getCoverage(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const gate = await teacherGate(req, res);
    if (!gate) return;
    const { user, db, schoolId } = gate;
    if (await checkRateLimit(`coverage:${user.user_id || user.username}`, { max: 20, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many coverage requests. Try again shortly.' });
    }
    const scope = scopeFrom({}, req.query || {});
    const coverage = await computeCurriculumCoverage(db, {
      schoolId,
      board: String(req.query?.board || 'CBSE').trim() || 'CBSE',
      grade: String(req.query?.grade || '').trim() || null,
      subject: scope.subject,
      examId: scope.examId,
      includeProposed: String(req.query?.includeProposed || '') === '1',
    });
    res.setHeader('Cache-Control', 'private, max-age=120');
    return res.status(200).json({ coverage });
  } catch (error) {
    return internalError(res, error, 'ai/coverage');
  }
}

/** GET /api/ai/artifacts — persisted teacher AI artifacts. */
export async function getArtifacts(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const gate = await teacherGate(req, res);
    if (!gate) return;
    const { user, db, schoolId } = gate;
    if (await checkRateLimit(`artifacts:${user.user_id || user.username}`, { max: 30, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many artifact requests. Try again shortly.' });
    }
    const artifacts = await listAiArtifacts(db, {
      schoolId,
      userId: user.user_id,
      type: String(req.query?.type || '').trim() || null,
      limit: req.query?.limit,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ artifacts });
  } catch (error) {
    return internalError(res, error, 'ai/artifacts');
  }
}

/** POST /api/ai/parent-report — draft parent update (review-before-send). */
export async function postParentReport(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const gate = await teacherGate(req, res);
    if (!gate) return;
    const { user, db, schoolId, body } = gate;
    if (await checkRateLimit(`parent:${user.user_id || user.username}`, { max: 12, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many parent-report requests. Try again shortly.' });
    }
    const username = String(body.username || '').trim() || null;
    const studentId = String(body.studentId || '').trim() || null;
    if (!username && !studentId) {
      return res.status(400).json({ error: 'username or studentId is required' });
    }
    const scope = {
      ...scopeFrom(body),
      username,
      studentId,
    };
    const draft = await generateParentReport(db, {
      schoolId,
      username,
      studentId,
      subject: scope.subject,
      examId: scope.examId,
      tone: String(body.tone || 'supportive').trim() || 'supportive',
    });
    await persistArtifact(db, {
      user,
      schoolId,
      type: 'parent_report',
      scope,
      payload: draft,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ draft });
  } catch (error) {
    if (error instanceof InsufficientEvidenceError) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ ok: false, reason: 'insufficient_data', evidence: error.evidence });
    }
    return internalError(res, error, 'ai/parent-report');
  }
}

export default postCopilot;
