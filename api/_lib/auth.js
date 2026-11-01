import crypto from 'node:crypto';
import { createClient } from '@libsql/client/web';
import { tursoAuthToken, tursoUrl } from './env.js';
import { createRetryableInitializer } from './runtimeInitialization.js';
import { resolveSchoolId } from './canonicalSubmissions.js';
import credentials from '../../shared/credentials.cjs';

const { hashPassword, verifyPassword } = credentials;

const client = tursoUrl
  ? createClient({ url: tursoUrl, authToken: tursoAuthToken })
  : null;

const SESSION_DAYS = 14;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
// Caps that hold however the guesses are spread: one account from many
// addresses, or many accounts from one address.
const LOGIN_ACCOUNT_MAX_FAILURES = 30;
const LOGIN_ADDRESS_MAX_FAILURES = 100;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
let canonicalIdentityReady = false;
let canonicalSessionsReady = false;
let pinnedTenancyReady = false;

export function database() {
  if (!client) throw new Error('Database not configured');
  return client;
}

/**
 * The school a portal declares by name, as an id (FLKRM-389). Portals send a
 * display name; resolveSchoolId maps historical spellings to the right school
 * and returns null for an unknown or ambiguous name, so login fails closed.
 */
export async function portalSchoolId(name) {
  return name ? resolveSchoolId(database(), name) : null;
}

// A session's last_seen_at is refreshed at most this often, not on every
// request (the review dashboard polls every 1.2s).
const SESSION_TOUCH_MS = 5 * 60 * 1000;

// Schema probes below let database errors propagate: reading a failed query
// as "not migrated" would turn a blip into signed-out users.

function legacyRole(role) {
  return role === 'school_admin' ? 'admin' : role;
}

export async function canonicalIdentityEnabled() {
  if (canonicalIdentityReady) return true;
  const result = await database().execute({
    sql: "SELECT id FROM schema_migrations WHERE id = '002_canonical_identity_tenancy' LIMIT 1",
  });
  canonicalIdentityReady = result.rows.length > 0;
  return canonicalIdentityReady;
}

async function canonicalSessionsEnabled() {
  if (canonicalSessionsReady) return true;
  const result = await database().execute({
    sql: "SELECT id FROM schema_migrations WHERE id = '006_canonical_sessions' LIMIT 1",
  });
  canonicalSessionsReady = result.rows.length > 0;
  return canonicalSessionsReady;
}

async function pinnedTenancyEnabled() {
  if (pinnedTenancyReady) return true;
  const result = await database().execute({
    sql: "SELECT id FROM schema_migrations WHERE id = '070_pin_session_membership' LIMIT 1",
  });
  pinnedTenancyReady = result.rows.length > 0;
  return pinnedTenancyReady;
}

export async function authenticateUser(loginId, preferredSchool = null, { allowedRoles = [], expectedRole = null } = {}) {
  const db = database();
  if (await canonicalIdentityEnabled()) {
    const result = await db.execute({
      sql: `SELECT u.id AS user_id,
                   COALESCE(primary_credential.login_id, credential.login_id) AS username,
                   credential.password_hash,
                   membership.id AS school_membership_id,
                   membership.role,
                   school.id AS school_id,
                   school.display_name AS school,
                   1 AS active
            FROM user_credentials credential
            JOIN users u ON u.id = credential.user_id AND u.status = 'active'
            JOIN school_memberships membership ON membership.user_id = u.id AND membership.status = 'active'
            JOIN schools school ON school.id = membership.school_id AND school.status = 'active'
            LEFT JOIN user_credentials primary_credential
              ON primary_credential.user_id = u.id AND primary_credential.is_primary = 1 AND primary_credential.status = 'active'
            WHERE credential.login_id = ? AND credential.status = 'active'
            ORDER BY CASE membership.role WHEN 'skyll_admin' THEN 0 ELSE 1 END, school.display_name
            LIMIT 20`,
      args: [loginId],
    });
    // A user can hold several memberships: in different schools, or more than
    // one role in the same school (school_memberships is unique per school,
    // user and role). The membership is decided here, once, from explicit
    // signals — never from row ordering:
    //
    //  - the portal's school (preferredSchool) narrows the schools;
    //  - the roles the portal serves (allowedRoles), and an explicit
    //    expectedRole, narrow the roles;
    //  - whatever is left must be exactly one membership. Otherwise the caller
    //    gets a stub that names what is missing, with tenancy cleared so
    //    createSession refuses it if the flag is ignored.
    const rows = result.rows;
    const portalId = preferredSchool ? await resolveSchoolId(db, preferredSchool) : null;
    const inSchool = preferredSchool ? rows.filter((row) => Boolean(portalId) && row.school_id === portalId) : rows;
    if (!inSchool.length) return null;
    const roles = (row) => [row.role, legacyRole(row.role)];
    const eligible = inSchool.filter((row) => (!allowedRoles.length || roles(row).some((role) => allowedRoles.includes(role)))
      && (!expectedRole || roles(row).includes(expectedRole)));
    const stub = (flags) => ({
      ...inSchool[0],
      role: legacyRole(inSchool[0].role),
      ...flags,
      school_membership_id: null,
      school_id: null,
      school: null,
    });
    // No membership this portal accepts (FLKRM-387).
    if (!eligible.length) return stub({ noPortalAccess: true });
    // Several schools and no portal to choose between them.
    if (new Set(eligible.map((row) => row.school_id)).size > 1) return stub({ needsSchoolPortal: true });
    // One school, several roles: never pick one silently (FLKRM-387).
    if (eligible.length > 1) return stub({ needsRole: true, roleChoices: eligible.map((row) => legacyRole(row.role)) });
    return { ...eligible[0], role: legacyRole(eligible[0].role) };
  }

  // Canonical identity is the only auth path; fail closed if unmigrated.
  return null;
}

const ensureAuthTablesInitialized = createRetryableInitializer(async () => {
  const db = database();
  await db.execute(`CREATE TABLE IF NOT EXISTS credential_rate_limits (
    key_hash TEXT PRIMARY KEY,
    failure_count INTEGER NOT NULL,
    window_started_at TEXT NOT NULL,
    blocked_until TEXT,
    updated_at TEXT NOT NULL
  )`);
});

export function ensureAuthTables() {
  return ensureAuthTablesInitialized();
}

function requestAddress(req) {
  // Vercel's edge appends the real TCP peer to x-forwarded-for, so the
  // rightmost entry is the trustworthy one; the leftmost is client-supplied
  // and trivially spoofable to dodge the rate limit.
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',').pop().trim();
  return forwarded || String(req.headers?.['x-real-ip'] || '').trim() || req.socket?.remoteAddress || 'unknown';
}

async function reserveRateKey(keyHash, maxFailures, now) {
  const nowIso = now.toISOString();
  const windowCutoff = new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString();
  const nextBlockedUntil = new Date(now.getTime() + LOGIN_BLOCK_MS).toISOString();
  const result = await database().execute({
    sql: `INSERT INTO credential_rate_limits
            (key_hash, failure_count, window_started_at, blocked_until, updated_at)
          VALUES (?, 1, ?, NULL, ?)
          ON CONFLICT(key_hash) DO UPDATE SET
            failure_count = CASE
              WHEN credential_rate_limits.blocked_until > ? THEN credential_rate_limits.failure_count
              WHEN credential_rate_limits.window_started_at <= ? THEN 1
              ELSE credential_rate_limits.failure_count + 1
            END,
            window_started_at = CASE
              WHEN credential_rate_limits.blocked_until > ? THEN credential_rate_limits.window_started_at
              WHEN credential_rate_limits.window_started_at <= ? THEN ?
              ELSE credential_rate_limits.window_started_at
            END,
            blocked_until = CASE
              WHEN credential_rate_limits.blocked_until > ? THEN credential_rate_limits.blocked_until
              WHEN credential_rate_limits.window_started_at <= ? THEN NULL
              WHEN credential_rate_limits.failure_count >= ? THEN ?
              ELSE NULL
            END,
            updated_at = ?
          RETURNING failure_count, blocked_until`,
    args: [
      keyHash, nowIso, nowIso,
      nowIso, windowCutoff,
      nowIso, windowCutoff, nowIso,
      nowIso, windowCutoff, maxFailures, nextBlockedUntil,
      nowIso,
    ],
  });
  const row = result.rows[0];
  return row?.blocked_until ? new Date(row.blocked_until) : null;
}

/**
 * Count a sign-in attempt against three limits: this login from this
 * address, this login from anywhere, and this address for any login. The
 * attempt is refused while any of them is blocked.
 */
export async function reserveLoginAttempt(req, loginId, now = new Date()) {
  const login = String(loginId).toLowerCase();
  const address = requestAddress(req);
  const keyHash = tokenHash(`${login}\n${address}`);
  const accountKeyHash = tokenHash(`account\n${login}`);
  const addressKeyHash = tokenHash(`address\n${address}`);
  const blocks = await Promise.all([
    reserveRateKey(keyHash, LOGIN_MAX_FAILURES, now),
    reserveRateKey(accountKeyHash, LOGIN_ACCOUNT_MAX_FAILURES, now),
    reserveRateKey(addressKeyHash, LOGIN_ADDRESS_MAX_FAILURES, now),
  ]);
  const blockedUntil = blocks.filter((until) => until && until > now).sort((a, b) => b - a)[0] || null;
  return {
    allowed: !blockedUntil,
    retryAfter: blockedUntil ? Math.max(1, Math.ceil((blockedUntil - now) / 1000)) : 0,
    keyHash,
    accountKeyHash,
  };
}

// A successful sign-in clears this login's counters. The address counter is
// left to expire, so signing in to one's own account cannot reset it.
export async function clearLoginFailures(rateLimit) {
  const keys = [rateLimit.keyHash, rateLimit.accountKeyHash].filter(Boolean);
  await database().execute({ sql: `DELETE FROM credential_rate_limits WHERE key_hash IN (${keys.map(() => '?').join(', ')})`, args: keys });
}

// Unknown logins still pay for one scrypt check, so response time does not
// reveal which usernames exist.
let dummyPasswordHash = null;
export function verifyPasswordOrDummy(password, passwordHash) {
  if (passwordHash) return verifyPassword(password, passwordHash);
  dummyPasswordHash ||= hashPassword(crypto.randomBytes(16).toString('hex'));
  verifyPassword(password, dummyPasswordHash);
  return false;
}

export { hashPassword, verifyPassword };

function cookies(req) {
  return Object.fromEntries(String(req.headers?.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter((pair) => pair.length));
}

function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

function requestToken(req) {
  const authorization = String(req.headers?.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : cookies(req).skyll_session;
}

export async function sessionForRequest(req) {
  const token = requestToken(req);
  if (!token) return null;
  const db = database();
  const expiresAfter = new Date().toISOString();
  let user;
  if (await canonicalIdentityEnabled() && await canonicalSessionsEnabled()) {
    // A session remembers the tenancy it was created under and is never
    // re-derived (FLKRM-175). After 070 the pin is the exact membership, which
    // also fixes the role when a user holds two roles at one school; before it,
    // the school pinned in credential_id. Either way an unpinned token matches
    // no membership and is rejected — there is no ordering fallback.
    const membershipJoin = await pinnedTenancyEnabled()
      ? 'JOIN school_memberships membership ON membership.id = s.school_membership_id AND membership.user_id = u.id AND membership.status = \'active\''
      : 'JOIN school_memberships membership ON membership.school_id = s.credential_id AND membership.user_id = u.id AND membership.status = \'active\'';
    const result = await db.execute({
      sql: `SELECT u.id AS user_id,
                   primary_credential.login_id AS username,
                   membership.id AS school_membership_id,
                   membership.role,
                   school.id AS school_id,
                   school.display_name AS school,
                   s.expires_at,
                   s.last_seen_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id AND u.status = 'active'
            ${membershipJoin}
            JOIN schools school ON school.id = membership.school_id AND school.status = 'active'
            LEFT JOIN user_credentials primary_credential
              ON primary_credential.user_id = u.id AND primary_credential.is_primary = 1 AND primary_credential.status = 'active'
            WHERE s.token_hash = ? AND s.expires_at > ? AND s.revoked_at IS NULL
            LIMIT 1`,
      args: [tokenHash(token), expiresAfter],
    });
    if (result.rows[0]) {
      const { last_seen_at: lastSeenAt, ...row } = result.rows[0];
      user = { ...row, role: legacyRole(row.role) };
      const now = Date.now();
      if (!lastSeenAt || now - Date.parse(lastSeenAt) > SESSION_TOUCH_MS) {
        // Activity tracking only; never fail the request over it.
        await db.execute({
          sql: 'UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?',
          args: [new Date(now).toISOString(), tokenHash(token)],
        }).catch((error) => console.warn('session touch failed:', error?.message));
      }
    }
  }
  return user || null;
}

export async function requireUser(req, res, roles = null) {
  let user;
  try {
    user = await sessionForRequest(req);
  } catch (error) {
    // The session could not be checked, which is not the same as signed out.
    // 503 tells clients to retry instead of dropping the user to sign-in.
    console.error('session lookup failed:', error);
    res.status(503).json({ error: 'Service temporarily unavailable. Try again.' });
    return null;
  }
  if (!user) { res.status(401).json({ error: 'Sign in required' }); return null; }
  if (roles && !roles.includes(user.role)) { res.status(403).json({ error: 'You do not have permission for this action' }); return null; }
  return user;
}

export async function createSession(res, identity) {
  const userId = typeof identity === 'string' ? null : identity.user_id;
  if (!userId) throw new Error('Canonical identity required to create a session');
  // Tenancy is pinned at login and never re-derived: the session carries the
  // membership the user signed in under, so a later change to their memberships
  // cannot silently re-scope the session to another school.
  const membershipId = typeof identity === 'string' ? null : (identity.school_membership_id || null);
  const schoolId = typeof identity === 'string' ? null : (identity.school_id || null);
  if (!membershipId || !schoolId) throw new Error('Pinned membership required to create a session');
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiry = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  // The school stays pinned in credential_id as well, so sessions remain valid
  // both before 070 lands and if this code is rolled back after it.
  const insert = await pinnedTenancyEnabled()
    ? { sql: 'INSERT INTO sessions (token_hash, user_id, credential_id, school_membership_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [tokenHash(token), userId, schoolId, membershipId, expiry.toISOString(), now.toISOString(), now.toISOString()] }
    : { sql: 'INSERT INTO sessions (token_hash, user_id, credential_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)', args: [tokenHash(token), userId, schoolId, expiry.toISOString(), now.toISOString(), now.toISOString()] };
  await database().execute(insert);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `skyll_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
  return token;
}

export async function destroySession(req, res) {
  const token = requestToken(req);
  if (token) await database().execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [tokenHash(token)] });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `skyll_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}
