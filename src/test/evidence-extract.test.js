import { describe, expect, it, vi } from 'vitest';
import { extractStudentAnswers, rubricLooksAllMcq } from '../../apps/processing-worker/evidenceExtract.js';
import { EvidenceSupervisor } from '../../apps/processing-worker/evidenceSupervisor.js';

const rubric = {
  questions: [
    { id: 'q1', number: 'Q1', question_text: 'Define photosynthesis.', correct_answer_summary: 'Plants make food from light.', marks_allocated: 2, expected_response_type: 'short_answer', marking_rubric: '2 marks' },
    { id: 'q2', number: 'Q2', question_text: 'Name the green pigment in leaves.', correct_answer_summary: 'Chlorophyll', marks_allocated: 1, expected_response_type: 'short_answer', marking_rubric: '1 mark' },
  ],
};
const assets = [{ asset_id: 'a1', storage_key: 'x-page-1-1.jpg', ocr_run_id: 'o1', is_active: 1,
  markdown: 'Photosynthesis is how plants make food using sunlight, water and carbon dioxide.\n\nChlorophyll is the green pigment.',
  pages_json: null }];

describe('extractStudentAnswers (the worker extraction the eval re-runs)', () => {
  it('extracts with the subject in every prompt and returns normalised answers', async () => {
    const prompts = [];
    const callJson = vi.fn(async (prompt) => {
      prompts.push(prompt);
      return { value: { answers: [
        { question_number: 'Q1', attempted: true, student_answer: 'Photosynthesis is how plants make food using sunlight, water and carbon dioxide.', confidence: 'high' },
        { question_number: 'Q2', attempted: true, student_answer: 'Chlorophyll', confidence: 'medium' },
      ] } };
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await extractStudentAnswers({
      assets, rubric, subject: 'Biology', supervisor: new EvidenceSupervisor(rubric.questions), callJson,
      loadSheetPages: async () => [{ page: 1, text: assets[0].markdown }], studentName: 'student1', studentId: 'student1',
    });
    expect(callJson).toHaveBeenCalled();
    expect(result.paperIsAllMcq).toBe(false);
    expect(result.ocrIncomplete).toBe(false);
    expect(result.answers.map((a) => [a.question.number, a.attempted, a.confidence])).toEqual([['Q1', true, 'high'], ['Q2', true, 'medium']]);
    expect(result.answers[1].studentAnswer).toBe('Chlorophyll');
    expect(result.duplicateOf.size).toBe(0);
    vi.restoreAllMocks();
  });

  it('parses all-MCQ papers without a model call when the OCR is clear', async () => {
    const mcq = { questions: ['Q1', 'Q2', 'Q3'].map((number) => ({ id: number, number, question_text: 'Pick one', expected_response_type: 'mcq', marks_allocated: 1 })) };
    expect(rubricLooksAllMcq(mcq.questions)).toBe(true);
    const callJson = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await extractStudentAnswers({
      assets: [{ ...assets[0], markdown: '1] A\n2] C\n3] B' }], rubric: mcq, subject: 'Physics',
      supervisor: new EvidenceSupervisor(mcq.questions), callJson,
    });
    expect(callJson).not.toHaveBeenCalled();
    expect(result.paperIsAllMcq).toBe(true);
    expect(result.answers.map((a) => a.studentAnswer)).toEqual(['A', 'C', 'B']);
    vi.restoreAllMocks();
  });
});
