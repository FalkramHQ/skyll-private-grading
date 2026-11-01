import { createClient } from '@libsql/client/web';
import { ensureAuthTables, requireUser } from '../_lib/auth.js';
import { tursoAuthToken, tursoUrl } from '../_lib/env.js';
import { RecheckContractError } from '../_lib/recheckCollectionService.js';
import { saveReviewDecision } from '../_lib/reviewerEditService.js';
import { internalError } from '../_lib/httpError.js';

const client = tursoUrl ? createClient({ url: tursoUrl, authToken: tursoAuthToken }) : null;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (!client) return res.status(500).json({ error: 'Database not configured' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const itemId = req.query?.id;
  if (!itemId) return res.status(400).json({ error: 'Missing item ID' });

  try {
    await ensureAuthTables();
    const actor = await requireUser(req, res, ['teacher', 'admin', 'skyll_admin']);
    if (!actor) return;
    const result = await saveReviewDecision(client, actor, itemId, req.body);
    return res.status(200).json({ ok: true, id: itemId, ...result });
  } catch (error) {
    if (error instanceof RecheckContractError) {
      return res.status(error.status).json({ error: error.message });
    }
    return internalError(res, error, 'vl-review');
  }
}
