// Parent contact resolution + phone normalisation for WhatsApp delivery.
// Shared by roster import, the notify endpoint, and the WhatsApp client.
//
// Parent phones live in CRM guardian contacts (crm_contacts +
// crm_guardian_links, migration 061). The legacy students.parent_* columns
// are neither read nor written.

import { database } from '../../api/_lib/auth.js';
import { inActorSchool } from '../../api/_lib/schoolScope.js';
import { normalizePhone } from '../../api/_lib/phone.js';
import { getPrimaryGuardian } from '../crm/contacts.js';

export { normalizePhone };

/**
 * Resolve the parent WhatsApp contact for a submission (or a student directly),
 * scoped to `schoolId`. Pass `schoolId: null` only for platform staff.
 * Walks submissions → students → primary guardian contact.
 * Returns { studentId, studentName, parentName, parentPhone, optedIn }, or
 * null when the student does not exist in that school.
 */
export async function resolveParentContact({ submissionId = null, studentId = null, schoolId } = {}) {
  if (schoolId === undefined) throw new Error('resolveParentContact requires schoolId (null for platform staff)');
  const db = database();

  let resolvedStudentId = studentId;
  if (submissionId) {
    const owner = await resolveSubmissionOwner(submissionId);
    // A submission and a student given together must be the same student, or a
    // report link could be minted for one student under another's contact.
    if (!owner?.studentId || (studentId && owner.studentId !== studentId)) return null;
    resolvedStudentId = owner.studentId;
  }
  if (!resolvedStudentId) return null;

  const row = (await db.execute({
    sql: `SELECT id, display_name, school_id FROM students
          WHERE id = ? AND (? IS NULL OR school_id = ?) LIMIT 1`,
    args: [resolvedStudentId, schoolId, schoolId],
  })).rows[0];
  if (!row) return null;

  const guardian = row.school_id ? await getPrimaryGuardian(db, { schoolId: row.school_id, studentId: row.id }) : null;
  return {
    studentId: row.id,
    studentName: row.display_name || null,
    parentName: guardian?.name || null,
    parentPhone: guardian?.phone || null,
    optedIn: Boolean(guardian?.optedIn),
  };
}

/**
 * FLKRM-381: who owns a submission, for authorizing parent-report access.
 * Walks submissions → students, falling back to the latest report version.
 * Returns { studentId, schoolId, schoolName } (any may be null), or null when
 * the submission is unknown.
 */
export async function resolveSubmissionOwner(submissionId) {
  if (!submissionId) return null;
  const db = database();
  const sub = (await db.execute({
    sql: 'SELECT student_id FROM submissions WHERE id = ? LIMIT 1',
    args: [submissionId],
  })).rows[0];
  const report = (await db.execute({
    sql: 'SELECT student_id, school FROM report_versions WHERE submission_id = ? ORDER BY version DESC LIMIT 1',
    args: [submissionId],
  })).rows[0];
  const studentId = sub?.student_id || report?.student_id || null;
  if (!studentId && !report) return null;
  const student = studentId
    ? (await db.execute({ sql: 'SELECT school_id FROM students WHERE id = ? LIMIT 1', args: [studentId] })).rows[0]
    : null;
  return { studentId, schoolId: student?.school_id || null, schoolName: report?.school || null };
}

/**
 * FLKRM-381: may `user` mint or read parent-report data for this submission?
 * Fails closed: an unknown owner, or one whose school cannot be established,
 * is visible to platform staff only. The school name is consulted only for
 * legacy reports that carry no resolvable student.
 */
export async function submissionVisibleTo(owner, user) {
  if (!owner) return false;
  if (user?.role === 'skyll_admin') return true;
  return inActorSchool(database(), user, { schoolId: owner.schoolId, schoolName: owner.schoolName });
}
