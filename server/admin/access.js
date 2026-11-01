import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { database, ensureAuthTables, hashPassword, requireUser } from '../../api/_lib/auth.js';
import { internalError } from '../../api/_lib/httpError.js';
import { SCHOOL_FEATURES } from '../../api/_lib/featureFlags.js';

const require = createRequire(import.meta.url);
const { assertStaffPassword, createAdminPassword, institutionSlug } = require('../../scripts/lib/credentialPolicy.cjs');

/**
 * Access administration, folded into the auth catch-all (12-function cap):
 *
 *   GET  /api/auth/admin/users     memberships joined to users, credentials and
 *                                  last session. admin: own school; skyll_admin:
 *                                  every school, optional ?schoolId= filter.
 *   GET  /api/auth/admin/flags     school feature flags (skyll_admin only)
 *   POST /api/auth/admin/flags     { schoolId, featureKey, enabled } (skyll_admin only)
 *   POST /api/auth/admin/teachers  { schoolId?, displayName, loginId? } → a
 *                                  teacher login; the password is returned once.
 *
 * Every query is scoped by canonical school id (school_memberships.school_id,
 * school_feature_flags.school_id), never by display name.
 */

const text = (value, max = 120) => String(value ?? '').trim().slice(0, max);
const id = (prefix) => `${prefix}_${randomUUID()}`;
const now = () => new Date().toISOString();
const LOGIN_ID = /^[a-z0-9][a-z0-9_.-]{3,39}$/;
const STAFF_ROLES = ['skyll_admin', 'school_admin', 'admin', 'teacher', 'scanner', 'staff'];

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function queryValue(req, key) {
  const value = req.query?.[key];
  return text(Array.isArray(value) ? value[0] : value, 80);
}

/** The school a request acts on: admins are pinned to their own; platform admins must name one. */
function targetSchoolId(user, requested) {
  if (user.role !== 'skyll_admin') return user.school_id || fail(409, 'Your session is not pinned to a school');
  return requested || null;
}

async function listSchools(db) {
  const result = await db.execute({ sql: "SELECT id, slug, display_name FROM schools WHERE status = 'active' ORDER BY display_name COLLATE NOCASE" });
  return result.rows.map((row) => ({ id: row.id, slug: row.slug, name: row.display_name }));
}

async function schoolById(db, schoolId) {
  if (!schoolId) fail(400, 'schoolId is required');
  const result = await db.execute({ sql: "SELECT id, slug, display_name FROM schools WHERE id = ? AND status = 'active' LIMIT 1", args: [schoolId] });
  return result.rows[0] || fail(404, 'School not found');
}

export function presentMembership(row) {
  return {
    membershipId: row.membership_id,
    userId: row.user_id,
    displayName: row.display_name || row.login_id || '',
    loginId: row.login_id || null,
    role: row.role === 'school_admin' ? 'admin' : row.role,
    schoolId: row.school_id,
    school: row.school,
    status: row.membership_status === 'active' && row.user_status === 'active' && (row.credential_status || 'active') === 'active' ? 'active' : 'inactive',
    membershipStatus: row.membership_status,
    userStatus: row.user_status,
    credentialStatus: row.credential_status || null,
    createdAt: row.created_at || null,
    lastSessionAt: row.last_session_at || null,
  };
}

async function listUsers(db, { schoolId, role, includeStudents }) {
  const where = [];
  const args = [];
  if (schoolId) { where.push('m.school_id = ?'); args.push(schoolId); }
  if (role) { where.push(role === 'admin' ? "m.role IN ('admin', 'school_admin')" : 'm.role = ?'); if (role !== 'admin') args.push(role); }
  else if (!includeStudents) { where.push(`m.role IN (${STAFF_ROLES.map(() => '?').join(', ')})`); args.push(...STAFF_ROLES); }
  const result = await db.execute({
    sql: `SELECT m.id AS membership_id, m.role, m.status AS membership_status, m.created_at,
                 u.id AS user_id, u.display_name, u.status AS user_status,
                 c.login_id, c.status AS credential_status,
                 s.id AS school_id, s.display_name AS school,
                 (SELECT MAX(COALESCE(ss.last_seen_at, ss.created_at)) FROM sessions ss WHERE ss.user_id = u.id) AS last_session_at
          FROM school_memberships m
          JOIN users u ON u.id = m.user_id
          JOIN schools s ON s.id = m.school_id
          LEFT JOIN user_credentials c ON c.user_id = u.id AND c.is_primary = 1
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY s.display_name COLLATE NOCASE, m.role, c.login_id COLLATE NOCASE
          LIMIT 500`,
    args,
  });
  return result.rows.map(presentMembership);
}

export async function adminUsers(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['admin', 'skyll_admin']);
    if (!user) return;
    const db = database();
    const schoolId = targetSchoolId(user, queryValue(req, 'schoolId'));
    const role = queryValue(req, 'role');
    const includeStudents = queryValue(req, 'includeStudents') === '1';
    const [users, schools] = await Promise.all([
      listUsers(db, { schoolId, role, includeStudents }),
      user.role === 'skyll_admin' ? listSchools(db) : Promise.resolve([{ id: user.school_id, name: user.school }]),
    ]);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ users, schools, scope: { schoolId, role: role || null, includeStudents } });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return internalError(res, error, 'admin/users');
  }
}

async function listFlags(db, schoolId) {
  const scope = schoolId ? { where: 'WHERE f.school_id = ?', args: [schoolId] } : { where: '', args: [] };
  const result = await db.execute({
    sql: `SELECT f.school_id, s.display_name AS school, f.feature_key, f.enabled, f.updated_by, f.updated_at
          FROM school_feature_flags f JOIN schools s ON s.id = f.school_id
          ${scope.where}
          ORDER BY s.display_name COLLATE NOCASE, f.feature_key`,
    args: scope.args,
  });
  return result.rows.map((row) => ({ schoolId: row.school_id, school: row.school, featureKey: row.feature_key, enabled: Number(row.enabled) === 1, updatedBy: row.updated_by || null, updatedAt: row.updated_at || null }));
}

export async function adminFlags(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['skyll_admin']);
    if (!user) return;
    const db = database();
    if (req.method === 'GET') {
      const schoolId = queryValue(req, 'schoolId') || null;
      const [flags, schools] = await Promise.all([listFlags(db, schoolId), listSchools(db)]);
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({ features: SCHOOL_FEATURES, flags, schools });
    }
    const schoolId = text(req.body?.schoolId, 80);
    const featureKey = text(req.body?.featureKey, 60);
    const enabled = req.body?.enabled;
    if (!SCHOOL_FEATURES.includes(featureKey)) return res.status(400).json({ error: 'Unknown feature key', features: SCHOOL_FEATURES });
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    const school = await schoolById(db, schoolId);
    const at = now();
    await db.execute({
      sql: `INSERT INTO school_feature_flags (school_id, feature_key, enabled, updated_by, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(school_id, feature_key) DO UPDATE SET
              enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      args: [school.id, featureKey, enabled ? 1 : 0, user.username, at],
    });
    return res.status(200).json({ ok: true, flag: { schoolId: school.id, school: school.display_name, featureKey, enabled, updatedBy: user.username, updatedAt: at } });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return internalError(res, error, 'admin/flags');
  }
}

function slugPart(value) {
  return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24);
}

async function loginIdTaken(db, loginId) {
  const found = await db.execute({ sql: 'SELECT 1 FROM user_credentials WHERE login_id = ? LIMIT 1', args: [loginId] });
  return found.rows.length > 0;
}

/** Requested login id if free, else <school>_<name>[_n] in the style of existing staff logins. */
async function teacherLoginId(db, school, displayName, requested) {
  const candidate = text(requested, 40).toLowerCase();
  if (candidate) {
    if (!LOGIN_ID.test(candidate)) fail(400, 'Login id must be 4-40 lowercase letters, digits, dots, dashes or underscores');
    if (await loginIdTaken(db, candidate)) fail(409, 'That login id is already in use');
    return candidate;
  }
  const base = `${institutionSlug(school.display_name)}_${slugPart(displayName) || 'teacher'}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const generated = attempt ? `${base}_${attempt + 1}` : base;
    if (!(await loginIdTaken(db, generated))) return generated;
  }
  fail(503, 'Could not generate a unique login id; please provide one');
}

export async function adminTeachers(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await ensureAuthTables();
    const user = await requireUser(req, res, ['admin', 'skyll_admin']);
    if (!user) return;
    const db = database();
    const displayName = text(req.body?.displayName);
    if (displayName.length < 2) return res.status(400).json({ error: 'Display name is required (min 2 characters)' });
    const school = await schoolById(db, targetSchoolId(user, text(req.body?.schoolId, 80)));
    const loginId = await teacherLoginId(db, school, displayName, req.body?.loginId);
    const password = createAdminPassword();
    assertStaffPassword(password, 'Teacher password');
    const at = now();
    const userId = id('user');
    // Same rows provisioning and the roster create: user + primary password
    // credential + active membership, written in one batch.
    await db.batch([
      { sql: "INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)", args: [userId, displayName, at, at] },
      { sql: "INSERT INTO user_credentials (id, user_id, login_id, password_hash, credential_type, is_primary, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'password', 1, 'active', ?, ?)", args: [id('cred'), userId, loginId, hashPassword(password), at, at] },
      { sql: "INSERT INTO school_memberships (id, school_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'teacher', 'active', ?, ?)", args: [id('mem'), school.id, userId, at, at] },
    ], 'write');
    return res.status(201).json({
      ok: true,
      teacher: { userId, displayName, loginId, role: 'teacher', schoolId: school.id, school: school.display_name, loginUrl: school.slug ? `/${school.slug}` : null },
      // Shown once; the hash is all that is stored.
      password,
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return internalError(res, error, 'admin/teachers');
  }
}

export default async function handler(req, res, segments = []) {
  const resource = String(segments[0] || '');
  if (resource === 'users') return adminUsers(req, res);
  if (resource === 'flags') return adminFlags(req, res);
  if (resource === 'teachers') return adminTeachers(req, res);
  return res.status(404).json({ error: 'Admin endpoint not found' });
}
