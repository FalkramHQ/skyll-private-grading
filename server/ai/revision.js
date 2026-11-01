import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { resolveSchoolId } from '../../api/_lib/canonicalSubmissions.js';
import { checkRateLimit } from '../../api/_lib/rateLimit.js';
import { checkAiRateLimit, getStudentTier } from '../../api/_lib/aiRateLimitTiers.js';
import { InsufficientEvidenceError } from '../../api/_lib/contextBuilder.js';
import { handleCors } from '../../api/_lib/cors.js';
import { internalError } from '../../api/_lib/httpError.js';
import { generateRevisionPlan, listRevisionPlans, saveRevisionPlan } from '../../api/_lib/revisionPlan.js';

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

/** POST /api/ai/revision — generate an evidence-bound revision plan. */
export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['student', 'teacher', 'admin', 'skyll_admin']);
    if (!user) return;

    if (await checkRateLimit(`revision:${user.user_id || user.username}`, { max: 12, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many revision requests. Try again shortly.' });
    }

    const db = database();
    const schoolId = await schoolIdForUser(db, user);
    const body = parseBody(req);
    const scopedSchoolId = String(body.schoolId || schoolId || '').trim();
    if (!scopedSchoolId) return res.status(400).json({ error: 'schoolId is required' });
    if (user.role !== 'skyll_admin' && scopedSchoolId !== schoolId) {
      return res.status(403).json({ error: 'School access denied' });
    }

    if (req.method === 'GET') {
      if (!req.query?.list) return res.status(400).json({ error: 'list=1 is required' });
      const requestedUsername = String(req.query?.username || '').trim();
      const staff = ['teacher', 'admin', 'skyll_admin'].includes(user.role);
      if (requestedUsername && requestedUsername !== user.username && !staff) {
        return res.status(403).json({ error: 'You do not have permission for this student' });
      }
      const username = user.role === 'student' ? user.username : requestedUsername || null;
      const plans = await listRevisionPlans(db, {
        schoolId: scopedSchoolId,
        username,
        limit: req.query?.limit,
      });
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ plans });
    }

    const requestedUsername = String(body.username || body.student || '').trim();
    const staff = ['teacher', 'admin', 'skyll_admin'].includes(user.role);
    if (requestedUsername && requestedUsername !== user.username && !staff) {
      return res.status(403).json({ error: 'You do not have permission for this student' });
    }

    // Each plan is a model call; students get a daily fair-use quota like
    // tutor and practice. Staff are exempt.
    if (user.role === 'student') {
      const tier = await getStudentTier(db, { userId: user.user_id, schoolId: scopedSchoolId });
      const quota = await checkAiRateLimit(user.user_id || user.username, 'revision', tier);
      if (quota.limited) {
        return res.status(429).json({
          error: `Daily revision plan limit reached (${quota.limit}/day on your plan). Try again tomorrow.`,
          limit: quota.limit, used: quota.used, tier,
        });
      }
    }

    const planSubject = String(body.subject || 'Mathematics').trim() || 'Mathematics';
    // Students plan only for themselves; a client studentId is ignored (FLKRM-383).
    const student = user.role === 'student';
    const planUsername = student ? user.username : requestedUsername || null;
    const planStudentId = student ? null : body.studentId || null;
    const plan = await generateRevisionPlan(db, {
      schoolId: scopedSchoolId,
      username: planUsername,
      studentId: planStudentId,
      subject: planSubject,
    });

    let planId = null;
    try {
      planId = await saveRevisionPlan(db, {
        schoolId: scopedSchoolId,
        username: planUsername,
        studentId: planStudentId,
        subject: planSubject,
        plan,
      });
    } catch {
      /* persistence must never block plan delivery */
    }

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ plan, planId });
  } catch (error) {
    if (error instanceof InsufficientEvidenceError) {
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ ok: false, reason: 'insufficient_data', evidence: error.evidence });
    }
    return internalError(res, error, 'ai/revision');
  }
}
