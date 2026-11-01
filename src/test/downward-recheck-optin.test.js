// The downward recheck is off for every subject; a subject profile can opt back
// in with `downwardRecheck: true`. This covers that path with the switch on.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/gradingProfiles/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  downwardRecheckEnabled: () => true,
}));

const { gradeWithSupervision } = await import('../../apps/processing-worker/gradeSupervisor.js');
const { STATED_ERROR_TAG } = await import('../../shared/gradingCalibration.js');

const question = {
  question_text: 'Justify the following reaction as redox reaction. 2Na + S -> Na2S. Find the oxidizing and reducing agents.',
  answer_key_text: 'Na loses electrons (oxidised), S gains electrons (reduced); S oxidising agent, Na reducing agent.',
  marks_total: 3,
  expected_response_type: 'long_answer',
};
const evidence = { attempted: true, student_answer: 'It is a combination reaction, not redox. Oxidizing agent = S. Reducing agent = 2Na' };
const lenient = {
  marks_awarded: 2.5,
  criteria: [
    { id: 'justification', max: 1.5, marks: 1, note: 'Student named the reaction type.' },
    { id: 'agents', max: 1.5, marks: 1.5, note: 'Agents correct.' },
  ],
  needs_attention: 'The student incorrectly claimed the reaction is not a redox reaction and did not show electron transfer.',
};
const rubric = { expected_response_type: 'long_answer' };

describe('a subject that opts in to the downward recheck', () => {
  it('lowers a mark the recheck settles, without a flag', async () => {
    const calls = [];
    const callJson = async (prompt) => {
      calls.push(prompt);
      if (calls.length === 1) return { value: lenient };
      return { value: { marks_awarded: 1.5, criteria: [{ id: 'justification', max: 1.5, marks: 0, note: 'Wrong concept.' }, { id: 'agents', max: 1.5, marks: 1.5, note: 'Agents correct.' }] } };
    };
    const result = await gradeWithSupervision({ question, rubric, evidence, callJson });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Never raise the total above the prior grade');
    expect(result.grade.marks).toBe(1.5);
    expect(result.grade.reviewReasons).not.toContain(STATED_ERROR_TAG);
    expect(result.supervisor.action).toBe('repaired_down');
  });

  it('never raises the mark, and flags a recheck that answers higher', async () => {
    const raising = async (prompt) => (prompt.includes('grading supervisor')
      ? { value: { marks_awarded: 3, criteria: [{ id: 'overall', max: 3, marks: 3, note: 'x' }] } }
      : { value: lenient });
    const kept = await gradeWithSupervision({ question, rubric, evidence, callJson: raising });
    expect(kept.grade.marks).toBe(2.5);
    expect(kept.grade.reviewReasons).toContain(STATED_ERROR_TAG);
    expect(kept.supervisor.action).toBe('flagged_down');
  });
});
