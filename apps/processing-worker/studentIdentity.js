/**
 * Internal roster identifiers are never suitable for a report or dashboard.
 * Report publication must use the canonical primary credential issued to the
 * student during intake provisioning.
 */
export function requireStudentPublicLogin(primaryLogin, studentId) {
  const login = String(primaryLogin || '').trim();
  if (!login) {
    throw new Error(`Missing canonical primary login for student ${studentId}. Run intake student access provisioning before publishing reports.`);
  }
  return login;
}
