// Guardians (CRM-008, FLKRM-326 S4, D15). A guardian is a link between a
// student and a school contact (one contact per phone, shared by siblings).
// Rules: exactly one primary while any guardian is active (the first one), at
// most one fee payer (the database enforces both with partial unique indexes),
// the primary can't be removed while others remain, and removing a link never
// deletes the contact. Guardian data is contact data: `crm.contacts.*`.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { RELATIONSHIP_KEYS, addGuardianBody, updateContactFields } from '../../shared/crm/guardians.js';
import { normalizePhone } from '../../api/_lib/phone.js';
import { auditStatement } from './audit.js';
import { assertVersionedWrite, expectedVersion } from './concurrency.js';
import { contactStatements } from './contacts.js';
import { CrmHttpError, crmErrors } from './errors.js';
import { can } from './permissions.js';
import { assertRecord } from './records.js';

export { addGuardianBody };

const linkId = z.string().min(1).max(128);
export const guardiansQuery = z.object({ studentId: z.string().min(1).max(128) }).strict();
export const updateGuardianBody = z.object({
  linkId,
  expectedVersion,
  relationship: z.enum(RELATIONSHIP_KEYS).optional(),
  isEmergency: z.boolean().optional(),
  isFeePayer: z.boolean().optional(),
}).strict();
export const guardianLinkBody = z.object({ linkId, expectedVersion }).strict();
export const updateContactBody = z.object({ contactId: z.string().min(1).max(128), expectedVersion, ...updateContactFields }).strict();

function requireContacts(scope, mode) {
  if (!can(scope, mode === 'write' ? 'crm.contacts.write' : 'crm.contacts.read')) throw crmErrors.forbidden();
}

const LINK_SELECT = `
  SELECT g.id, g.student_id, g.contact_id, g.relationship, g.is_primary, g.is_emergency, g.is_fee_payer, g.status, g.version,
         c.full_name, c.phone_e164, c.email, c.preferred_channel, c.whatsapp_opted_in, c.consent_at, c.consent_source,
         c.version AS contact_version
  FROM crm_guardian_links g
  JOIN crm_contacts c ON c.id = g.contact_id AND c.school_id = g.school_id AND c.anonymised_at IS NULL`;

function serializeLink(row, others = []) {
  return {
    linkId: row.id,
    studentId: row.student_id,
    relationship: row.relationship,
    isPrimary: Number(row.is_primary) === 1,
    isEmergency: Number(row.is_emergency) === 1,
    isFeePayer: Number(row.is_fee_payer) === 1,
    version: Number(row.version),
    contact: {
      id: row.contact_id,
      name: row.full_name || null,
      phone: row.phone_e164 || null,
      email: row.email || null,
      preferredChannel: row.preferred_channel || 'whatsapp',
      whatsappOptIn: Number(row.whatsapp_opted_in) === 1,
      consentAt: row.consent_at || null,
      consentSource: row.consent_source || null,
      version: Number(row.contact_version),
    },
    // Editing the contact changes it for these students too.
    alsoGuardianOf: others,
  };
}

async function loadLink(db, scope, id) {
  const result = await db.execute({ sql: `${LINK_SELECT} WHERE g.id = ? AND g.school_id = ? AND g.status = 'active'`, args: [id, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

export async function listGuardians({ db, scope, input }) {
  requireContacts(scope, 'read');
  const { studentId } = input.query;
  await assertRecord(db, scope, 'student', studentId, 'read');
  const links = await db.execute({
    sql: `${LINK_SELECT} WHERE g.school_id = ? AND g.student_id = ? AND g.status = 'active'
          ORDER BY g.is_primary DESC, g.created_at`,
    args: [scope.schoolId, studentId],
  });
  const contactIds = links.rows.map((row) => row.contact_id);
  const others = {};
  if (contactIds.length) {
    const siblings = await db.execute({
      sql: `SELECT g.contact_id, s.id, s.display_name FROM crm_guardian_links g
            JOIN students s ON s.id = g.student_id AND s.school_id = g.school_id AND s.status != 'archived'
            WHERE g.school_id = ? AND g.status = 'active' AND g.student_id != ? AND g.contact_id IN (${contactIds.map(() => '?').join(', ')})
            ORDER BY s.display_name`,
      args: [scope.schoolId, studentId, ...contactIds],
    });
    for (const row of siblings.rows) (others[row.contact_id] ||= []).push({ studentId: row.id, name: row.display_name });
  }
  return { items: links.rows.map((row) => serializeLink(row, others[row.contact_id] || [])), nextCursor: null };
}

function guardianAudit(scope, { studentId, linkId: id, contactId, change, fields, now }) {
  return auditStatement(scope, {
    action: 'guardian.changed',
    entityId: studentId,
    summary: { change, linkId: id, contactId, ...(fields ? { fields } : {}) },
    onlyIfChanged: true,
    now,
  });
}

/**
 * Clears the student's current fee payer, but only if `guard` still holds
 * (the target link is at the expected version), so a stale request changes
 * nothing. The guarded UPDATE of the target runs next in the same batch.
 */
function clearFlagStatement(scope, { flag, studentId, keepLinkId, guardVersion }) {
  return {
    sql: `UPDATE crm_guardian_links SET ${flag} = 0, version = version + 1, updated_at = ?
          WHERE school_id = ? AND student_id = ? AND status = 'active' AND ${flag} = 1 AND id != ?
            AND EXISTS (SELECT 1 FROM crm_guardian_links WHERE id = ? AND version = ? AND status = 'active')`,
    args: [new Date().toISOString(), scope.schoolId, studentId, keepLinkId, keepLinkId, guardVersion],
  };
}

export async function addGuardian({ db, scope, input }) {
  requireContacts(scope, 'write');
  const { studentId, contact: person, relationship, isEmergency, isFeePayer } = input.body;
  await assertRecord(db, scope, 'student', studentId, 'read');
  const now = new Date().toISOString();
  const contact = await contactStatements(db, {
    schoolId: scope.schoolId, name: person.name || null, phone: person.phone, optedIn: person.whatsappOptIn === true, actorUserId: scope.actor.user_id, now,
  });
  if (!contact) throw crmErrors.validation([{ path: 'contact.phone', message: 'Enter a valid phone number' }]);

  const current = await db.execute({
    sql: 'SELECT id, contact_id, status, is_primary, is_fee_payer FROM crm_guardian_links WHERE school_id = ? AND student_id = ?',
    args: [scope.schoolId, studentId],
  });
  const active = current.rows.filter((row) => row.status === 'active');
  if (active.some((row) => row.contact_id === contact.contactId)) {
    throw new CrmHttpError(409, 'already_guardian', 'This person is already a guardian of this student');
  }
  const first = active.length === 0;
  // The first guardian is primary and, unless told otherwise, the fee payer.
  const feePayer = isFeePayer ?? (first || !active.some((row) => Number(row.is_fee_payer) === 1));
  const previous = current.rows.find((row) => row.contact_id === contact.contactId);
  const id = previous ? previous.id : `gl_${randomUUID()}`;

  const statements = [...contact.statements];
  if (person.email && !contact.existing) {
    statements.push({ sql: 'UPDATE crm_contacts SET email = ? WHERE id = ? AND school_id = ?', args: [person.email, contact.contactId, scope.schoolId] });
  }
  if (feePayer && !first) {
    statements.push({
      sql: `UPDATE crm_guardian_links SET is_fee_payer = 0, version = version + 1, updated_at = ?
            WHERE school_id = ? AND student_id = ? AND status = 'active' AND is_fee_payer = 1`,
      args: [now, scope.schoolId, studentId],
    });
  }
  const flags = [first ? 1 : 0, isEmergency ? 1 : 0, feePayer ? 1 : 0];
  statements.push(previous
    // A removed link comes back rather than duplicating (UNIQUE student + contact).
    ? {
      sql: `UPDATE crm_guardian_links SET status = 'active', removed_at = NULL, relationship = ?, is_primary = ?, is_emergency = ?, is_fee_payer = ?,
                   version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND status = 'removed'`,
      args: [relationship, ...flags, now, id, scope.schoolId],
    }
    : {
      sql: `INSERT INTO crm_guardian_links (id, school_id, student_id, contact_id, relationship, is_primary, is_emergency, is_fee_payer, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, scope.schoolId, studentId, contact.contactId, relationship, ...flags, now, now],
    });
  statements.push(guardianAudit(scope, { studentId, linkId: id, contactId: contact.contactId, change: previous ? 'restored' : 'added', now }));
  try {
    await db.batch(statements, 'write');
  } catch (error) {
    // Someone else changed this student's guardians at the same moment and the
    // one-primary / one-fee-payer indexes refused the second write.
    if (/UNIQUE constraint failed/i.test(String(error?.message || error?.cause?.message || ''))) {
      throw new CrmHttpError(409, 'version_conflict', 'Guardians were changed by someone else. Reload and try again.');
    }
    throw error;
  }
  return { guardian: serializeLink(await loadLink(db, scope, id)), reusedContact: contact.existing };
}

export async function updateGuardian({ db, scope, input }) {
  requireContacts(scope, 'write');
  const { linkId: id, expectedVersion: version, relationship, isEmergency, isFeePayer } = input.body;
  const row = await loadLink(db, scope, id);
  const sets = [];
  const args = [];
  const fields = [];
  if (relationship !== undefined && relationship !== row.relationship) { sets.push('relationship = ?'); args.push(relationship); fields.push('relationship'); }
  if (isEmergency !== undefined && isEmergency !== (Number(row.is_emergency) === 1)) { sets.push('is_emergency = ?'); args.push(isEmergency ? 1 : 0); fields.push('isEmergency'); }
  if (isFeePayer !== undefined && isFeePayer !== (Number(row.is_fee_payer) === 1)) { sets.push('is_fee_payer = ?'); args.push(isFeePayer ? 1 : 0); fields.push('isFeePayer'); }
  if (!sets.length) throw crmErrors.validation([{ path: '', message: 'Nothing changed' }]);
  const now = new Date().toISOString();
  const statements = [];
  if (isFeePayer && fields.includes('isFeePayer')) {
    statements.push(clearFlagStatement(scope, { flag: 'is_fee_payer', studentId: row.student_id, keepLinkId: id, guardVersion: version }));
  }
  const updateIndex = statements.length;
  statements.push(
    {
      sql: `UPDATE crm_guardian_links SET ${sets.join(', ')}, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND version = ? AND status = 'active'`,
      args: [...args, now, id, scope.schoolId, version],
    },
    guardianAudit(scope, { studentId: row.student_id, linkId: id, contactId: row.contact_id, change: 'updated', fields, now }),
  );
  const results = await db.batch(statements, 'write');
  await assertVersionedWrite(results, updateIndex, () => linkVersion(db, scope, id));
  return serializeLink(await loadLink(db, scope, id));
}

async function linkVersion(db, scope, id) {
  const result = await db.execute({ sql: "SELECT version FROM crm_guardian_links WHERE id = ? AND school_id = ? AND status = 'active'", args: [id, scope.schoolId] });
  return result.rows[0]?.version ?? null;
}

export async function makePrimaryGuardian({ db, scope, input }) {
  requireContacts(scope, 'write');
  const { linkId: id, expectedVersion: version } = input.body;
  const row = await loadLink(db, scope, id);
  if (Number(row.is_primary) === 1) throw crmErrors.validation([{ path: 'linkId', message: 'Already the primary guardian' }]);
  const now = new Date().toISOString();
  // Clear the old primary first (the unique index allows only one), both
  // guarded by the target's version so a stale request changes nothing.
  const results = await db.batch([
    clearFlagStatement(scope, { flag: 'is_primary', studentId: row.student_id, keepLinkId: id, guardVersion: version }),
    {
      sql: `UPDATE crm_guardian_links SET is_primary = 1, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND version = ? AND status = 'active'`,
      args: [now, id, scope.schoolId, version],
    },
    guardianAudit(scope, { studentId: row.student_id, linkId: id, contactId: row.contact_id, change: 'primary_changed', now }),
  ], 'write');
  await assertVersionedWrite(results, 1, () => linkVersion(db, scope, id));
  return serializeLink(await loadLink(db, scope, id));
}

export async function removeGuardian({ db, scope, input }) {
  requireContacts(scope, 'write');
  const { linkId: id, expectedVersion: version } = input.body;
  const row = await loadLink(db, scope, id);
  if (Number(row.is_primary) === 1) {
    const others = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM crm_guardian_links WHERE school_id = ? AND student_id = ? AND status = 'active' AND id != ?",
      args: [scope.schoolId, row.student_id, id],
    });
    if (Number(others.rows[0].n) > 0) {
      throw new CrmHttpError(422, 'primary_required', 'Make another guardian primary before removing this one');
    }
  }
  const now = new Date().toISOString();
  const results = await db.batch([
    {
      sql: `UPDATE crm_guardian_links SET status = 'removed', removed_at = ?, is_primary = 0, is_emergency = 0, is_fee_payer = 0,
                   version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND version = ? AND status = 'active'`,
      args: [now, now, id, scope.schoolId, version],
    },
    guardianAudit(scope, { studentId: row.student_id, linkId: id, contactId: row.contact_id, change: 'removed', now }),
  ], 'write');
  await assertVersionedWrite(results, 0, () => linkVersion(db, scope, id));
  return { linkId: id, removed: true };
}

/** Edits a contact everywhere it is used (all its students, and any lead). */
export async function updateContact({ db, scope, input }) {
  requireContacts(scope, 'write');
  const { contactId, expectedVersion: version, ...changes } = input.body;
  const current = await db.execute({
    sql: 'SELECT id, full_name, email, phone_e164, preferred_channel, whatsapp_opted_in FROM crm_contacts WHERE id = ? AND school_id = ? AND anonymised_at IS NULL',
    args: [contactId, scope.schoolId],
  });
  const row = current.rows[0];
  if (!row) throw crmErrors.notFound();
  const now = new Date().toISOString();
  const sets = [];
  const args = [];
  const fields = [];
  if (changes.name !== undefined && (changes.name || null) !== (row.full_name || null)) { sets.push('full_name = ?'); args.push(changes.name || null); fields.push('name'); }
  if (changes.email !== undefined && (changes.email || null) !== (row.email || null)) { sets.push('email = ?'); args.push(changes.email || null); fields.push('email'); }
  if (changes.phone !== undefined) {
    const phone = normalizePhone(changes.phone);
    if (phone !== row.phone_e164) {
      const clash = await db.execute({
        sql: 'SELECT 1 FROM crm_contacts WHERE school_id = ? AND phone_e164 = ? AND id != ? AND archived_at IS NULL AND anonymised_at IS NULL',
        args: [scope.schoolId, phone, contactId],
      });
      if (clash.rows.length) throw new CrmHttpError(409, 'duplicate_contact', 'Another contact already has this phone number. Add them as a guardian instead.');
      sets.push('phone_e164 = ?'); args.push(phone); fields.push('phone');
    }
  }
  if (changes.preferredChannel !== undefined && changes.preferredChannel !== row.preferred_channel) {
    sets.push('preferred_channel = ?'); args.push(changes.preferredChannel); fields.push('preferredChannel');
  }
  if (changes.whatsappOptIn !== undefined && changes.whatsappOptIn !== (Number(row.whatsapp_opted_in) === 1)) {
    // Consent given or withdrawn here is recorded as staff-recorded, now.
    sets.push('whatsapp_opted_in = ?', 'consent_at = ?', "consent_source = 'staff'");
    args.push(changes.whatsappOptIn ? 1 : 0, changes.whatsappOptIn ? now : null);
    fields.push('whatsappOptIn');
  }
  if (!sets.length) throw crmErrors.validation([{ path: '', message: 'Nothing changed' }]);
  const results = await db.batch([
    {
      sql: `UPDATE crm_contacts SET ${sets.join(', ')}, version = version + 1, updated_at = ?
            WHERE id = ? AND school_id = ? AND version = ? AND anonymised_at IS NULL`,
      args: [...args, now, contactId, scope.schoolId, version],
    },
    auditStatement(scope, {
      action: 'contact.updated',
      entityId: contactId,
      summary: { fields, ...(fields.includes('whatsappOptIn') ? { whatsappOptIn: changes.whatsappOptIn } : {}) },
      onlyIfChanged: true,
      now,
    }),
  ], 'write');
  await assertVersionedWrite(results, 0, async () => {
    const check = await db.execute({ sql: 'SELECT version FROM crm_contacts WHERE id = ? AND school_id = ?', args: [contactId, scope.schoolId] });
    return check.rows[0]?.version ?? null;
  });
  return { contactId, updated: fields };
}
