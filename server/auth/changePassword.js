import { createRequire } from 'node:module';
import {
  database,
  ensureAuthTables,
  hashPassword,
  requireUser,
  reserveLoginAttempt,
  clearLoginFailures,
  verifyPassword,
} from '../../api/_lib/auth.js';
import { internalError } from '../../api/_lib/httpError.js';

const require = createRequire(import.meta.url);
const {
  assertStaffPassword,
  assertStudentPassword,
  STUDENT_SELF_SERVICE_PASSWORD_CHANGE,
} = require('../../scripts/lib/credentialPolicy.cjs');
const MAX_PASSWORD_LENGTH = 256;

// `requireUser` authenticates student, teacher, and admin so a student who
// bypasses the UI reaches our tailored gate below instead of a generic 403.
// Students are gated by STUDENT_SELF_SERVICE_PASSWORD_CHANGE; when the policy is
// off they are rejected before any credential work happens. Teacher/admin are
// unaffected and can always change their own password.
const PASSWORD_CHANGE_ROLES = ['student', 'teacher', 'admin'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current password and new password are required' });
  if (currentPassword.length > MAX_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) return res.status(400).json({ error: 'Invalid password' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, PASSWORD_CHANGE_ROLES);
    if (!user) return;
    if (user.role === 'student' && !STUDENT_SELF_SERVICE_PASSWORD_CHANGE) {
      // Non-sensitive, non-account-revealing error for direct student requests.
      return res.status(403).json({ error: 'Password changes are managed by your school. Please contact your school administrator.' });
    }
    try {
      if (user.role === 'student') assertStudentPassword(newPassword, 'New');
      else assertStaffPassword(newPassword, 'New password');
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const db = database();
    const credentialResult = await db.execute({
      sql: `SELECT id, password_hash
            FROM user_credentials
            WHERE user_id = ? AND is_primary = 1 AND status = 'active'
            LIMIT 1`,
      args: [user.user_id],
    });
    const credential = credentialResult.rows[0];
    if (!credential) return res.status(409).json({ error: 'Active primary credential not found' });
    const rateLimit = await reserveLoginAttempt(req, user.username);
    if (!rateLimit.allowed) {
      res.setHeader('Retry-After', String(rateLimit.retryAfter));
      return res.status(429).json({ error: 'Too many password attempts. Try again later.' });
    }
    if (!verifyPassword(currentPassword, credential.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
    if (verifyPassword(newPassword, credential.password_hash)) {
      await clearLoginFailures(rateLimit);
      return res.status(400).json({ error: 'New password must be different from your current password' });
    }
    const timestamp = new Date().toISOString();
    await db.batch([
      { sql: `UPDATE user_credentials SET password_hash = ?, updated_at = ?
              WHERE id = ? AND user_id = ? AND is_primary = 1 AND status = 'active'`, args: [hashPassword(newPassword), timestamp, credential.id, user.user_id] },
      { sql: 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', args: [timestamp, user.user_id] },
    ], 'write');
    await clearLoginFailures(rateLimit);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ message: 'Password changed. Please sign in again.' });
  } catch (error) {
    return internalError(res, error, 'auth/change-password');
  }
}
