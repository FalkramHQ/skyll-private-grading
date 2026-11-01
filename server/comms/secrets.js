// Encryption for WhatsApp business tokens and registration PINs (D2). Tokens
// are stored as `v1.<iv>.<tag>.<ciphertext>` (base64url, AES-256-GCM) under the
// key in WHATSAPP_TOKEN_KEY (32 bytes, base64). They are never returned by an
// API or written to a log.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class SecretKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretKeyError';
  }
}

function key(env = process.env) {
  const raw = String(env.WHATSAPP_TOKEN_KEY || '').trim();
  if (!raw) throw new SecretKeyError('WHATSAPP_TOKEN_KEY is not set');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) throw new SecretKeyError('WHATSAPP_TOKEN_KEY must be 32 bytes, base64-encoded');
  return bytes;
}

export function hasSecretKey(env = process.env) {
  try { key(env); return true; } catch { return false; }
}

export function encryptSecret(plain, env = process.env) {
  if (typeof plain !== 'string' || !plain) throw new TypeError('Nothing to encrypt');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(env), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(stored, env = process.env) {
  const parts = String(stored || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Stored secret is not readable');
  const [, iv, tag, ciphertext] = parts;
  const decipher = createDecipheriv('aes-256-gcm', key(env), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
