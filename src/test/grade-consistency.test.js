// A grade that disagrees with itself gets one re-mark. The Oct 2026 semi-prelim
// cross-checks found 16 of 64 Geography questions whose part breakdown did not
// add up to the mark, criteria duplicated past the question's marks, and
// rationales stating a different total ("Total marks awarded: 4 out of 10").
import { describe, expect, it } from 'vitest';
import {
  auditConsistency,
  extractClaimedMarks,
  gradeWithSupervision,
  withConsistentParts,
} from '../../apps/processing-worker/gradeSupervisor.js';
import { normalizeCriteria } from '../../shared/harshZero.js';
import { MARKS_INCONSISTENT_TAG } from '../../shared/gradingCalibration.js';

const question = {
  question_text: '(i) Name the soil. (ii) Give one reason. (iii) Name the crop.',
  answer_key_text: '(i) Black soil (ii) Retains moisture (iii) Cotton',
  marks_total: 3,
  expected_response_type: 'short_answer',
};
const rubric = { expected_response_type: 'short_answer', marking_rubric: '1 mark for the soil. 1 mark for the reason. 1 mark for the crop.' };
const evidence = { attempted: true, student_answer: '(i) Black soil (ii) It holds water (iii) Rice' };
const criteria = (soil, reason, crop) => [
  { id: 'the_soil', max: 1, marks: soil, note: '' },
  { id: 'the_reason', max: 1, marks: reason, note: '' },
  { id: 'the_crop', max: 1, marks: crop, note: '' },
];
const parts = (soil, reason, crop) => [
  { label: '(i)', marks_obtained: soil, marks_total: 1 },
  { label: '(ii)', marks_obtained: reason, marks_total: 1 },
  { label: '(iii)', marks_obtained: crop, marks_total: 1 },
];

describe('auditConsistency', () => {
  it('finds reasoning that states a higher total than the mark', () => {
    expect(auditConsistency({ marks: 2, criteria: criteria(1, 1, 0), reasoning: 'Total marks awarded: 3 out of 3.' }, { max: 3 })).toEqual(['prose_mark_mismatch_up:3>2']);
    expect(auditConsistency({ marks: 2, criteria: criteria(1, 1, 0), reasoning: 'Total 2 marks.' }, { max: 3 })).toEqual([]);
    // A breakdown that does not add up is not re-marked: it is dropped.
    expect(auditConsistency({ marks: 2, parts: parts(1, 1, 1), criteria: criteria(1, 1, 0) }, { max: 3 })).toEqual([]);
  });

  it('reads "Total marks awarded: N" totals', () => {
    expect(extractClaimedMarks('Total marks awarded: 4 out of 10')).toBe(4);
    expect(extractClaimedMarks('Total: 2.5/3')).toBe(2.5);
  });
});

describe('withConsistentParts', () => {
  it('keeps a breakdown that adds up and drops one that does not', () => {
    expect(withConsistentParts({ marks: 2, parts: parts(1, 1, 0) }).parts).toHaveLength(3);
    expect(withConsistentParts({ marks: 2, parts: parts(1, 1, 1) }).parts).toBeNull();
  });
});

describe('the synthetic overall band', () => {
  it('gives way to the grader\'s own criteria instead of doubling the marks', () => {
    const result = normalizeCriteria(criteria(1, 1, 0), [{ id: 'overall', max: 3, label: 'overall response' }]);
    expect(result.criteria.map((c) => c.id)).toEqual(['the_soil', 'the_reason', 'the_crop']);
    expect(result.criteria.reduce((sum, c) => sum + c.max, 0)).toBe(3);
  });
});

describe('consistency in supervision', () => {
  it('drops a breakdown that does not add up, without another call or a flag', async () => {
    let calls = 0;
    const callJson = async () => { calls += 1; return { value: { marks_awarded: 2, criteria: criteria(1, 1, 0), parts: parts(1, 1, 1) } }; };
    const result = await gradeWithSupervision({ question, rubric, evidence, callJson });
    expect(calls).toBe(1);
    expect(result.grade.marks).toBe(2);
    expect(result.grade.parts).toBeNull();
    expect(result.grade.reviewReasons).not.toContain(MARKS_INCONSISTENT_TAG);
  });

  it('re-marks a grade whose reasoning states a higher total, and accepts an agreeing re-mark', async () => {
    const prompts = [];
    const callJson = async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) return { value: { marks_awarded: 2, criteria: criteria(1, 1, 0), grading_reasoning: 'Total marks awarded: 3 out of 3.' } };
      return { value: { marks_awarded: 3, criteria: criteria(1, 1, 1), grading_reasoning: 'Total 3 marks.' } };
    };
    const result = await gradeWithSupervision({ question, rubric, evidence, callJson });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('prose_mark_mismatch_up:3>2');
    expect(result.grade.marks).toBe(3);
    expect(result.supervisor.action).toBe('reconciled');
  });

  it('flags a grade whose stated total still disagrees after the re-mark, or whose re-mark fails', async () => {
    const stuck = async () => ({ value: { marks_awarded: 2, criteria: criteria(1, 1, 0), grading_reasoning: 'Total marks awarded: 3 out of 3.' } });
    const result = await gradeWithSupervision({ question, rubric, evidence, callJson: stuck });
    expect(result.grade.reviewReasons).toContain(MARKS_INCONSISTENT_TAG);
    expect(result.supervisor).toMatchObject({ action: 'flagged_inconsistent', finalReasons: ['prose_mark_mismatch_up:3>2'] });
    let calls = 0;
    const failing = async () => {
      calls += 1;
      if (calls > 1) throw new Error('provider down');
      return { value: { marks_awarded: 2, criteria: criteria(1, 1, 0), grading_reasoning: 'Total marks awarded: 3 out of 3.' } };
    };
    expect((await gradeWithSupervision({ question, rubric, evidence, callJson: failing })).grade.reviewReasons).toContain(MARKS_INCONSISTENT_TAG);
  });

  it('makes no extra call for a consistent grade', async () => {
    let calls = 0;
    const callJson = async () => { calls += 1; return { value: { marks_awarded: 2, criteria: criteria(1, 1, 0), parts: parts(1, 1, 0) } }; };
    const result = await gradeWithSupervision({ question, rubric, evidence, callJson });
    expect(calls).toBe(1);
    expect(result.supervisor.action).toBe('ok');
  });
});

describe('the grader\'s own review requests', () => {
  const visualQuestion = { ...question, expected_response_type: 'short_answer' };
  const unverified = { attempted: true, student_answer: 'x', needs_visual_rescue: true, visual_rescue: { usable: false } };

  it('drop a reason that only restates an unverified diagram, which its own tag carries', async () => {
    const { normalizeGradeResult } = await import('../../apps/processing-worker/gradeResult.js');
    const grade = normalizeGradeResult({
      marks_awarded: 1, criteria: criteria(1, 0, 0), needs_review: true,
      review_reasons: ['Visual evidence is unverified; require human review to confirm the drawn structures.'],
    }, visualQuestion, unverified, 'short_answer', { markingRubric: rubric.marking_rubric });
    expect(grade.reviewReasons).toEqual(['visual_evidence_unverified']);
  });

  it('keep a specific doubt, and ignore a review request that gives no reason', async () => {
    const { normalizeGradeResult } = await import('../../apps/processing-worker/gradeResult.js');
    const doubt = 'Q3 response is ambiguous: "(b) (a)" could be a crossed-out (b) corrected to (a).';
    const kept = normalizeGradeResult({ marks_awarded: 1, criteria: criteria(1, 0, 0), needs_review: true, review_reasons: [doubt] }, question, evidence, 'short_answer', { markingRubric: rubric.marking_rubric });
    expect(kept.needsReview).toBe(true);
    expect(kept.reviewReasons).toContain(doubt);
    const bare = normalizeGradeResult({ marks_awarded: 1, criteria: criteria(1, 0, 0), needs_review: true, review_reasons: [] }, question, evidence, 'short_answer', { markingRubric: rubric.marking_rubric });
    expect(bare.needsReview).toBe(false);
  });
});

describe('a subject with the downward recheck off', () => {
  it('keeps a high mark whose feedback names a missing point, with no recheck call', async () => {
    let calls = 0;
    const callJson = async () => { calls += 1; return { value: { marks_awarded: 3, criteria: criteria(1, 1, 1), needs_attention: 'The answer is missing the reference to the storm and does not mention the speaker.' } }; };
    const literature = { ...question, test_subject: 'English', test_title: 'Semi Prelim English literature exam' };
    const result = await gradeWithSupervision({ question: literature, rubric, evidence, subject: 'English', callJson });
    expect(calls).toBe(1);
    expect(result.grade.marks).toBe(3);
    expect(result.supervisor.action).toBe('ok');
  });
});
