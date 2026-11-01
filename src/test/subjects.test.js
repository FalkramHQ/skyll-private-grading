import { describe, expect, it } from 'vitest';
import {
  SUBJECTS,
  availableSubjects,
  isCanonicalSubject,
  normalizeSubject,
  resolveCanonicalSubject,
  subjectValidationError,
} from '../../shared/subjects.js';

describe('canonical subject allowlist', () => {
  it('exposes the intake/API subject enum', () => {
    expect(SUBJECTS).toEqual([
      'Mathematics', 'Physics', 'Chemistry', 'Biology', 'Science', 'Accounts', 'English', 'Hindi', 'German', 'History', 'Geography',
    ]);
  });

  it('accepts History (with Civics) and Geography as canonical subjects', () => {
    for (const raw of ['History', 'history', 'History & Civics', 'history and civics', 'Civics', 'Hist']) {
      expect(resolveCanonicalSubject(raw)).toBe('History');
    }
    for (const raw of ['Geography', 'geography', 'Geo', 'Geography set B']) {
      expect(resolveCanonicalSubject(raw)).toBe('Geography');
    }
    expect(subjectValidationError('History')).toBeNull();
    expect(subjectValidationError('Geography')).toBeNull();
  });

  it('maps legacy aliases onto allowlisted display names', () => {
    expect(resolveCanonicalSubject('maths')).toBe('Mathematics');
    expect(resolveCanonicalSubject('Bio')).toBe('Biology');
    expect(resolveCanonicalSubject('ENG language')).toBe('English');
    expect(resolveCanonicalSubject('English language')).toBe('English');
    expect(resolveCanonicalSubject('Deutsch')).toBe('German');
    expect(resolveCanonicalSubject('german language')).toBe('German');
    expect(resolveCanonicalSubject('  Chemistry set A ')).toBe('Chemistry');
  });

  it('accepts German as a canonical subject with its aliases', () => {
    expect(resolveCanonicalSubject('german')).toBe('German');
    expect(resolveCanonicalSubject('German')).toBe('German');
    expect(resolveCanonicalSubject('Deutsch')).toBe('German');
    expect(resolveCanonicalSubject('German language')).toBe('German');
    expect(isCanonicalSubject('German')).toBe(true);
    expect(subjectValidationError('German')).toBeNull();
  });

  it('rejects free-text subjects that are not on the allowlist', () => {
    expect(resolveCanonicalSubject('Internal validation')).toBeNull();
    expect(subjectValidationError('Physical Education')).toMatch(/must be one of/);
    expect(subjectValidationError('')).toBe('subject is required');
    expect(isCanonicalSubject('Mathematics')).toBe(true);
    expect(isCanonicalSubject('Physical Education')).toBe(false);
  });

  it('keeps normalizeSubject tolerant for legacy display while availableSubjects only lists allowlisted hits', () => {
    expect(normalizeSubject('Maths')).toBe('Mathematics');
    expect(normalizeSubject('Internal validation')).toBe('Internal validation');
    expect(availableSubjects(['math', 'English language', 'Physical Education'])).toEqual(['Mathematics', 'English']);
    expect(availableSubjects(['History & Civics', 'geography'])).toEqual(['History', 'Geography']);
  });
});
