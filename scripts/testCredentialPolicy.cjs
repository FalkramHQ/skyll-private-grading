#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  assertAdminCredential,
  assertScannerCredential,
  assertStudentCredential,
  createAdminPassword,
  createStudentPassword,
  institutionSlug,
} = require('./lib/credentialPolicy.cjs');

assert.equal(institutionSlug('Partner Academy E'), 'partner_academy_e');
assert.equal(institutionSlug("Partner Academy B"), 'partner_academy_b');
assertStudentCredential({ username: 'manang', password: createStudentPassword() });
assert.throws(() => assertStudentCredential({ username: 'too-long', password: 'ABC123' }));
assert.throws(() => assertStudentCredential({ username: 'manang', password: 'short' }));
assertAdminCredential({ school: 'Partner Academy E', username: 'partner_academy_e_admin', password: createAdminPassword() });
assertAdminCredential({ school: "Partner Academy B", username: 'partner_academy_b_admin', password: createAdminPassword() });
assert.throws(() => assertAdminCredential({ school: 'Partner Academy E', username: 'admin', password: createAdminPassword() }));
assert.throws(() => assertAdminCredential({ school: 'Partner Academy E', username: 'partner_academy_e_admin', password: 'not-valid!' }));
assertScannerCredential({ school: "Partner Academy A", username: 'partner_academy_a_scanner', password: createAdminPassword() });
assert.throws(() => assertScannerCredential({ school: "Partner Academy A", username: 'partner_academy_a_admin', password: createAdminPassword() }));
assert.throws(() => assertScannerCredential({ school: "Partner Academy A", username: 'partner_academy_a_scanner', password: 'short' }));

const projectRoot = path.resolve(__dirname, '..');
const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: projectRoot })
  .toString()
  .split('\0')
  .filter(Boolean);
const forbiddenCredentialFiles = trackedFiles.filter((file) => (
  /(?:^|\/)[^/]*_creds\.json$/i.test(file)
  && fs.existsSync(path.join(projectRoot, file))
));
assert.deepEqual(forbiddenCredentialFiles, [], `Plaintext credential files must not be tracked: ${forbiddenCredentialFiles.join(', ')}`);

const secretPatterns = [
  { name: 'private key', expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'OpenAI-style API key', expression: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'hard-coded secret assignment', expression: /(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|SHARED[_-]?SECRET)\s*=\s*(?:process\.env\.[A-Z0-9_]+\s*\|\|\s*)?['"][^'"]{16,}['"]/i },
];
const scanExtensions = new Set(['.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml']);
const findings = [];
for (const file of trackedFiles) {
  if (!scanExtensions.has(path.extname(file)) || file === 'package-lock.json') continue;
  if (!fs.existsSync(path.join(projectRoot, file))) continue;
  const contents = fs.readFileSync(path.join(projectRoot, file), 'utf8');
  for (const pattern of secretPatterns) {
    if (pattern.expression.test(contents)) findings.push(`${file}: ${pattern.name}`);
  }
}
assert.deepEqual(findings, [], `Potential hard-coded secrets found:\n${findings.join('\n')}`);
console.log('Credential policy checks passed.');
