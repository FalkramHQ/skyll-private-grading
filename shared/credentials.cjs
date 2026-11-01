// Shared credential helpers usable by both ESM (api/, server/) and CJS (scripts/).
// ESM imports:  import credentials from '../shared/credentials.cjs'
// CJS requires: const { hashPassword } = require('../shared/credentials.cjs')

const crypto = require('node:crypto');

/**
 * Hash a password using scrypt with a random salt.
 * Returns `scrypt$<salt>$<derived-key>`.
 */
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

/**
 * Verify a password against an encoded scrypt hash using timing-safe comparison.
 */
function verifyPassword(password, encoded) {
  const [algorithm, salt, expected] = String(encoded || '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

module.exports = { hashPassword, verifyPassword };
