// Language grading fixes, from the Oct 2026 analysis of flag mode's losses: the
// downward recheck fired on harmless notes, and the grader marked mechanics the
// rubric does not assess. The feedback strings are real grader output.
/* global process */
import { describe, expect, it } from 'vitest';
import { buildDownwardRepairPrompt, namesError, subjectGradingRules } from '../../shared/gradingCalibration.js';
import { auditGradeStrict } from '../../apps/processing-worker/gradeSupervisor.js';
import { buildGradePrompt } from '../../apps/processing-worker/gradeResult.js';
import { GRADING_PROFILES, downwardRecheckEnabled, resolveGradingProfile } from '../../shared/gradingProfiles/index.js';

describe('stated-error trigger', () => {
  it('ignores a note that says the issue does not affect the mark', () => {
    expect(namesError("The pronoun 'Er' is capitalized mid-sentence; in German it should be lowercase 'er' unless it begins a sentence. This is a spelling/capitalization issue, not a word-order error, so it does not reduce the mark.")).toBe(false);
    expect(namesError("The noun 'Kind' should be capitalized in German, but this is a minor orthographic issue and does not affect the sentence structure or the use of 'als'.")).toBe(false);
    expect(namesError("The phrasing is slightly awkward ('per male of 1000') and the additional comparison about India and Brazil is unnecessary but does not invalidate the definition.")).toBe(false);
  });

  it('still catches a real error, even next to a harmless note', () => {
    expect(namesError("The definite article 'der' is missing before 'Kurs'.")).toBe(true);
    expect(namesError('Capitalisation is a minor issue. The student identified the wrong acid.')).toBe(true);
    expect(namesError('No significant issues; the answer is complete and accurate.')).toBe(false);
  });

  it('no longer sends a full mark with a harmless note to the downward recheck', () => {
    const grade = { marks: 2, needsAttention: "The noun 'Kind' should be capitalized in German, but this is a minor orthographic issue and does not affect the sentence structure.", criteria: [{ id: 'als', max: 2, marks: 2, note: 'Correct use of als with verb-final order; capitalisation does not affect the mark.' }] };
    expect(auditGradeStrict(grade, { max: 2 }).action).toBe('ok');
  });
});

describe('subject grading profiles', () => {
  it('give each subject its own rules, with the language rules for language subjects', () => {
    expect(subjectGradingRules('Chemistry')).toMatch(/CHEMISTRY/);
    expect(subjectGradingRules('Chemistry')).not.toMatch(/LANGUAGE ITEMS/);
    expect(subjectGradingRules('English')).toMatch(/Capitalisation, punctuation .* cost no marks unless the rubric explicitly assesses them/);
    expect(subjectGradingRules('English')).not.toMatch(/GERMAN/);
    expect(subjectGradingRules('German')).toMatch(/weil ich sehr müde bin/);
    expect(subjectGradingRules('Hindi')).toMatch(/LANGUAGE ITEMS/);
    expect(subjectGradingRules('Physical Education')).toBe('');
    expect(subjectGradingRules('')).toBe('');
  });

  it('tell English Literature from English Language by the paper title', () => {
    expect(resolveGradingProfile('English', '10th ICSE Semi Prelim English literature exam').id).toBe('english_literature');
    expect(resolveGradingProfile('English', '10th ICSE English Language Paper 1').id).toBe('english_language');
    expect(resolveGradingProfile('English Literature').id).toBe('english_literature');
    expect(subjectGradingRules('English', 'Semi Prelim English literature')).toMatch(/by substance, not wording/);
    expect(subjectGradingRules('English', 'Semi Prelim English literature')).not.toMatch(/LANGUAGE ITEMS/);
    // A Chemistry paper whose title mentions literature is still Chemistry.
    expect(resolveGradingProfile('Chemistry', 'Chemistry of literature review').id).toBe('chemistry');
  });

  it('leave the downward recheck off for every subject', () => {
    for (const profile of GRADING_PROFILES) expect(profile.downwardRecheck).not.toBe(true);
    expect(downwardRecheckEnabled('English', 'Semi Prelim English literature exam')).toBe(false);
    expect(downwardRecheckEnabled('Chemistry')).toBe(false);
    expect(downwardRecheckEnabled('')).toBe(false);
  });

  it('map Geography and SST papers to the Geography profile', () => {
    expect(resolveGradingProfile('Geography').id).toBe('geography');
    expect(resolveGradingProfile('SST').id).toBe('geography');
    expect(subjectGradingRules('Geography')).toMatch(/Wular \/ Jular/);
  });

  it('give every profile an id, a label, a subject matcher and at least one rule', () => {
    for (const profile of GRADING_PROFILES) {
      expect(profile.id).toMatch(/^[a-z_]+$/);
      expect(profile.label).toBeTruthy();
      expect(profile.match).toBeInstanceOf(RegExp);
      expect(profile.rules.length).toBeGreaterThan(0);
    }
  });

  it('are in the grade prompt and the downward recheck prompt in every mode', () => {
    const prior = process.env.GRADE_CALIBRATION;
    const question = { question_text: 'Lara lernt Deutsch. Sie möchte in Deutschland arbeiten.', answer_key_text: 'Lara lernt Deutsch, weil sie in Deutschland arbeiten möchte.', marks_total: 1, expected_response_type: 'short_answer', test_subject: 'German' };
    const rubric = { expected_response_type: 'short_answer', marking_rubric: "1 mark for correct subordinate clause with 'weil' and correct word order." };
    const evidence = { attempted: true, student_answer: 'Lara lernt Deutsch weil, Sie in Deutschland arbeiten möchte.' };
    try {
      for (const mode of ['legacy', 'flag', 'strict', 'calibrated']) {
        process.env.GRADE_CALIBRATION = mode;
        expect(buildGradePrompt({ question, rubric, evidence, maxMarks: 1, subject: 'German' })).toMatch(/GERMAN GRAMMAR/);
      }
      const recheck = buildDownwardRepairPrompt({ question, evidence, rubric, grade: { marks: 1, criteria: [] }, auditReasons: [] });
      expect(recheck).toMatch(/Do not remove marks for capitalisation, punctuation/);
      expect(recheck).toMatch(/GERMAN GRAMMAR/);
      expect(buildGradePrompt({ question: { ...question, test_subject: 'Chemistry' }, rubric, evidence, maxMarks: 1, subject: 'Chemistry' })).not.toMatch(/LANGUAGE ITEMS/);
      const literature = { ...question, test_subject: 'English', test_title: 'Semi Prelim English literature exam' };
      expect(buildGradePrompt({ question: literature, rubric, evidence, maxMarks: 1, subject: 'English' })).toMatch(/ENGLISH LITERATURE/);
    } finally {
      if (prior === undefined) delete process.env.GRADE_CALIBRATION; else process.env.GRADE_CALIBRATION = prior;
    }
  });
});
