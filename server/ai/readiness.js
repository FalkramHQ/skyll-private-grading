import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { resolveSchoolId } from '../../api/_lib/canonicalSubmissions.js';
import { checkRateLimit } from '../../api/_lib/rateLimit.js';
import { handleCors } from '../../api/_lib/cors.js';
import { internalError } from '../../api/_lib/httpError.js';
import { getReadiness } from '../../api/_lib/readiness.js';

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

/** GET/POST /api/ai/readiness — KC-mastery readiness estimate. */
export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['student', 'teacher', 'admin', 'skyll_admin']);
    if (!user) return;

    if (await checkRateLimit(`readiness:${user.user_id || user.username}`, { max: 30, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many readiness requests. Try again shortly.' });
    }

    const db = database();
    const schoolId = await schoolIdForUser(db, user);
    const body = req.method === 'POST' ? parseBody(req) : {};
    const scopedSchoolId = String(body.schoolId || req.query?.schoolId || schoolId || '').trim();
    if (!scopedSchoolId) return res.status(400).json({ error: 'schoolId is required' });
    if (user.role !== 'skyll_admin' && scopedSchoolId !== schoolId) {
      return res.status(403).json({ error: 'School access denied' });
    }

    const requestedUsername = String(body.username || body.student || req.query?.username || req.query?.student || '').trim();
    const staff = ['teacher', 'admin', 'skyll_admin'].includes(user.role);
    if (requestedUsername && requestedUsername !== user.username && !staff) {
      return res.status(403).json({ error: 'You do not have permission for this student' });
    }

    const topics = Array.isArray(body.topics)
      ? body.topics
      : String(req.query?.topics || '')
        .split('|')
        .map((topic) => topic.trim())
        .filter(Boolean);

    // Students see only their own readiness; a client studentId is ignored (FLKRM-383).
    const student = user.role === 'student';
    const readiness = await getReadiness(db, {
      schoolId: scopedSchoolId,
      username: student ? user.username : requestedUsername || null,
      studentId: student ? null : body.studentId || req.query?.studentId || null,
      subject: String(body.subject || req.query?.subject || 'Mathematics').trim() || 'Mathematics',
      topics: topics.length ? topics : null,
      board: body.board || req.query?.board || null,
      grade: body.grade || req.query?.grade || null,
    });

    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json(readiness);
  } catch (error) {
    return internalError(res, error, 'ai/readiness');
  }
}
