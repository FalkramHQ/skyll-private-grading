import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { internalError } from '../../api/_lib/httpError.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['teacher', 'admin']);
    if (!user) return;
    const result = await database().execute({
      sql: `SELECT COALESCE(NULLIF(TRIM(u.display_name), ''), credential.login_id) AS name,
                   credential.login_id AS username, school.display_name AS school
            FROM users u
            JOIN school_memberships membership
              ON membership.user_id = u.id AND membership.school_id = ?
             AND membership.role IN ('teacher', 'school_admin') AND membership.status = 'active'
            JOIN schools school ON school.id = membership.school_id AND school.status = 'active'
            JOIN user_credentials credential
              ON credential.user_id = u.id AND credential.is_primary = 1 AND credential.status = 'active'
            WHERE u.id = ? AND u.status = 'active'
            LIMIT 1`,
      args: [user.school_id, user.user_id],
    });
    const profile = result.rows[0];
    if (!profile) return res.status(409).json({ error: 'Teacher account is not linked to an active school membership' });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ profile: { name: profile.name, username: profile.username, school: profile.school } });
  } catch (error) {
    return internalError(res, error, 'auth/teacher-profile');
  }
}
