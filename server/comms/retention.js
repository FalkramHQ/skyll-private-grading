// Message retention and erasure (CRM M2 phase 2 S6, D14). Message text and
// parents' replies are kept for a year; after that only the record stays
// (kind, when, to whom, status). Erasing a contact (DPDP) wipes their message
// text, replies, phone and name at once, leaving "message to an erased
// contact". Runs from the worker every few hours; every step is idempotent.
import { registerPlanner } from './runner.js';

export const TEXT_RETENTION_DAYS = 365;

/** Statements that wipe one contact's messages and replies (used by erasure). */
export function eraseContactStatements(schoolId, contactId, now = new Date().toISOString()) {
  return [
    {
      sql: `UPDATE crm_comms_messages SET body_text = NULL, vars_json = NULL, phone_e164 = NULL, recipient_name = NULL, anonymised_at = ?, updated_at = ?
            WHERE school_id = ? AND contact_id = ? AND anonymised_at IS NULL`,
      args: [now, now, schoolId, contactId],
    },
    {
      sql: `UPDATE crm_comms_inbound SET body_text = NULL, media_label = NULL, from_phone = '', anonymised_at = ?, updated_at = ?
            WHERE school_id = ? AND contact_id = ? AND anonymised_at IS NULL`,
      args: [now, now, schoolId, contactId],
    },
  ];
}

export async function runRetention(db, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString();
  const cutoff = new Date(now - TEXT_RETENTION_DAYS * 86_400_000).toISOString();
  const results = await db.batch([
    {
      sql: `UPDATE crm_comms_messages SET body_text = NULL, vars_json = NULL, text_purged_at = ?, updated_at = ?
            WHERE created_at < ? AND text_purged_at IS NULL AND (body_text IS NOT NULL OR vars_json IS NOT NULL)`,
      args: [at, at, cutoff],
    },
    {
      sql: `UPDATE crm_comms_inbound SET body_text = NULL, text_purged_at = ?, updated_at = ?
            WHERE received_at < ? AND text_purged_at IS NULL AND body_text IS NOT NULL`,
      args: [at, at, cutoff],
    },
    // Contacts erased by any route: their messages follow.
    {
      sql: `UPDATE crm_comms_messages SET body_text = NULL, vars_json = NULL, phone_e164 = NULL, recipient_name = NULL, anonymised_at = ?, updated_at = ?
            WHERE anonymised_at IS NULL AND contact_id IN (SELECT id FROM crm_contacts WHERE anonymised_at IS NOT NULL)`,
      args: [at, at],
    },
    {
      sql: `UPDATE crm_comms_inbound SET body_text = NULL, media_label = NULL, from_phone = '', anonymised_at = ?, updated_at = ?
            WHERE anonymised_at IS NULL AND contact_id IN (SELECT id FROM crm_contacts WHERE anonymised_at IS NOT NULL)`,
      args: [at, at],
    },
  ], 'write');
  const [messages, replies, erasedMessages, erasedReplies] = results.map((result) => Number(result.rowsAffected || 0));
  return { queued: messages + replies + erasedMessages + erasedReplies, messages, replies, erasedMessages, erasedReplies };
}

registerPlanner('retention', runRetention, { everyMs: 6 * 3600_000 });
