const crypto = require('node:crypto');

const STUDENT_USERNAME = /^[a-z0-9]{6}$/;
const STUDENT_PASSWORD = /^[A-Za-z0-9]{6}$/;
const ADMIN_PASSWORD = /^[A-Za-z0-9_-]{12,24}$/;
const SCANNER_PASSWORD = ADMIN_PASSWORD;

/**
 * Centralized policy: may students change their own password on the
 * self-service `/api/auth/change-password` endpoint?
 *
 * Currently FALSE by product decision — student credential changes are managed
 * by school staff/admin (see server/auth/changePassword.js). This single flag is
 * the one place to flip when the decision is revisited; the API read this value.
 */
const STUDENT_SELF_SERVICE_PASSWORD_CHANGE = false;

function institutionSlug(school) {
  const normalized = String(school || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  const concise = normalized.replace(/_(classes|class|academy|tutorials|tutorial|school)$/u, '');
  return concise || normalized;
}

function randomToken(length, alphabet) {
  const bytes = crypto.randomBytes(length);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

function createStudentPassword() {
  return randomToken(6, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789');
}

function createAdminPassword() {
  return randomToken(12, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789_-');
}

function assertStudentCredential({ username, password, label = 'Student credential' }) {
  if (!STUDENT_USERNAME.test(String(username || ''))) {
    throw new Error(`${label} username must be exactly six lowercase letters or digits.`);
  }
  assertStudentPassword(password, label);
}

function assertStudentPassword(password, label = 'Student password') {
  if (!STUDENT_PASSWORD.test(String(password || ''))) {
    throw new Error(`${label} password must be exactly six ASCII letters or digits.`);
  }
}

function assertAdminCredential({ school, username, password }) {
  const expectedUsername = `${institutionSlug(school)}_admin`;
  if (String(username || '').toLowerCase() !== expectedUsername) {
    throw new Error(`Admin username for ${school} must be ${expectedUsername}.`);
  }
  if (!ADMIN_PASSWORD.test(String(password || ''))) {
    throw new Error('Admin password must be 12-24 URL-safe ASCII characters (letters, digits, _ or -).');
  }
}

function assertStaffPassword(password, label = 'Password') {
  if (!ADMIN_PASSWORD.test(String(password || ''))) {
    throw new Error(`${label} must be 12-24 URL-safe ASCII characters (letters, digits, _ or -).`);
  }
}

function assertScannerCredential({ school, username, password }) {
  const expectedUsername = `${institutionSlug(school)}_scanner`;
  if (String(username || '').toLowerCase() !== expectedUsername) {
    throw new Error(`Scanner username for ${school} must be ${expectedUsername}.`);
  }
  if (!SCANNER_PASSWORD.test(String(password || ''))) {
    throw new Error('Scanner password must be 12-24 URL-safe ASCII characters (letters, digits, _ or -).');
  }
}

module.exports = {
  STUDENT_SELF_SERVICE_PASSWORD_CHANGE,
  assertAdminCredential,
  assertScannerCredential,
  assertStudentCredential,
  assertStaffPassword,
  assertStudentPassword,
  createAdminPassword,
  createStudentPassword,
  institutionSlug,
};
