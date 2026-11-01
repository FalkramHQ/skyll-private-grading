// Secure links in WhatsApp messages (D10): the parent fees page and, from S4,
// the report page. A link is a random 32-byte token; only its SHA-256 is
// stored, so a database copy can't be turned into working links. Each fee
// message gets a new link, valid 60 days; staff can revoke a guardian's links.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const LINK_DAYS = { fees: 60, report: 60 };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
export const isTokenShape = (token) => TOKEN.test(String(token || ''));

/** Creates a link and returns the raw token (shown once, in the message). */
export async function createLink(db, { schoolId, purpose, contactId = null, studentId = null, submissionId = null, messageId = null, now = Date.now() }) {
  const token = randomBytes(32).toString('base64url');
  const at = new Date(now).toISOString();
  await db.execute({
    sql: `INSERT INTO crm_access_links (id, school_id, purpose, token_hash, contact_id, student_id, submission_id, message_id, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [`lnk_${randomUUID()}`, schoolId, purpose, hashToken(token), contactId, studentId, submissionId, messageId,
      new Date(now + LINK_DAYS[purpose] * 86_400_000).toISOString(), at, at],
  });
  return token;
}

/**
 * The link for a token: `{ link }` when usable, `{ problem: 'expired' |
 * 'revoked' | 'not_found' }` otherwise. Opening is counted.
 */
export async function openLink(db, token, purpose, now = Date.now()) {
  if (!isTokenShape(token)) return { problem: 'not_found' };
  const link = (await db.execute({ sql: 'SELECT * FROM crm_access_links WHERE token_hash = ? AND purpose = ?', args: [hashToken(token), purpose] })).rows[0];
  if (!link) return { problem: 'not_found' };
  if (link.revoked_at) return { problem: 'revoked', link };
  if (Date.parse(link.expires_at) <= now) return { problem: 'expired', link };
  const at = new Date(now).toISOString();
  await db.execute({ sql: 'UPDATE crm_access_links SET open_count = open_count + 1, last_opened_at = ?, updated_at = ? WHERE id = ?', args: [at, at, link.id] });
  return { link };
}
