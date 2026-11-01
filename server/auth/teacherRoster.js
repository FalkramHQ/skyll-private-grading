import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { database, ensureAuthTables, hashPassword, requireUser } from '../../api/_lib/auth.js';
import { internalError } from '../../api/_lib/httpError.js';
import { normalizePersonName } from '../../shared/crm/leads.js';

const require = createRequire(import.meta.url);
const { assertStudentCredential, createStudentPassword } = require('../../scripts/lib/credentialPolicy.cjs');

const text = (value, max = 120) => String(value || '').trim().slice(0, max);
const id = (prefix) => `${prefix}_${randomUUID()}`;
const now = () => new Date().toISOString();

function fail(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  throw error;
}

/** Collapse punctuation/spacing and common Shri-/Sri- spellings for roster dedupe. */
export const normalizeRosterName = normalizePersonName;

function studentUsername() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

async function activeBatches(db, schoolId, batchIds) {
  const ids = [...new Set((Array.isArray(batchIds) ? batchIds : []).map((value) => text(value, 80)).filter(Boolean))];
  if (!ids.length) fail(400, 'Select at least one active batch');
  const placeholders = ids.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT id, grade, academic_year_id FROM batches
          WHERE school_id = ? AND status = 'active' AND id IN (${placeholders})`,
    args: [schoolId, ...ids],
  });
  if (result.rows.length !== ids.length) fail(400, 'One or more selected batches are unavailable');
  return result.rows;
}

async function uniqueUsername(db, requested) {
  const candidate = text(requested, 6).toLowerCase();
  if (candidate) {
    if (!/^[a-z0-9]{6}$/.test(candidate)) fail(400, 'Student username must be exactly six lowercase letters or digits');
    const found = await db.execute({ sql: 'SELECT 1 FROM user_credentials WHERE login_id = ? LIMIT 1', args: [candidate] });
    if (found.rows.length) fail(409, 'That student username is already in use');
    return candidate;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const generated = studentUsername();
    const found = await db.execute({ sql: 'SELECT 1 FROM user_credentials WHERE login_id = ? LIMIT 1', args: [generated] });
    if (!found.rows.length) return generated;
  }
  fail(503, 'Could not generate a unique student username; please try again');
}

function batchPayload(row) {
  return { id: row.id, name: row.name, grade: row.grade || '', board: row.board || '', stream: row.stream || '', academicYear: row.academic_year || '', studentCount: Number(row.student_count || 0) };
}

async function listRoster(db, schoolId) {
  const [batches, students] = await Promise.all([
    db.execute({
      sql: `SELECT b.id, b.name, b.grade, b.board, b.stream, b.academic_year, COUNT(m.student_id) AS student_count
            FROM batches b LEFT JOIN batch_memberships m ON m.batch_id = b.id AND m.status = 'active'
            WHERE b.school_id = ? AND b.status = 'active'
            GROUP BY b.id, b.name, b.grade, b.board, b.stream, b.academic_year
            ORDER BY b.grade COLLATE NOCASE, b.name COLLATE NOCASE`, args: [schoolId],
    }),
    db.execute({
      sql: `SELECT s.id, s.display_name, credential.login_id AS username,
                   GROUP_CONCAT(b.id) AS batch_ids, GROUP_CONCAT(b.name, ' | ') AS batch_names
            FROM students s
            LEFT JOIN student_user_links link ON link.student_id = s.id AND link.school_id = ? AND link.link_status = 'confirmed'
            LEFT JOIN user_credentials credential ON credential.user_id = link.user_id AND credential.is_primary = 1 AND credential.status = 'active'
            LEFT JOIN batch_memberships membership ON membership.student_id = s.id AND membership.status = 'active'
            LEFT JOIN batches b ON b.id = membership.batch_id AND b.school_id = ? AND b.status = 'active'
            WHERE s.school_id = ? AND s.status = 'active'
            GROUP BY s.id, s.display_name, credential.login_id
            ORDER BY s.display_name COLLATE NOCASE`, args: [schoolId, schoolId, schoolId],
    }),
  ]);
  return {
    batches: batches.rows.map(batchPayload),
    students: students.rows.map((row) => ({ id: row.id, name: row.display_name, username: row.username || '', batchIds: row.batch_ids ? String(row.batch_ids).split(',') : [], batches: row.batch_names ? String(row.batch_names).split(' | ') : [] })),
  };
}

async function createBatch(db, user, payload) {
  const name = text(payload.name); const grade = text(payload.grade, 40);
  if (!name) fail(400, 'Batch name is required');
  const timestamp = now();
  const existing = await db.execute({ sql: 'SELECT id FROM batches WHERE school_id = ? AND status = \'active\' AND lower(name) = lower(?) LIMIT 1', args: [user.school_id, name] });
  if (existing.rows.length) fail(409, 'An active batch with this name already exists');
  const year = text(payload.academicYear, 40);
  const yearResult = year ? await db.execute({ sql: 'SELECT id FROM academic_years WHERE school_id = ? AND label = ? LIMIT 1', args: [user.school_id, year] }) : { rows: [] };
  const batchId = id('batch');
  await db.execute({ sql: `INSERT INTO batches (id, school, school_id, name, grade, board, stream, academic_year, academic_year_id, status, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, args: [batchId, user.school, user.school_id, name, grade || null, text(payload.board, 60) || null, text(payload.stream, 60) || null, year || null, yearResult.rows[0]?.id || null, timestamp, timestamp] });
  return { id: batchId };
}

async function updateBatch(db, user, payload) {
  const batchId = text(payload.id, 80); const name = text(payload.name);
  if (!batchId || !name) fail(400, 'Batch ID and name are required');
  const found = await db.execute({ sql: 'SELECT id FROM batches WHERE id = ? AND school_id = ? AND status = \'active\'', args: [batchId, user.school_id] });
  if (!found.rows.length) fail(404, 'Batch not found');
  const duplicate = await db.execute({ sql: 'SELECT id FROM batches WHERE school_id = ? AND status = \'active\' AND lower(name) = lower(?) AND id != ? LIMIT 1', args: [user.school_id, name, batchId] });
  if (duplicate.rows.length) fail(409, 'An active batch with this name already exists');
  const year = text(payload.academicYear, 40);
  const yearResult = year ? await db.execute({ sql: 'SELECT id FROM academic_years WHERE school_id = ? AND label = ? LIMIT 1', args: [user.school_id, year] }) : { rows: [] };
  await db.execute({ sql: `UPDATE batches SET name = ?, grade = ?, board = ?, stream = ?, academic_year = ?, academic_year_id = ?, updated_at = ?
                           WHERE id = ? AND school_id = ? AND status = 'active'`, args: [name, text(payload.grade, 40) || null, text(payload.board, 60) || null, text(payload.stream, 60) || null, year || null, yearResult.rows[0]?.id || null, now(), batchId, user.school_id] });
}

async function archiveBatch(db, user, batchId) {
  const membership = await db.execute({ sql: `SELECT COUNT(*) AS count FROM batch_memberships m JOIN batches b ON b.id = m.batch_id
                                               WHERE b.id = ? AND b.school_id = ? AND b.status = 'active' AND m.status = 'active'`, args: [batchId, user.school_id] });
  if (Number(membership.rows[0]?.count || 0) > 0) fail(409, 'Remove or move active students before archiving this batch');
  const result = await db.execute({ sql: "UPDATE batches SET status = 'archived', updated_at = ? WHERE id = ? AND school_id = ? AND status = 'active'", args: [now(), batchId, user.school_id] });
  if (!result.rowsAffected) fail(404, 'Batch not found');
}

async function assertNoDuplicateStudentName(db, schoolId, name, { excludeStudentId = null } = {}) {
  const normalized = normalizeRosterName(name);
  if (!normalized) return;
  const existing = await db.execute({
    sql: `SELECT s.id, s.display_name, credential.login_id AS username
          FROM students s
          LEFT JOIN student_user_links link ON link.student_id = s.id AND link.school_id = ? AND link.link_status = 'confirmed'
          LEFT JOIN user_credentials credential ON credential.user_id = COALESCE(s.user_id, link.user_id) AND credential.is_primary = 1 AND credential.status = 'active'
          WHERE s.school_id = ? AND s.status = 'active'`,
    args: [schoolId, schoolId],
  });
  const clash = existing.rows.find((row) => {
    if (excludeStudentId && row.id === excludeStudentId) return false;
    return normalizeRosterName(row.display_name) === normalized;
  });
  if (clash) {
    const label = clash.username ? `${clash.display_name} (${clash.username})` : clash.display_name;
    fail(409, `An active student named "${label}" already exists. Edit that record instead of creating a duplicate.`);
  }
}

async function createStudent(db, user, payload) {
  const name = text(payload.name); if (!name) fail(400, 'Student name is required');
  const batches = await activeBatches(db, user.school_id, payload.batchIds);
  await assertNoDuplicateStudentName(db, user.school_id, name);
  const username = await uniqueUsername(db, payload.username);
  const password = createStudentPassword(); assertStudentCredential({ username, password });
  const timestamp = now(); const studentId = id('student'); const userId = id('user');
  const enrollmentYear = batches.find((batch) => batch.academic_year_id)?.academic_year_id || null;
  const standard = text(payload.standard, 40) || text(batches.find((batch) => batch.grade)?.grade, 40);
  const writes = [
    { sql: "INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)", args: [userId, name, timestamp, timestamp] },
    { sql: "INSERT INTO user_credentials (id, user_id, login_id, password_hash, credential_type, is_primary, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'password', 1, 'active', ?, ?)", args: [id('credential'), userId, username, hashPassword(password), timestamp, timestamp] },
    { sql: "INSERT INTO school_memberships (id, school_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'student', 'active', ?, ?)", args: [id('membership'), user.school_id, userId, timestamp, timestamp] },
    { sql: "INSERT INTO students (id, school, school_id, user_id, display_name, roster_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)", args: [studentId, user.school, user.school_id, userId, name, username, timestamp, timestamp] },
    { sql: "INSERT INTO student_user_links (student_id, user_id, school_id, link_status, linked_by, linked_at) VALUES (?, ?, ?, 'confirmed', ?, ?)", args: [studentId, userId, user.school_id, user.user_id, timestamp] },
  ];
  if (enrollmentYear && standard) writes.push({ sql: "INSERT INTO student_enrollments (id, student_id, academic_year_id, standard, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)", args: [id('enrollment'), studentId, enrollmentYear, standard, timestamp, timestamp] });
  for (const batch of batches) writes.push({ sql: "INSERT INTO batch_memberships (id, batch_id, student_id, status, joined_at, left_at, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, NULL, ?, ?)", args: [id('membership'), batch.id, studentId, timestamp, timestamp, timestamp] });
  await db.batch(writes, 'write');
  return { id: studentId, username, password };
}

async function updateStudent(db, user, payload) {
  const studentId = text(payload.id, 80); const name = text(payload.name);
  if (!studentId || !name) fail(400, 'Student ID and name are required');
  const found = await db.execute({ sql: "SELECT id, user_id FROM students WHERE id = ? AND school_id = ? AND status = 'active'", args: [studentId, user.school_id] });
  if (!found.rows.length) fail(404, 'Student not found');
  await assertNoDuplicateStudentName(db, user.school_id, name, { excludeStudentId: studentId });
  const batches = await activeBatches(db, user.school_id, payload.batchIds);
  const timestamp = now();
  const enrollmentYear = batches.find((batch) => batch.academic_year_id)?.academic_year_id || null;
  const standard = text(payload.standard, 40) || text(batches.find((batch) => batch.grade)?.grade, 40);
  const writes = [
    { sql: "UPDATE students SET display_name = ?, updated_at = ? WHERE id = ? AND school_id = ? AND status = 'active'", args: [name, timestamp, studentId, user.school_id] },
    { sql: "UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?", args: [name, timestamp, found.rows[0].user_id] },
    { sql: `UPDATE batch_memberships SET status = 'inactive', left_at = ?, updated_at = ?
            WHERE student_id = ? AND status = 'active'
              AND batch_id IN (SELECT id FROM batches WHERE school_id = ?)`, args: [timestamp, timestamp, studentId, user.school_id] },
  ];
  if (enrollmentYear && standard) writes.push({
    sql: `INSERT INTO student_enrollments (id, student_id, academic_year_id, standard, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?)
          ON CONFLICT(student_id, academic_year_id) DO UPDATE SET standard = excluded.standard, status = 'active', updated_at = excluded.updated_at`,
    args: [id('enrollment'), studentId, enrollmentYear, standard, timestamp, timestamp],
  });
  for (const batch of batches) writes.push({ sql: "INSERT INTO batch_memberships (id, batch_id, student_id, status, joined_at, left_at, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, NULL, ?, ?) ON CONFLICT(batch_id, student_id) WHERE status = 'active' DO UPDATE SET joined_at = excluded.joined_at, updated_at = excluded.updated_at", args: [id('membership'), batch.id, studentId, timestamp, timestamp, timestamp] });
  await db.batch(writes, 'write');
}

async function archiveStudent(db, user, studentId) {
  const found = await db.execute({ sql: "SELECT id, user_id FROM students WHERE id = ? AND school_id = ? AND status = 'active'", args: [studentId, user.school_id] });
  if (!found.rows.length) fail(404, 'Student not found');
  const timestamp = now();
  await db.batch([
    { sql: "UPDATE students SET status = 'archived', updated_at = ? WHERE id = ? AND school_id = ?", args: [timestamp, studentId, user.school_id] },
    { sql: `UPDATE batch_memberships SET status = 'inactive', left_at = ?, updated_at = ?
            WHERE student_id = ? AND status = 'active'
              AND batch_id IN (SELECT id FROM batches WHERE school_id = ?)`, args: [timestamp, timestamp, studentId, user.school_id] },
    { sql: "UPDATE school_memberships SET status = 'inactive', updated_at = ? WHERE user_id = ? AND school_id = ? AND role = 'student'", args: [timestamp, found.rows[0].user_id, user.school_id] },
    { sql: "UPDATE user_credentials SET status = 'disabled', updated_at = ? WHERE user_id = ?", args: [timestamp, found.rows[0].user_id] },
    { sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", args: [timestamp, found.rows[0].user_id] },
  ], 'write');
}

export default async function handler(req, res) {
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['teacher', 'admin']);
    if (!user) return;
    const db = database();
    if (req.method === 'GET') return res.status(200).json(await listRoster(db, user.school_id));
    const resource = text(req.body?.resource, 20);
    if (!['batch', 'student'].includes(resource)) return res.status(400).json({ error: 'Resource must be batch or student' });
    let result;
    if (req.method === 'POST') result = resource === 'batch' ? await createBatch(db, user, req.body) : await createStudent(db, user, req.body);
    else if (req.method === 'PATCH') result = resource === 'batch' ? await updateBatch(db, user, req.body) : await updateStudent(db, user, req.body);
    else if (req.method === 'DELETE') result = resource === 'batch' ? await archiveBatch(db, user, text(req.body?.id, 80)) : await archiveStudent(db, user, text(req.body?.id, 80));
    else return res.status(405).json({ error: 'Method not allowed' });
    return res.status(req.method === 'POST' ? 201 : 200).json({ ok: true, result: result || null, ...(await listRoster(db, user.school_id)) });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return internalError(res, error, 'auth/teacher-roster');
  }
}
