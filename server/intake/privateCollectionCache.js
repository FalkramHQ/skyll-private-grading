import { createHash } from 'node:crypto';

function matchesEtag(ifNoneMatch, etag) {
  const validators = String(ifNoneMatch || '')
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''));
  return validators.includes('*') || validators.includes(etag);
}

/**
 * Cache only authenticated collection responses. `private` and `Vary` keep a
 * school-scoped response out of shared caches and separated by credentials.
 * `scope` (usually school id) is folded into the ETag so identical payloads
 * from different schools never collide if a cache key is ever mis-shared.
 */
export function sendPrivateCollection(req, res, payload, { scope } = {}) {
  const etagPayload = scope == null ? payload : { scope, payload };
  const etag = `"${createHash('sha256').update(JSON.stringify(etagPayload)).digest('base64url')}"`;
  res.setHeader('Cache-Control', 'private, max-age=30');
  res.setHeader('Vary', 'Authorization, Cookie');
  res.setHeader('ETag', etag);

  if (matchesEtag(req.headers?.['if-none-match'], etag)) {
    return res.status(304).end();
  }
  return res.status(200).json(payload);
}
