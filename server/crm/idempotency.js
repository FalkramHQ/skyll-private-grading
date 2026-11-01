// Idempotency-Key support for CRM writes. The same key with the same request
// replays the stored response; the same key with a different request is a 409.
import { createHash } from 'node:crypto';
import { CrmHttpError } from './errors.js';

const KEY = /^[A-Za-z0-9_-]{8,128}$/;

export function idempotencyKey(req) {
  const value = req.headers?.['idempotency-key'] ?? req.headers?.['Idempotency-Key'];
  if (value === undefined || value === null || value === '') return null;
  const key = String(value).trim();
  if (!KEY.test(key)) {
    throw new CrmHttpError(422, 'validation_failed', 'Request is invalid', [{ path: 'Idempotency-Key', message: 'Must be 8-128 letters, digits, _ or -' }]);
  }
  return key;
}

export function requestHash(method, path, body) {
  return createHash('sha256').update(`${method} ${path}\n${JSON.stringify(body ?? {})}`).digest('hex');
}

export async function findReplay(db, scope, key, hash) {
  const result = await db.execute({
    sql: `SELECT request_hash, status_code, response_json FROM crm_idempotency_keys
          WHERE school_id = ? AND user_id = ? AND idempotency_key = ?`,
    args: [scope.schoolId, scope.actor.user_id, key],
  });
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== hash) {
    throw new CrmHttpError(409, 'idempotency_mismatch', 'This Idempotency-Key was already used for a different request');
  }
  return { status: Number(row.status_code), body: JSON.parse(row.response_json) };
}

export async function storeReplay(db, scope, key, hash, status, body) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO crm_idempotency_keys
          (school_id, user_id, idempotency_key, request_hash, status_code, response_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [scope.schoolId, scope.actor.user_id, key, hash, status, JSON.stringify(body ?? {}), new Date().toISOString()],
  });
}
