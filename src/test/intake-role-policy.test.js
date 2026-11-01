import { describe, expect, it } from 'vitest';
import {
  canCreateOrDeleteTests,
  canUploadIntakeAsset,
  canUseIntake,
  isScannerOnly,
  scannerDeniedMessage,
} from '../../server/intake/rolePolicy.js';

describe('intake role policy', () => {
  const scanner = { role: 'scanner' };
  const admin = { role: 'admin' };
  const student = { role: 'student' };

  it('allows scanners onto intake without granting test management', () => {
    expect(canUseIntake(scanner)).toBe(true);
    expect(isScannerOnly(scanner)).toBe(true);
    expect(canCreateOrDeleteTests(scanner)).toBe(false);
    expect(scannerDeniedMessage()).toMatch(/open existing tests/i);
  });

  it('limits scanner uploads to answer sheets', () => {
    expect(canUploadIntakeAsset(scanner, 'answer_sheet')).toBe(true);
    expect(canUploadIntakeAsset(scanner, 'question_paper')).toBe(false);
    expect(canUploadIntakeAsset(scanner, 'answer_key')).toBe(false);
  });

  it('keeps school admins on the full intake surface and students out', () => {
    expect(canCreateOrDeleteTests(admin)).toBe(true);
    expect(canUploadIntakeAsset(admin, 'answer_key')).toBe(true);
    expect(canUseIntake(student)).toBe(false);
  });

  it('keeps teachers out of the intake app', () => {
    const teacher = { role: 'teacher' };
    expect(canUseIntake(teacher)).toBe(false);
  });

  it('grants skyll_admin full intake access for cross-school operations', () => {
    const skyllAdmin = { role: 'skyll_admin' };
    expect(canUseIntake(skyllAdmin)).toBe(true);
    expect(isScannerOnly(skyllAdmin)).toBe(false);
    expect(canCreateOrDeleteTests(skyllAdmin)).toBe(true);
    expect(canUploadIntakeAsset(skyllAdmin, 'answer_key')).toBe(true);
  });
});
