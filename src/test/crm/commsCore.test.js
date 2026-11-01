// Token encryption, Meta error sorting and webhook signatures (CRM M2 phase 2 S1).
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyMetaError } from '../../../server/comms/errors.js';
import { decryptSecret, encryptSecret, hasSecretKey } from '../../../server/comms/secrets.js';
import { readRawBody, signatureValid } from '../../../server/comms/webhook.js';

const env = { WHATSAPP_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64') };

describe('token encryption', () => {
  it('round-trips, never stores the plain token, and detects tampering', () => {
    const stored = encryptSecret('EAAG-secret-token', env);
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain('secret');
    expect(encryptSecret('EAAG-secret-token', env)).not.toBe(stored);
    expect(decryptSecret(stored, env)).toBe('EAAG-secret-token');
    const parts = stored.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), env)).toThrow();
  });

  it('requires a 32-byte key', () => {
    expect(hasSecretKey(env)).toBe(true);
    expect(hasSecretKey({})).toBe(false);
    expect(hasSecretKey({ WHATSAPP_TOKEN_KEY: 'c2hvcnQ=' })).toBe(false);
    expect(() => encryptSecret('x', {})).toThrow(/WHATSAPP_TOKEN_KEY/);
  });
});

describe('Meta error sorting', () => {
  it.each([
    [{ code: 131026 }, 400, 'recipient'],
    [{ code: 131047 }, 400, 'recipient'],
    [{ code: 130429 }, 400, 'temporary'],
    [{ code: 131000 }, 500, 'temporary'],
    [{}, 503, 'temporary'],
    [{ code: 190 }, 401, 'class'],
    [{ code: 131042 }, 400, 'class'],
    [{ code: 368 }, 400, 'class'],
    [{ code: 132015 }, 400, 'template'],
    [{ code: 100 }, 400, 'request'],
  ])('%j (%s) is %s', (error, status, kind) => {
    const sorted = classifyMetaError(error, status);
    expect(sorted.kind).toBe(kind);
    expect(sorted.reason).toMatch(/\w/);
  });

  it('explains a payment problem in plain words', () => {
    expect(classifyMetaError({ code: 131042, message: 'Business eligibility payment issue' }, 400).reason).toMatch(/payment method/);
  });
});

describe('webhook signatures', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[]}],"note":"\\u00e9"}');
  const sign = (raw, secret = 'app-secret') => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

  it('accepts only Meta’s signature over the exact bytes', () => {
    expect(signatureValid(body, sign(body), 'app-secret')).toBe(true);
    expect(signatureValid(body, sign(body, 'other'), 'app-secret')).toBe(false);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString())));
    expect(signatureValid(reserialised, sign(body), 'app-secret')).toBe(false);
    expect(signatureValid(body, undefined, 'app-secret')).toBe(false);
    expect(signatureValid(body, 'sha256=zz', 'app-secret')).toBe(false);
    expect(signatureValid(body, sign(body), null)).toBe(false);
  });

  it('reads the raw body from the dev server, a stream, or a buffer', async () => {
    expect((await readRawBody({ rawBody: body })).equals(body)).toBe(true);
    const stream = { readableEnded: false, async* [Symbol.asyncIterator]() { yield body.subarray(0, 5); yield body.subarray(5); } };
    expect((await readRawBody(stream)).equals(body)).toBe(true);
    expect((await readRawBody({ body: 'abc' })).toString()).toBe('abc');
    expect(await readRawBody({ body: { parsed: true } })).toBeNull();
  });
});
