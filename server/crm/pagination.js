// Cursor pagination for CRM lists: `{ items, nextCursor }`. Cursors are opaque
// base64url JSON of the last row's sort key, so pages never skip or repeat rows
// while records are being added.
import { z } from 'zod';
import { crmErrors } from './errors.js';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().max(512).optional(),
});

export function encodeCursor(values) {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor(cursor, length) {
  if (!cursor) return null;
  try {
    const values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(values) && values.length === length && values.every((value) => typeof value === 'string')) return values;
  } catch {
    // fall through
  }
  throw crmErrors.validation([{ path: 'cursor', message: 'Invalid cursor' }]);
}

/** Callers fetch `limit + 1` rows; the extra row only signals another page. */
export function toPage(rows, limit, sortKey, mapRow = (row) => row) {
  const items = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeCursor(sortKey(items[items.length - 1])) : null;
  return { items: items.map(mapRow), nextCursor };
}
