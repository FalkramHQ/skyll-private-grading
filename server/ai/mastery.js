import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { resolveSchoolId } from '../../api/_lib/canonicalSubmissions.js';
import { buildStudentContext } from '../../api/_lib/contextBuilder.js';
import { loadMasteryEstimates } from '../../api/_lib/masteryRead.js';
import { isRateLimited } from '../../api/_lib/aiRateLimit.js';
import { handleCors } from '../../api/_lib/cors.js';
import { internalError } from '../../api/_lib/httpError.js';

async function schoolIdForUser(db, user) {
  if (user.school_id) return user.school_id;
  if (!user.school) return null;
  return resolveSchoolId(db, user.school);
}

/** GET /api/ai/mastery — per-student KC posterior mastery estimates (school-scoped). */
export async function getMastery(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['student', 'teacher', 'admin', 'skyll_admin']);
    if (!user) return;

    if (isRateLimited(`mastery:${user.user_id || user.username}`, { max: 30, windowMs: 60_000 })) {
      return res.status(429).json({ error: 'Too many mastery requests. Try again shortly.' });
    }

    const db = database();
    const schoolId = await schoolIdForUser(db, user);
    if (!schoolId && user.role !== 'skyll_admin') {
      return res.status(403).json({ error: 'School access denied' });
    }

    // Platform admins may pass schoolId explicitly when browsing.
    const scopedSchoolId = String(req.query?.schoolId || schoolId || '').trim();
    if (!scopedSchoolId) return res.status(400).json({ error: 'schoolId is required' });
    if (user.role !== 'skyll_admin' && scopedSchoolId !== schoolId) {
      return res.status(403).json({ error: 'School access denied' });
    }

    let studentId;
    if (user.role === 'student') {
      // Sessions never carry student_id — resolve self from user_id and ignore
      // caller-supplied studentId/username so students cannot query peers.
      const ctx = await buildStudentContext(db, { schoolId: scopedSchoolId, userId: user.user_id });
      studentId = ctx.studentId || '';
      if (!studentId) return res.status(404).json({ error: 'Student profile not found' });
    } else {
      studentId = String(req.query?.studentId || '').trim();
      if (!studentId) {
        // Teachers' roster rows carry username, not student_id — resolve via contextBuilder
        // (same pattern as server/ai/hive.js).
        const username = String(req.query?.username || '').trim();
        if (!username) return res.status(400).json({ error: 'studentId or username is required' });
        const ctx = await buildStudentContext(db, { schoolId: scopedSchoolId, username });
        studentId = ctx.studentId || '';
        if (!studentId) return res.status(404).json({ error: 'Student not found' });
      }
    }

    const subject = String(req.query?.subject || '').trim() || null;

    const mastery = await loadMasteryEstimates(db, { schoolId: scopedSchoolId, studentId, subject });

    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json({ mastery, count: mastery.length });
  } catch (error) {
    return internalError(res, error, 'ai/mastery');
  }
}

export default getMastery;
