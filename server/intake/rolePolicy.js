export const INTAKE_MANAGER_ROLES = ['admin', 'skyll_admin'];
export const INTAKE_SCANNER_ROLES = ['admin', 'skyll_admin', 'scanner'];

export function isIntakeManager(user) {
  return INTAKE_MANAGER_ROLES.includes(user?.role);
}

export function isScannerOnly(user) {
  return user?.role === 'scanner';
}

export function canUseIntake(user) {
  return INTAKE_SCANNER_ROLES.includes(user?.role);
}

export function canCreateOrDeleteTests(user) {
  return isIntakeManager(user);
}

export function canUploadIntakeAsset(user, kind) {
  if (!canUseIntake(user)) return false;
  if (isScannerOnly(user)) return kind === 'answer_sheet';
  return true;
}

export function scannerDeniedMessage() {
  return 'Scanner accounts can only open existing tests and upload answer sheets.';
}
