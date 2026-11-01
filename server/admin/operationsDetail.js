import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { internalError } from '../../api/_lib/httpError.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['admin', 'skyll_admin']);
    if (!user) return;

    const jobId = req.query.id;
    if (!jobId) return res.status(400).json({ error: 'Missing job id' });

    const db = database();
    const isSkyllAdmin = user.role === 'skyll_admin';
    const scope = isSkyllAdmin ? { where: 'WHERE id = ?', args: [jobId] } : { where: 'WHERE id = ? AND school = ?', args: [jobId, user.school] };
    
    const result = await db.execute({
      sql: `SELECT id, progress_json, error FROM processing_jobs ${scope.where}`,
      args: scope.args,
    });

    if (!result.rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = result.rows[0];

    return res.status(200).json({
      id: job.id,
      progress: JSON.parse(job.progress_json || '{}'),
      error: job.error,
    });
  } catch (error) {
    return internalError(res, error, 'operations-detail');
  }
}
