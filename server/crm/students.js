// Students in the CRM (CRM-007, FLKRM-326 S4). These are the canonical
// `students` rows — the CRM keeps no second roster. Batches and enrollments are
// read from `batch_memberships` / `student_enrollments`; progress is read-only
// from `submissions` / `report_versions` (CRM_CONTRACTS §1.10). The CRM's own
// extras (owner) live in `crm_student_profiles`.
import { z } from 'zod';
import { derivePersonLifecycle } from '../../shared/crm/lifecycles.js';
import { auditStatement } from './audit.js';
import { versionConflict } from './concurrency.js';
import { crmErrors } from './errors.js';
import { assertAssignable, membersWith } from './members.js';
import { decodeCursor, listQuery, toPage } from './pagination.js';
import { can } from './permissions.js';
import { assertRecord } from './records.js';
import { tagsFor } from './tags.js';

const studentId = z.string().min(1).max(128);

export const listStudentsQuery = listQuery.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'inactive', 'alumni', 'all']).default('active'),
  batchId: z.string().max(128).optional(),
});
export const studentQuery = z.object({ studentId }).strict();
// Version 0 means "no CRM profile yet"; the first owner creates it.
export const setStudentOwnerBody = z.object({
  studentId,
  ownerUserId: z.string().trim().min(1).max(128),
  expectedVersion: z.coerce.number().int().min(0),
}).strict();

const STUDENT_SELECT = `
  SELECT s.id, s.display_name, s.status, s.roster_key, s.user_id, s.created_at,
         p.owner_user_id, p.version AS profile_version, ou.display_name AS owner_name,
         EXISTS (SELECT 1 FROM school_memberships om
                 WHERE om.user_id = p.owner_user_id AND om.school_id = s.school_id AND om.status = 'active') AS owner_active,
         (SELECT e.standard FROM student_enrollments e JOIN academic_years ay ON ay.id = e.academic_year_id
          WHERE e.student_id = s.id AND ay.school_id = s.school_id
          ORDER BY ay.is_current DESC, ay.starts_on DESC, ay.label DESC LIMIT 1) AS standard
  FROM students s
  LEFT JOIN crm_student_profiles p ON p.student_id = s.id AND p.school_id = s.school_id
  LEFT JOIN users ou ON ou.id = p.owner_user_id`;

function serializeStudent(row) {
  const ownerActive = Boolean(row.owner_user_id) && Number(row.owner_active) === 1;
  return {
    id: row.id,
    name: row.display_name,
    status: row.status,
    lifecycle: derivePersonLifecycle({ studentStatus: row.status }),
    standard: row.standard || null,
    hasLogin: Boolean(row.user_id),
    owner: ownerActive ? { userId: row.owner_user_id, name: row.owner_name || null } : null,
    ownerUserId: row.owner_user_id || null,
    version: Number(row.profile_version || 0),
    createdAt: row.created_at,
  };
}

/** Active batches per student: `{ [studentId]: [{ id, name }] }`. */
async function activeBatches(db, scope, ids) {
  if (!ids.length) return {};
  const result = await db.execute({
    sql: `SELECT m.student_id, b.id, b.name FROM batch_memberships m
          JOIN batches b ON b.id = m.batch_id AND b.school_id = ?
          WHERE m.status = 'active' AND m.student_id IN (${ids.map(() => '?').join(', ')})
          ORDER BY b.name`,
    args: [scope.schoolId, ...ids],
  });
  const map = {};
  for (const row of result.rows) (map[row.student_id] ||= []).push({ id: row.id, name: row.name });
  return map;
}

/** Primary guardian per student, only for people who may see contact data. */
async function primaryGuardians(db, scope, ids) {
  if (!ids.length) return {};
  const result = await db.execute({
    sql: `SELECT g.student_id, c.full_name, c.phone_e164 FROM crm_guardian_links g
          JOIN crm_contacts c ON c.id = g.contact_id AND c.school_id = g.school_id AND c.anonymised_at IS NULL
          WHERE g.school_id = ? AND g.status = 'active' AND g.is_primary = 1 AND g.student_id IN (${ids.map(() => '?').join(', ')})`,
    args: [scope.schoolId, ...ids],
  });
  return Object.fromEntries(result.rows.map((row) => [row.student_id, { name: row.full_name || null, phone: row.phone_e164 || null }]));
}

export async function listStudents({ db, scope, input }) {
  const { limit, cursor, q, status, batchId } = input.query;
  const after = decodeCursor(cursor, 2);
  const clauses = ['s.school_id = ?', "s.status != 'archived'"];
  const args = [scope.schoolId];
  if (status !== 'all') { clauses.push('s.status = ?'); args.push(status); }
  if (q) { clauses.push("s.display_name LIKE ? ESCAPE '\\'"); args.push(`%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`); }
  if (batchId) {
    clauses.push(`EXISTS (SELECT 1 FROM batch_memberships m JOIN batches b ON b.id = m.batch_id
                          WHERE m.student_id = s.id AND m.batch_id = ? AND m.status = 'active' AND b.school_id = s.school_id)`);
    args.push(batchId);
  }
  if (after) { clauses.push('(lower(s.display_name) > ? OR (lower(s.display_name) = ? AND s.id > ?))'); args.push(after[0], after[0], after[1]); }
  const result = await db.execute({
    sql: `${STUDENT_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY lower(s.display_name), s.id LIMIT ?`,
    args: [...args, limit + 1],
  });
  const page = toPage(result.rows, limit, (row) => [String(row.display_name).toLowerCase(), row.id], serializeStudent);
  const ids = page.items.map((item) => item.id);
  const showContacts = can(scope, 'crm.contacts.read');
  const [batches, tags, guardians] = await Promise.all([
    activeBatches(db, scope, ids),
    tagsFor(db, scope, 'student', ids),
    showContacts ? primaryGuardians(db, scope, ids) : {},
  ]);
  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      batches: batches[item.id] || [],
      tags: tags[item.id] || [],
      primaryGuardian: showContacts ? guardians[item.id] || null : undefined,
    })),
  };
}

export async function listStudentBatches({ db, scope }) {
  const result = await db.execute({
    sql: "SELECT id, name, grade, academic_year FROM batches WHERE school_id = ? AND status = 'active' ORDER BY name",
    args: [scope.schoolId],
  });
  return { items: result.rows.map((row) => ({ id: row.id, name: row.name, grade: row.grade || null, academicYear: row.academic_year || null })), nextCursor: null };
}

async function loadStudentRow(db, scope, id) {
  const result = await db.execute({ sql: `${STUDENT_SELECT} WHERE s.id = ? AND s.school_id = ? AND s.status != 'archived'`, args: [id, scope.schoolId] });
  if (!result.rows[0]) throw crmErrors.notFound();
  return result.rows[0];
}

async function studentProgress(db, scope, id) {
  const result = await db.execute({
    sql: `SELECT sub.id, sub.score, sub.max_marks, sub.status, sub.review_status, sub.created_at,
                 e.name AS exam_name, e.exam_date, sj.name AS subject,
                 EXISTS (SELECT 1 FROM report_versions rv WHERE rv.submission_id = sub.id AND rv.status = 'published') AS published
          FROM submissions sub
          JOIN exams e ON e.id = sub.exam_id AND e.school_id = ?
          LEFT JOIN subjects sj ON sj.id = e.subject_id
          WHERE sub.student_id = ?
          ORDER BY COALESCE(e.exam_date, sub.created_at) DESC LIMIT 10`,
    args: [scope.schoolId, id],
  });
  return result.rows.map((row) => ({
    id: row.id,
    examName: row.exam_name,
    subject: row.subject || null,
    date: row.exam_date || row.created_at,
    score: row.score === null ? null : Number(row.score),
    maxMarks: row.max_marks === null ? null : Number(row.max_marks),
    status: row.status,
    reviewStatus: row.review_status,
    reportPublished: Number(row.published) === 1,
  }));
}

/** One student for the CRM profile (CRM-007). */
export async function getStudent({ db, scope, input }) {
  const row = await loadStudentRow(db, scope, input.query.studentId);
  const student = serializeStudent(row);
  const [memberships, enrollments, tags, lead, progress] = await Promise.all([
    db.execute({
      sql: `SELECT m.id, m.status, m.joined_at, m.left_at, b.id AS batch_id, b.name, b.grade, b.academic_year
            FROM batch_memberships m JOIN batches b ON b.id = m.batch_id AND b.school_id = ?
            WHERE m.student_id = ? ORDER BY m.status = 'active' DESC, m.joined_at DESC`,
      args: [scope.schoolId, student.id],
    }),
    db.execute({
      sql: `SELECT e.id, e.standard, e.status, ay.label, ay.is_current FROM student_enrollments e
            JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.school_id = ?
            WHERE e.student_id = ? ORDER BY ay.is_current DESC, ay.starts_on DESC, ay.label DESC`,
      args: [scope.schoolId, student.id],
    }),
    tagsFor(db, scope, 'student', [student.id]),
    can(scope, 'crm.leads.read')
      ? db.execute({ sql: 'SELECT id, learner_name FROM crm_leads WHERE school_id = ? AND converted_student_id = ?', args: [scope.schoolId, student.id] })
      : null,
    can(scope, 'crm.progress.read') ? studentProgress(db, scope, student.id) : null,
  ]);
  return {
    ...student,
    // The report pages outside the CRM are keyed by the student's login.
    reportUsername: student.hasLogin ? row.roster_key || null : null,
    tags: tags[student.id] || [],
    batches: memberships.rows.map((m) => ({
      membershipId: m.id, batchId: m.batch_id, name: m.name, grade: m.grade || null, academicYear: m.academic_year || null,
      status: m.status, joinedAt: m.joined_at, leftAt: m.left_at || null,
    })),
    enrollments: enrollments.rows.map((e) => ({ id: e.id, academicYear: e.label, standard: e.standard, status: e.status, isCurrent: Number(e.is_current) === 1 })),
    convertedFromLead: lead?.rows[0] ? { id: lead.rows[0].id, name: lead.rows[0].learner_name } : null,
    progress,
  };
}

export async function listStudentOwners({ db, scope }) {
  return { items: await membersWith(db, scope.schoolId, 'crm.students.read'), nextCursor: null };
}

export async function setStudentOwner({ db, scope, input }) {
  const { studentId: id, ownerUserId, expectedVersion: version } = input.body;
  await assertRecord(db, scope, 'student', id, 'write');
  await assertAssignable(db, scope.schoolId, ownerUserId, 'crm.students.read');
  const row = await loadStudentRow(db, scope, id);
  const from = row.owner_user_id || null;
  if (from === ownerUserId) throw crmErrors.validation([{ path: 'ownerUserId', message: 'This person already owns the student' }]);
  const now = new Date().toISOString();
  const write = version === 0
    ? {
      sql: `INSERT INTO crm_student_profiles (student_id, school_id, owner_user_id, created_at, updated_at)
            SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM crm_student_profiles WHERE student_id = ?)`,
      args: [id, scope.schoolId, ownerUserId, now, now, id],
    }
    : {
      sql: `UPDATE crm_student_profiles SET owner_user_id = ?, version = version + 1, updated_at = ?
            WHERE student_id = ? AND school_id = ? AND version = ?`,
      args: [ownerUserId, now, id, scope.schoolId, version],
    };
  const results = await db.batch([
    write,
    auditStatement(scope, { action: 'student.owner_changed', entityId: id, summary: { fromOwnerUserId: from, toOwnerUserId: ownerUserId }, onlyIfChanged: true, now }),
  ], 'write');
  if (!Number(results[0].rowsAffected)) throw versionConflict(Number(row.profile_version || 0));
  return serializeStudent(await loadStudentRow(db, scope, id));
}
