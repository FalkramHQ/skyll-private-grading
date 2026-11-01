import { ensureAuthTables, requireUser, database } from '../../api/_lib/auth.js';
import { ensureIntakeTables } from '../../api/_lib/intake.js';
import { sendPrivateCollection } from './privateCollectionCache.js';
import { internalError } from '../../api/_lib/httpError.js';

export default async function handler(req, res) {
  try {
    await ensureAuthTables(); await ensureIntakeTables();
    const user = await requireUser(req, res, ['admin', 'skyll_admin']);
    if (!user) return;
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const db = database();
    const result = await db.execute({
      sql: `SELECT b.id, b.name, b.grade, b.board, b.stream, b.academic_year,
                   COUNT(bs.student_id) AS student_count
            FROM batches b
            LEFT JOIN batch_memberships bs ON bs.batch_id = b.id AND bs.status = 'active'
            LEFT JOIN students s ON s.id = bs.student_id AND s.status = 'active'
            WHERE b.school = ? AND b.status = 'active'
            GROUP BY b.id, b.name, b.grade, b.board, b.stream, b.academic_year
            ORDER BY b.grade COLLATE NOCASE, b.name COLLATE NOCASE`,
      args: [user.school],
    });
    return sendPrivateCollection(req, res, { batches: result.rows.map((batch) => ({
      id: batch.id, name: batch.name, grade: batch.grade, board: batch.board,
      stream: batch.stream, academicYear: batch.academic_year, studentCount: Number(batch.student_count || 0),
    })) }, { scope: user.school });
  } catch (error) { return internalError(res, error, 'intake-batches'); }
}
