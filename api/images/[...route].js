import { createClient } from '@libsql/client/web';
import { ensureAuthTables, requireUser } from '../_lib/auth.js';
import { inActorSchool } from '../_lib/schoolScope.js';
import { tursoAuthToken, tursoUrl } from '../_lib/env.js';
import { getObject } from '../_lib/storage.js';
import { internalError } from '../_lib/httpError.js';

const client = tursoUrl ? createClient({ url: tursoUrl, authToken: tursoAuthToken }) : null;

let referenceAssetHasSchool = null;

async function referenceAssetColumns() {
  if (referenceAssetHasSchool === null) {
    // A failed probe is not cached: one transient error would otherwise make
    // this instance answer 403 for its whole life.
    const info = await client.execute('PRAGMA table_info(review_reference_assets)');
    referenceAssetHasSchool = info.rows.some((c) => c.name === 'school');
  }
  return referenceAssetHasSchool;
}

export function routeKind(req) {
  const route = req.query?.route;
  if (route) return Array.isArray(route) ? route[0] : route;

  // Vercel normally injects the catch-all segment into req.query.route. Some
  // production function invocations omit it, while retaining the pathname.
  // Derive the segment as a safe fallback so `/api/images/reference` remains
  // a stable public API shape.
  const pathname = String(req.url || '').split('?')[0];
  const match = pathname.match(/\/api\/images\/([^/?]+)/);
  return match?.[1] || '';
}

async function sendObject(res, asset, errorMessage) {
  const object = await getObject({ key: asset.storage_key });
  if (!object.ok) return res.status(object.status === 404 ? 404 : 502).json({ error: errorMessage });
  res.setHeader('Content-Type', asset.mime_type || object.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).end(Buffer.from(await object.arrayBuffer()));
}

async function referenceImage(req, res, user) {
  const assetId = String(req.query.asset || '').trim();
  const testId = String(req.query.testId || '').trim();
  const kind = String(req.query.kind || '').trim();
  if ((!assetId && (!testId || !['question_paper', 'answer_key'].includes(kind))) || assetId.length > 160) return res.status(400).json({ error: 'Reference asset is required' });
  const result = assetId
    ? await client.execute({
        sql: `SELECT mime_type, storage_key${(await referenceAssetColumns()) ? ', school' : ''} FROM review_reference_assets WHERE asset_id = ?`,
        args: [assetId],
      })
    : await client.execute({ sql: `SELECT f.mime_type, f.storage_key, t.school FROM file_assets f JOIN tests t ON t.id = f.test_id WHERE f.test_id = ? AND f.kind = ? AND f.status = 'uploaded' ORDER BY f.created_at DESC LIMIT 1`, args: [testId, kind] });
  if (!result.rows.length) return res.status(404).json({ error: 'Reference image not found' });
  const asset = result.rows[0];
  // Fail closed: an asset whose school cannot be established is never served.
  // inActorSchool() denies a missing or unresolvable school, so a null/absent
  // school column yields 403 rather than bytes.
  if (user.role !== 'skyll_admin' && !(await inActorSchool(client, user, { schoolName: asset.school }))) return res.status(403).json({ error: 'School access denied' });
  if (testId) res.setHeader('Content-Disposition', 'inline');
  return sendObject(res, asset, 'Stored reference image is unavailable');
}



export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!client) return res.status(500).json({ error: 'Database not configured' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['teacher', 'admin', 'skyll_admin']);
    if (!user) return;
    const kind = routeKind(req);
    // Awaited so storage failures land in the catch below.
    if (kind === 'reference') return await referenceImage(req, res, user);
    if (kind === 'answer-sheet') {
      return res.status(410).json({ error: 'Gone. Canonical answer sheets are served by /api/student-answer-sheet' });
    }
    return res.status(404).json({ error: 'Image route not found' });
  } catch (error) {
    return internalError(res, error, 'images');
  }
}
