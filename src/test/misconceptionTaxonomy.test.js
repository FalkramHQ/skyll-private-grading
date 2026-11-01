import { describe, it, expect } from 'vitest';
import { MISCONCEPTION_CLASSES, isValidMisconceptionClass, normalizeMisconceptionClass } from '../../api/_lib/misconceptionTaxonomy.js';

describe('misconception taxonomy', () => {
  it('exposes the Maths misconception set', () => {
    expect(MISCONCEPTION_CLASSES.maths).toEqual(expect.arrayContaining([
      'sign-error', 'distribution-misuse', 'formula-misapplication',
      'notation-error', 'procedural-skip', 'concept-confusion',
    ]));
  });

  it('validates a known class and rejects unknown', () => {
    expect(isValidMisconceptionClass('maths', 'sign-error')).toBe(true);
    expect(isValidMisconceptionClass('maths', 'made-up')).toBe(false);
    expect(isValidMisconceptionClass('physics', 'sign-error')).toBe(false); // physics not seeded yet
  });

  it('resolves the canonical production subject name to the maths taxonomy', () => {
    expect(isValidMisconceptionClass('Mathematics', 'sign-error')).toBe(true);
  });

  it('normalises free-text to a class or null', () => {
    expect(normalizeMisconceptionClass('maths', 'sign error')).toBe('sign-error');
    expect(normalizeMisconceptionClass('maths', 'forgot the minus sign')).toBe('sign-error');
    expect(normalizeMisconceptionClass('maths', 'something weird')).toBeNull();
  });

  it('accepts canonical enum values verbatim and canonical subject spellings', () => {
    expect(normalizeMisconceptionClass('maths', 'sign-error')).toBe('sign-error');
    expect(normalizeMisconceptionClass('Mathematics', 'forgot the minus sign')).toBe('sign-error');
    expect(normalizeMisconceptionClass('Mathematics', 'unit-error')).toBe('unit-error');
  });
});
