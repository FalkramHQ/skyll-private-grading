import {
  authenticateUser,
  clearLoginFailures,
  createSession,
  database,
  ensureAuthTables,
  reserveLoginAttempt,
  portalSchoolId,
  verifyPasswordOrDummy,
} from '../../api/_lib/auth.js';
import { recordLoginEventSafe } from '../../api/_lib/userEvents.js';
import { internalError } from '../../api/_lib/httpError.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length > 120 || password.length > 256) return res.status(400).json({ error: 'Invalid credentials' });
  try {
    await ensureAuthTables();
    const rateLimit = await reserveLoginAttempt(req, username);
    if (!rateLimit.allowed) {
      res.setHeader('Retry-After', String(rateLimit.retryAfter));
      return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
    }
    const expectedSchool = String(req.body?.expectedSchool || '').trim();
    const allowedRoles = Array.isArray(req.body?.allowedRoles)
      ? req.body.allowedRoles.map((role) => String(role)).filter(Boolean).slice(0, 10)
      : [];
    const expectedRole = String(req.body?.expectedRole || '').trim() || null;
    const user = await authenticateUser(username, expectedSchool || null, { allowedRoles, expectedRole });
    const passwordOk = verifyPasswordOrDummy(password, user?.password_hash);
    if (!user || !user.active || !passwordOk) return res.status(401).json({ error: 'Invalid username or password' });
    // This account belongs to more than one school and the portal did not say
    // which one it serves. Pinning a school here would be a guess, so refuse the
    // sign-in rather than scope the session to the wrong tenant.
    if (user.needsSchoolPortal) {
      return res.status(403).json({ error: 'This account belongs to multiple schools. Sign in through your school portal.' });
    }
    if (user.noPortalAccess) {
      return res.status(403).json({ error: 'This account does not have access to this portal' });
    }
    // Several roles at this school fit this portal. Choosing one by row order
    // would decide the user's permissions for them, so ask instead.
    if (user.needsRole) {
      return res.status(409).json({ error: 'This account has more than one role at this school. Choose a role to sign in.', roles: user.roleChoices });
    }
    if (expectedSchool && user.school_id !== await portalSchoolId(expectedSchool)) return res.status(403).json({ error: 'This account belongs to a different school portal' });
    if (allowedRoles.length && !allowedRoles.includes(user.role)) return res.status(403).json({ error: 'This account does not have access to this portal' });
    await clearLoginFailures(rateLimit);
    const token = await createSession(res, user);
    try {
      await recordLoginEventSafe(database(), user, req.body?.mobile === true ? 'intake' : 'web');
    } catch {
      // Telemetry must never block sign-in.
    }
    const body = { user: { id: user.user_id || null, username: user.username, role: user.role, schoolId: user.school_id || null, school: user.school } };
    if (req.body?.mobile === true) body.accessToken = token;
    return res.status(200).json(body);
  } catch (error) {
    return internalError(res, error, 'auth-login');
  }
}