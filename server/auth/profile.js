import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { internalError } from '../../api/_lib/httpError.js';

function text(value) {
  return String(value || '').trim();
}

function uniqueSorted(values) {
  return [...new Set(values.map(text).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['student']);
    if (!user) return;

    const db = database();
    const identity = await db.execute({
      sql: `SELECT st.id AS student_id,
                   COALESCE(NULLIF(TRIM(st.display_name), ''), NULLIF(TRIM(u.display_name), ''), primary_credential.login_id) AS name,
                   primary_credential.login_id AS username,
                   school.display_name AS school
            FROM users u
            JOIN student_user_links link
              ON link.user_id = u.id
             AND link.school_id = ?
             AND link.link_status = 'confirmed'
            JOIN students st
              ON st.id = link.student_id
             AND st.school_id = ?
             AND st.status = 'active'
            JOIN schools school
              ON school.id = link.school_id
             AND school.status = 'active'
            JOIN user_credentials primary_credential
              ON primary_credential.user_id = u.id
             AND primary_credential.is_primary = 1
             AND primary_credential.status = 'active'
            WHERE u.id = ?
              AND u.status = 'active'
            LIMIT 1`,
      args: [user.school_id, user.school_id, user.user_id],
    });
    const profile = identity.rows[0];
    if (!profile) return res.status(409).json({ error: 'Student account is not linked to an active school roster' });

    const [enrollment, memberships] = await Promise.all([
      db.execute({
        sql: `SELECT enrollment.standard
              FROM student_enrollments enrollment
              JOIN academic_years year ON year.id = enrollment.academic_year_id
              WHERE enrollment.student_id = ?
                AND enrollment.status = 'active'
                AND year.school_id = ?
                AND year.is_current = 1
              ORDER BY year.updated_at DESC, enrollment.updated_at DESC
              LIMIT 1`,
        args: [profile.student_id, user.school_id],
      }).catch(() => ({ rows: [] })),
      db.execute({
        sql: `SELECT batch.name, batch.grade, batch.board
              FROM batch_memberships membership
              JOIN batches batch
                ON batch.id = membership.batch_id
               AND batch.school_id = ?
               AND batch.status = 'active'
              WHERE membership.student_id = ?
                AND membership.status = 'active'
              ORDER BY batch.name COLLATE NOCASE`,
        args: [user.school_id, profile.student_id],
      }).catch(() => ({ rows: [] })),
    ]);

    const batchRows = memberships.rows;
    const grades = uniqueSorted(batchRows.map((row) => row.grade));
    const boards = uniqueSorted(batchRows.map((row) => row.board));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({
      profile: {
        name: text(profile.name) || text(profile.username),
        class: text(enrollment.rows[0]?.standard) || grades.join(' / '),
        school: text(profile.school),
        username: text(profile.username),
        batches: uniqueSorted(batchRows.map((row) => row.name)),
        board: boards.join(' / '),
      },
    });
  } catch (error) {
    return internalError(res, error, 'auth/profile');
  }
}
