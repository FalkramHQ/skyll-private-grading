import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { inActorSchool } from '../../api/_lib/schoolScope.js';
import { resolveSchoolId } from '../../api/_lib/canonicalSubmissions.js';
import { checkRateLimit } from '../../api/_lib/rateLimit.js';
import { checkAiRateLimit, getStudentTier } from '../../api/_lib/aiRateLimitTiers.js';
import { handleCors } from '../../api/_lib/cors.js';
import { internalError } from '../../api/_lib/httpError.js';
import { listTutorSessions, loadChatHistory, runTutorTurn } from '../../api/_lib/tutor.js';

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

/** POST /api/ai/tutor — evidence-bound student tutor turn. */
export default async function handler(req, res) {
  if (handleCors(req, res)) return;

  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['student', 'teacher', 'admin', 'skyll_admin']);
    if (!user) return;

    if (await checkRateLimit(`tutor:${user.user_id || user.username}`, { max: 20, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many tutor requests. Try again shortly.' });
    }

    const db = database();
    const schoolId = await schoolIdForUser(db, user);
    if (!schoolId && user.role !== 'skyll_admin') {
      return res.status(403).json({ error: 'School access denied' });
    }

    if (req.method === 'GET') {
      if (req.query?.list) {
        const sessions = await listTutorSessions(db, {
          userId: user.user_id,
          schoolId,
          limit: req.query?.limit,
        });
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(200).json({ sessions });
      }
      const sessionId = String(req.query?.sessionId || '').trim();
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const history = await loadChatHistory(db, { sessionId, limit: 40 });
      // Ensure the session belongs to this user (or staff).
      const owner = (await db.execute({
        sql: 'SELECT user_id, school_id FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 1',
        args: [sessionId],
      }).catch(() => ({ rows: [] }))).rows[0];
      if (!owner) return res.status(404).json({ error: 'Session not found' });
      // Ownership alone is not enough for staff: a teacher or admin must also
      // belong to the school that owns the session. Messages store the school
      // id, compared to the session's; a missing id fails closed rather than
      // granting a cross-tenant read.
      const staff = ['teacher', 'admin', 'skyll_admin'].includes(user.role);
      if (owner.user_id !== user.user_id) {
        const sameSchool = await inActorSchool(db, user, { schoolId: owner.school_id });
        if (!staff || (user.role !== 'skyll_admin' && !sameSchool)) {
          return res.status(403).json({ error: 'You do not have permission to view this chat' });
        }
      }
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ sessionId, messages: history });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = parseBody(req);
    const question = String(body.question || body.message || '').trim();
    if (!question) return res.status(400).json({ error: 'question is required' });
    if (question.length > 2000) return res.status(400).json({ error: 'question is too long' });

    const scopedSchoolId = String(body.schoolId || schoolId || '').trim();
    if (!scopedSchoolId) return res.status(400).json({ error: 'schoolId is required' });
    if (user.role !== 'skyll_admin' && scopedSchoolId !== schoolId) {
      return res.status(403).json({ error: 'School access denied' });
    }

    const requestedUsername = String(body.username || body.student || '').trim();
    const staff = ['teacher', 'admin', 'skyll_admin'].includes(user.role);
    if (requestedUsername && requestedUsername !== user.username && !staff) {
      return res.status(403).json({ error: 'You do not have permission to tutor for this student' });
    }

    // Fair-use daily quota (tier-aware) for students; staff are exempt. This is
    // the per-day cap on top of the per-minute burst limiter above.
    if (user.role === 'student') {
      const tier = await getStudentTier(db, { userId: user.user_id, schoolId: scopedSchoolId });
      const quota = await checkAiRateLimit(user.user_id || user.username, 'tutor', tier);
      if (quota.limited) {
        return res.status(429).json({
          error: `Daily tutor limit reached (${quota.limit}/day on your plan). Try again tomorrow.`,
          limit: quota.limit, used: quota.used, tier,
        });
      }
    }

    // A student is always tutored on their own record; a client studentId would
    // otherwise resolve first and select a classmate (FLKRM-383).
    const student = user.role === 'student';
    const result = await runTutorTurn(db, {
      user,
      schoolId: scopedSchoolId,
      username: student ? user.username : requestedUsername || null,
      studentId: student ? null : body.studentId || null,
      question,
      sessionId: body.sessionId || null,
    });

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(result);
  } catch (error) {
    return internalError(res, error, 'ai/tutor');
  }
}
