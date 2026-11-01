// Guardian contacts (CRM-003, CRM-008 groundwork). crm_contacts +
// crm_guardian_links are the only home for parent phone numbers; the legacy
// students.parent_* columns are no longer read or written.
import { randomUUID } from 'node:crypto';
import { normalizePhone } from '../../api/_lib/phone.js';

/** The student's active primary guardian, or null. */
export async function getPrimaryGuardian(db, { schoolId, studentId }) {
  const result = await db.execute({
    sql: `SELECT c.id, c.full_name, c.phone_e164, c.whatsapp_opted_in
          FROM crm_guardian_links g
          JOIN crm_contacts c ON c.id = g.contact_id AND c.school_id = g.school_id
          WHERE g.school_id = ? AND g.student_id = ? AND g.is_primary = 1 AND g.status = 'active'
            AND c.archived_at IS NULL AND c.anonymised_at IS NULL
          LIMIT 1`,
    args: [schoolId, studentId],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    contactId: row.id,
    name: row.full_name || null,
    phone: row.phone_e164 || null,
    optedIn: Number(row.whatsapp_opted_in) === 1,
  };
}

/**
 * Finds the school's contact with this phone (a sibling's parent, a repeat
 * inquirer) or prepares a new one. Returns `{ contactId, statements, existing }`,
 * or null when the phone is not valid. `consentSource` records where a WhatsApp
 * opt-in came from ('staff', 'roster_import', 'public_form').
 */
export async function contactStatements(db, { schoolId, name = null, phone, optedIn = false, consentSource = 'staff', actorUserId = null, now = new Date().toISOString() }) {
  const phoneE164 = normalizePhone(phone);
  if (!phoneE164) return null;
  const existing = await db.execute({
    sql: `SELECT id, full_name FROM crm_contacts
          WHERE school_id = ? AND phone_e164 = ? AND archived_at IS NULL AND anonymised_at IS NULL
          ORDER BY created_at LIMIT 1`,
    args: [schoolId, phoneE164],
  });
  if (existing.rows.length) {
    const contactId = existing.rows[0].id;
    // Consent given now counts; consent is never silently withdrawn here.
    const statements = optedIn ? [{
      sql: `UPDATE crm_contacts SET whatsapp_opted_in = 1, consent_at = COALESCE(consent_at, ?), consent_source = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND whatsapp_opted_in = 0`,
      args: [now, consentSource, now, contactId],
    }] : [];
    return { contactId, statements, existing: { name: existing.rows[0].full_name || null } };
  }
  const contactId = `ct_${randomUUID()}`;
  return {
    contactId,
    statements: [{
      sql: `INSERT INTO crm_contacts (id, school_id, full_name, phone_e164, whatsapp_opted_in, consent_at, consent_source, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [contactId, schoolId, name, phoneE164, optedIn ? 1 : 0, optedIn ? now : null, optedIn ? consentSource : null, actorUserId, now, now],
    }],
    existing: null,
  };
}

/**
 * Statements that make `phone` the student's primary guardian. Returns []
 * when the phone is not valid.
 */
export async function primaryGuardianStatements(db, { schoolId, studentId, name = null, phone, optedIn = false, consentSource = 'roster_import', actorUserId = null, now = new Date().toISOString() }) {
  const contact = await contactStatements(db, { schoolId, name, phone, optedIn, consentSource, actorUserId, now });
  if (!contact) return [];
  return [
    ...contact.statements,
    {
      // The first guardian is primary and, by default, the fee payer (D15).
      sql: `INSERT OR IGNORE INTO crm_guardian_links (id, school_id, student_id, contact_id, relationship, is_primary, is_fee_payer, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'guardian', 1, 1, ?, ?)`,
      args: [`gl_${randomUUID()}`, schoolId, studentId, contact.contactId, now, now],
    },
  ];
}
