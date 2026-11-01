import crypto from 'node:crypto';

function required(name) {
  const aliases = { S3_ACCESS_KEY_ID: 'R2_ACCESS_KEY_ID', S3_SECRET_ACCESS_KEY: 'R2_SECRET_ACCESS_KEY' };
  const value = process.env[name] || process.env[aliases[name]];
  if (!value) throw new Error(`Storage is not configured: missing ${name}`);
  return value;
}
function encodePath(value) { return String(value).split('/').map(encodeURIComponent).join('/'); }
function hmac(key, value, encoding) { return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding); }
function hash(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function amzDate(now) { return now.toISOString().replace(/[:-]|\.\d{3}/g, ''); }

export function safeFilename(value) {
  const basename = String(value || 'upload').split(/[\\/]/).pop();
  return basename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+/, '') || 'upload';
}
export function assetKey({ school, testId, assetId, filename }) {
  return `schools/${String(school).toLowerCase().replace(/[^a-z0-9]+/g, '-')}/tests/${testId}/assets/${assetId}/${safeFilename(filename)}`;
}

// Cloudflare R2 is S3 compatible; this is a compact AWS Signature V4 signer.
export function createUploadUrl({ key, contentType, expiresIn = 900, now = new Date() }) {
  const endpoint = new URL(required('S3_ENDPOINT')); const region = process.env.S3_REGION || 'auto';
  const bucket = required('S3_BUCKET'); const accessKeyId = required('S3_ACCESS_KEY_ID'); const secret = required('S3_SECRET_ACCESS_KEY');
  const date = amzDate(now); const shortDate = date.slice(0, 8); const credential = `${accessKeyId}/${shortDate}/${region}/s3/aws4_request`;
  const host = endpoint.host;
  const query = new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': credential, 'X-Amz-Date': date, 'X-Amz-Expires': String(expiresIn), 'X-Amz-SignedHeaders': 'content-type;host' });
  const canonicalUri = `/${encodePath(bucket)}/${encodePath(key)}`;
  const canonicalQuery = [...query.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const type = contentType || 'application/octet-stream'; const canonicalHeaders = `content-type:${type}\nhost:${host}\n`;
  const canonicalRequest = `PUT\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\ncontent-type;host\nUNSIGNED-PAYLOAD`;
  const scope = `${shortDate}/${region}/s3/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, shortDate), region), 's3'), 'aws4_request');
  query.set('X-Amz-Signature', hmac(signingKey, stringToSign, 'hex'));
  return `${endpoint.origin}${canonicalUri}?${query.toString()}`;
}

export function createDownloadUrl({ key, expiresIn = 900, now = new Date() }) {
  const endpoint = new URL(required('S3_ENDPOINT')); const region = process.env.S3_REGION || 'auto';
  const bucket = required('S3_BUCKET'); const accessKeyId = required('S3_ACCESS_KEY_ID'); const secret = required('S3_SECRET_ACCESS_KEY');
  const date = amzDate(now); const shortDate = date.slice(0, 8); const credential = `${accessKeyId}/${shortDate}/${region}/s3/aws4_request`;
  const host = endpoint.host;
  const query = new URLSearchParams({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': credential, 'X-Amz-Date': date, 'X-Amz-Expires': String(expiresIn), 'X-Amz-SignedHeaders': 'host' });
  const canonicalUri = `/${encodePath(bucket)}/${encodePath(key)}`;
  const canonicalQuery = [...query.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');
  const canonicalRequest = `GET\n${canonicalUri}\n${canonicalQuery}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const scope = `${shortDate}/${region}/s3/aws4_request`; const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, shortDate), region), 's3'), 'aws4_request');
  query.set('X-Amz-Signature', hmac(signingKey, stringToSign, 'hex'));
  return `${endpoint.origin}${canonicalUri}?${query.toString()}`;
}

// Server-side writes are used for trusted admin uploads such as exam source
// notes. Browser uploads continue to use short-lived presigned URLs.
export async function putObject({ key, body, contentType = 'application/octet-stream' }) {
  const url = createUploadUrl({ key, contentType });
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body,
  });
  if (!response.ok) throw new Error(`Could not store source file (${response.status}).`);
}

// Fetch a private R2 object from a server-side API route. The browser never
// receives storage credentials or a permanent public asset URL.
export async function getObject({ key }) {
  const endpoint = new URL(required('S3_ENDPOINT')); const region = process.env.S3_REGION || 'auto';
  const bucket = required('S3_BUCKET'); const accessKeyId = required('S3_ACCESS_KEY_ID'); const secret = required('S3_SECRET_ACCESS_KEY');
  const now = new Date(); const date = amzDate(now); const shortDate = date.slice(0, 8); const host = endpoint.host;
  const payloadHash = hash(''); const canonicalUri = `/${encodePath(bucket)}/${encodePath(key)}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'; const scope = `${shortDate}/${region}/s3/aws4_request`;
  const canonicalRequest = `GET\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, shortDate), region), 's3'), 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  return fetch(`${endpoint.origin}${canonicalUri}`, {
    headers: {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

// Remove a private R2 object when an intake test is explicitly deleted. This
// uses the same server-side SigV4 flow as reads so no storage secret reaches
// the mobile client.
export async function deleteObject({ key }) {
  const endpoint = new URL(required('S3_ENDPOINT')); const region = process.env.S3_REGION || 'auto';
  const bucket = required('S3_BUCKET'); const accessKeyId = required('S3_ACCESS_KEY_ID'); const secret = required('S3_SECRET_ACCESS_KEY');
  const now = new Date(); const date = amzDate(now); const shortDate = date.slice(0, 8); const host = endpoint.host;
  const payloadHash = hash(''); const canonicalUri = `/${encodePath(bucket)}/${encodePath(key)}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'; const scope = `${shortDate}/${region}/s3/aws4_request`;
  const canonicalRequest = `DELETE\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, shortDate), region), 's3'), 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  return fetch(`${endpoint.origin}${canonicalUri}`, {
    method: 'DELETE',
    headers: {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

export const STORAGE_PROBE_TIMEOUT_MS = 5000;

// Bounded liveness probe for the health panel: a signed ListObjectsV2 call
// capped at one key, aborted after `timeoutMs`. It reads no object content.
// Resolves { ok, status, elapsedMs }; rejects with code 'storage_timeout' on
// abort, and with the configuration error when credentials are missing.
export async function probeStorage({ timeoutMs = STORAGE_PROBE_TIMEOUT_MS, now = new Date() } = {}) {
  const endpoint = new URL(required('S3_ENDPOINT')); const region = process.env.S3_REGION || 'auto';
  const bucket = required('S3_BUCKET'); const accessKeyId = required('S3_ACCESS_KEY_ID'); const secret = required('S3_SECRET_ACCESS_KEY');
  const date = amzDate(now); const shortDate = date.slice(0, 8); const host = endpoint.host;
  const payloadHash = hash(''); const canonicalUri = `/${encodePath(bucket)}`;
  const canonicalQuery = 'list-type=2&max-keys=1';
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'; const scope = `${shortDate}/${region}/s3/aws4_request`;
  const canonicalRequest = `GET\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, shortDate), region), 's3'), 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(`${endpoint.origin}${canonicalUri}?${canonicalQuery}`, {
      headers: {
        host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': date,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      signal: controller.signal,
    });
    // Drain without keeping the body: the status is the signal.
    await response.arrayBuffer().catch(() => null);
    return { ok: response.ok, status: response.status, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error(`Storage probe timed out after ${timeoutMs} ms`);
      timeout.code = 'storage_timeout';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
