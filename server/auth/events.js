import { database, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { internalError } from '../../api/_lib/httpError.js';
import { buildProductMetrics, normalizeEventType, recordUserEvent } from '../../api/_lib/userEvents.js';

export default async function handler(req, res) {
  try {
    await ensureAuthTables();
    if (req.method === 'POST') {
      const user = await requireUser(req, res);
      if (!user) return;
      const eventType = normalizeEventType(req.body?.eventType || req.body?.type);
      if (!eventType) return res.status(400).json({ error: 'Unsupported event type' });
      const platform = String(req.body?.platform || 'web').slice(0, 40);
      const id = await recordUserEvent(database(), {
        user,
        eventType,
        eventData: req.body?.eventData || req.body?.data || {},
        platform,
      });
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(201).json({ ok: true, id });
    }

    if (req.method === 'GET') {
      const user = await requireUser(req, res, ['admin', 'skyll_admin']);
      if (!user) return;
      const metrics = await buildProductMetrics(database(), user);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json(metrics);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    if (/no such table: user_events/i.test(String(error?.message || ''))) {
      return res.status(503).json({ error: 'Product metrics are not initialized yet. Apply migration 051_user_events.' });
    }
    return internalError(res, error, 'auth/events');
  }
}
