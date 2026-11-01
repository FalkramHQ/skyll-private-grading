import { createRequire } from 'node:module';
import { randomUUID } from 'crypto';
import { database, hashPassword, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { ensureIntakeTables } from '../../api/_lib/intake.js';
import { normalizePhone } from '../parent/contact.js';
import { primaryGuardianStatements } from '../crm/contacts.js';

const require = createRequire(import.meta.url);
const { assertStudentCredential, createStudentPassword } = require('../../scripts/lib/credentialPolicy.cjs');

const id = (prefix) => `${prefix}_${randomUUID()}`;
const nowIso = () => new Date().toISOString();

function studentUsername() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

export async function uniqueStudentLoginId(db) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const generated = studentUsername();
    const found = await db.execute({ sql: 'SELECT 1 FROM user_credentials WHERE login_id = ? LIMIT 1', args: [generated] });
    if (!found.rows.length) return generated;
  }
  throw new Error('Could not generate a unique student username; please try again');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await requireUser(req, res, ['skyll_admin', 'admin']);
  if (!user) return;

  const { schoolId, schoolName, batches, students } = req.body || {};
  const scopedSchoolId = user.role === 'skyll_admin' ? schoolId : user.school_id;
  const scopedSchoolName = user.role === 'skyll_admin' ? schoolName : user.school;
  if (!scopedSchoolId || !scopedSchoolName) {
    return res.status(400).json({ error: 'schoolId and schoolName required' });
  }
  if (user.role !== 'skyll_admin' && schoolId && schoolId !== user.school_id) {
    return res.status(403).json({ error: 'School access denied' });
  }
  if (!Array.isArray(batches) || !Array.isArray(students) || !batches.length || !students.length) {
    return res.status(400).json({ error: 'At least one batch and one student required' });
  }

  try {
    await ensureAuthTables();
    await ensureIntakeTables();
    const db = database();
    const now = nowIso();

    const batchLabelToId = new Map();
    for (const batch of batches) {
      const label = String(batch.label || batch.name || '').trim();
      if (!label) continue;
      const batchId = id('batch');
      await db.execute({
        sql: `INSERT INTO batches (id, school, name, grade, board, stream, academic_year, school_id, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        args: [
          batchId, scopedSchoolName, label, batch.grade || null,
          batch.board || null, batch.stream || null,
          batch.academicYear || null, scopedSchoolId, now, now,
        ],
      });
      batchLabelToId.set(label, batchId);
    }

    const created = [];
    for (const student of students) {
      const displayName = String(student.displayName || student.name || '').trim();
      if (!displayName) continue;
      const studentId = id('student');
      const userId = id('user');
      const loginId = await uniqueStudentLoginId(db);
      const password = createStudentPassword();
      assertStudentCredential({ username: loginId, password });
      const passwordHash = await hashPassword(password);

      await db.execute({
        sql: `INSERT INTO users (id, display_name, status, created_at, updated_at)
              VALUES (?, ?, 'active', ?, ?)`,
        args: [userId, displayName, now, now],
      });
      await db.execute({
        sql: `INSERT INTO user_credentials (id, user_id, login_id, password_hash, credential_type, is_primary, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'password', 1, 'active', ?, ?)`,
        args: [id('cred'), userId, loginId, passwordHash, now, now],
      });
      await db.execute({
        sql: `INSERT INTO school_memberships (id, school_id, user_id, role, status, created_at, updated_at)
              VALUES (?, ?, ?, 'student', 'active', ?, ?)`,
        args: [id('mem'), scopedSchoolId, userId, now, now],
      });
      const parentPhone = normalizePhone(student.parentPhone || student.parent_phone);
      const parentName = String(student.parentName || student.parent_name || '').trim() || null;

      await db.execute({
        sql: `INSERT INTO students (id, school, display_name, school_id, user_id, roster_key, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        args: [studentId, scopedSchoolName, displayName, scopedSchoolId, userId, loginId, now, now],
      });
      // The parent phone becomes the student's primary guardian contact. A
      // roster file is not the parent's consent, so WhatsApp stays off until
      // staff record it or the parent opts in (CRM M2 phase 2, D4).
      const guardian = await primaryGuardianStatements(db, {
        schoolId: scopedSchoolId, studentId, name: parentName, phone: parentPhone, optedIn: false, actorUserId: user.user_id, now,
      });
      if (guardian.length) await db.batch(guardian, 'write');
      await db.execute({
        sql: `INSERT INTO student_user_links (student_id, user_id, school_id, link_status, linked_by, linked_at)
              VALUES (?, ?, ?, 'confirmed', ?, ?)`,
        args: [studentId, userId, scopedSchoolId, user.user_id, now],
      });

      const studentBatches = student.batchLabels
        || (student.batchLabel ? [student.batchLabel] : []);
      for (const label of studentBatches) {
        const batchId = batchLabelToId.get(label);
        if (batchId) {
          await db.execute({
            sql: `INSERT INTO batch_memberships (id, batch_id, student_id, status, joined_at, created_at, updated_at)
                  VALUES (?, ?, ?, 'active', ?, ?, ?)`,
            args: [id('bmem'), batchId, studentId, now, now, now],
          });
        }
      }

      created.push({
        studentId,
        displayName,
        loginId,
        password,
        parentPhone,
        batches: studentBatches,
      });
    }

    res.status(201).json({
      batchesCreated: batchLabelToId.size,
      studentsCreated: created.length,
      credentials: created,
    });
  } catch (err) {
    console.error('Roster import error:', err);
    return res.status(500).json({ error: 'Roster import failed', details: err.message });
  }
}
