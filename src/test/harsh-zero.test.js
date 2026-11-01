import { describe, expect, it } from 'vitest';
import {
  HARSH_ZERO_TAG,
  gradingLanguageInstruction,
  hasSubstantiveCorrectFragment,
  isHarshZero,
  isSubjectiveResponseType,
  mergeReviewTags,
  resolveGradingLanguage,
  rubricBandPolicy,
  subjectivePartialCreditPolicy,
  withHarshZeroTag,
} from '../../shared/harshZero.js';

describe('harsh zero detection', () => {
  it('flags multi-mark zeros that credit real understanding', () => {
    expect(isHarshZero({
      marks: 0,
      allocated: 3,
      attempted: true,
      whatWentCorrect: "The student vaguely referenced 'opposes' and 'magnetic flux'.",
      responseType: 'long_answer',
    })).toBe(true);
  });

  it('ignores hollow attempt acknowledgements and negated credit', () => {
    expect(hasSubstantiveCorrectFragment('The student attempted to answer.')).toBe(false);
    expect(hasSubstantiveCorrectFragment('No correct differences were identified; the student did not mention dipoles.')).toBe(false);
    expect(isHarshZero({
      marks: 0,
      allocated: 2,
      whatWentCorrect: 'No correct differences were identified; the student did not mention charge centres.',
      responseType: 'short_answer',
    })).toBe(false);
  });

  it('does not flag MCQ or single-mark items', () => {
    expect(isHarshZero({
      marks: 0,
      allocated: 3,
      whatWentCorrect: 'Student correctly chose option b conceptually.',
      responseType: 'mcq',
    })).toBe(false);
    expect(isHarshZero({
      marks: 0,
      allocated: 1,
      whatWentCorrect: 'Student correctly mentioned flux.',
      responseType: 'short_answer',
    })).toBe(false);
  });

  it('tags review items without changing marks', () => {
    const tagged = withHarshZeroTag({
      grade: { marks: 0, allocated: 3 },
      studentAnswer: { attempted: true },
      gradeRationale: { whatWentCorrect: 'Student correctly identified conductors allow current.' },
      reviewTags: ['flagged'],
      expectedResponseType: 'short_answer',
    });
    expect(tagged.grade.marks).toBe(0);
    expect(tagged.isHarshZero).toBe(true);
    expect(tagged.reviewTags).toEqual(['flagged', HARSH_ZERO_TAG]);
  });

  it('classifies subjective response types and merges tags', () => {
    expect(isSubjectiveResponseType('long_answer')).toBe(true);
    expect(isSubjectiveResponseType('mcq')).toBe(false);
    expect(mergeReviewTags(['a'], 'b', ['a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('exposes rubric band and partial-credit policy text for prompts', () => {
    expect(rubricBandPolicy()).toMatch(/mark bands/i);
    expect(subjectivePartialCreditPolicy()).toMatch(/criterion-by-criterion/i);
    expect(subjectivePartialCreditPolicy()).toMatch(/criteria array/i);
  });

  it('resolves Hindi only for Hindi subject or explicit override', () => {
    expect(resolveGradingLanguage({ subject: 'Hindi' })).toBe('hindi');
    expect(resolveGradingLanguage({ explicit: 'hindi' })).toBe('hindi');
    // STEM + Devanagari OCR noise must stay English (do not freelance Hindi feedback).
    expect(resolveGradingLanguage({ studentAnswer: 'विद्यार्थी ने उत्तर लिखा' })).toBe('english');
    expect(resolveGradingLanguage({ subject: 'Physics', studentAnswer: 'opposes flux' })).toBe('english');
    expect(resolveGradingLanguage({ subject: 'Physics', studentAnswer: 'b)' })).toBe('english');
    expect(resolveGradingLanguage({ subject: 'Chemistry' })).toBe('english');
    expect(gradingLanguageInstruction('hindi')).toMatch(/Devanagari/);
    expect(gradingLanguageInstruction('english')).toMatch(/clear English/i);
    expect(gradingLanguageInstruction('english')).toMatch(/Never use Hindi/i);
  });
});
