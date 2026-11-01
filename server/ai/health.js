import { requireUser, ensureAuthTables } from '../../api/_lib/auth.js';
import { handleCors } from '../../api/_lib/cors.js';

/** Lightweight health/stub so the AI catch-all is deployable before product routes land. */
export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  await ensureAuthTables();
  const user = await requireUser(req, res, ['student', 'teacher', 'admin', 'skyll_admin']);
  if (!user) return;

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    ok: true,
    service: 'ai',
    route: 'health',
    role: user.role,
    school: user.school || null,
  });
}
