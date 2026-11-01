import { createRequire } from 'node:module';
import { randomUUID } from 'crypto';
import { database, hashPassword, ensureAuthTables, requireUser } from '../../api/_lib/auth.js';
import { ensureSchoolSlugColumn } from './public.js';
import { internalError } from '../../api/_lib/httpError.js';

const require = createRequire(import.meta.url);
const { assertAdminCredential, institutionSlug } = require('../../scripts/lib/credentialPolicy.cjs');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await requireUser(req, res, ['skyll_admin']);
  if (!user) return;

  const { slug, displayName, institutionType, adminUsername, adminPassword } = req.body || {};

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug format (lowercase, alphanumeric, hyphens only)' });
  }
  if (!displayName || displayName.length < 2) {
    return res.status(400).json({ error: 'Display name required (min 2 characters)' });
  }
  const loginId = `${institutionSlug(displayName)}_admin`;
  if (adminUsername && String(adminUsername).toLowerCase() !== loginId) {
    return res.status(400).json({ error: `Admin username must be ${loginId}` });
  }
  try {
    assertAdminCredential({ school: displayName, username: loginId, password: adminPassword });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {
    await ensureAuthTables();
    await ensureSchoolSlugColumn();
    const db = database();

    const existing = await db.execute({
      sql: 'SELECT id FROM schools WHERE slug = ?',
      args: [slug],
    });
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'School slug already exists' });
    }
    // Many checks still compare schools by name with punctuation and case
    // ignored, so two schools must never share that normalized form — "St.
    // Mary's" next to "St Marys" would read each other's data (FLKRM-385).
    const normalized = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const schools = (await db.execute('SELECT display_name, slug FROM schools')).rows;
    const taken = new Set(schools.flatMap((row) => [normalized(row.display_name), normalized(row.slug)]).filter(Boolean));
    if (taken.has(normalized(displayName)) || taken.has(normalized(slug))) {
      return res.status(409).json({ error: 'A school with this name or slug already exists' });
    }

    const schoolId = `school_${randomUUID()}`;
    const now = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO schools (id, slug, display_name, institution_type, status, timezone, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', 'Asia/Kolkata', ?, ?)`,
      args: [schoolId, slug, displayName, institutionType || 'coaching', now, now],
    });

    const userId = `user_${randomUUID()}`;
    const passwordHash = await hashPassword(adminPassword);
    await db.execute({
      sql: `INSERT INTO users (id, display_name, status, created_at, updated_at)
            VALUES (?, ?, 'active', ?, ?)`,
      args: [userId, displayName, now, now],
    });

    await db.execute({
      sql: `INSERT INTO user_credentials (id, user_id, login_id, password_hash, credential_type, is_primary, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'password', 1, 'active', ?, ?)`,
      args: [`cred_${randomUUID()}`, userId, loginId, passwordHash, now, now],
    });

    await db.execute({
      sql: `INSERT INTO school_memberships (id, school_id, user_id, role, status, created_at, updated_at)
            VALUES (?, ?, ?, 'school_admin', 'active', ?, ?)`,
      args: [`mem_${randomUUID()}`, schoolId, userId, now, now],
    });

    res.status(201).json({
      schoolId,
      slug,
      displayName,
      adminUsername: loginId,
      loginUrl: `/${slug}`,
    });
  } catch (err) {
    console.error('School provisioning error:', err);
    return internalError(res, err, 'schools-provision');
  }
}
