import { destroySession, ensureAuthTables, sessionForRequest } from '../../api/_lib/auth.js';
import { internalError } from '../../api/_lib/httpError.js';

export default async function handler(req, res) {
  try {
    await ensureAuthTables();
    if (req.method === 'GET') {
      const user = await sessionForRequest(req);
      return res.status(200).json({ user: user ? { id: user.user_id || null, username: user.username, role: user.role, schoolId: user.school_id || null, school: user.school } : null });
    }
    if (req.method === 'DELETE' || req.method === 'POST') { await destroySession(req, res); return res.status(204).end(); }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return internalError(res, error, 'auth-session');
  }
}
