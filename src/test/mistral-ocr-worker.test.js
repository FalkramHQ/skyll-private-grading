import { describe, expect, it } from 'vitest';
import {
  documentForAsset,
  isRetryableMistralStatus,
  normalizeOcrResult,
  parseJsonModelResponse,
  validateRubricPackage,
} from '../../workers/mistral-ocr/src/ocrProtocol.js';

describe('Mistral OCR worker protocol', () => {
  it('uses image URLs for scanned pages and document URLs for PDFs', () => {
    expect(documentForAsset({ documentType: 'image_url', downloadUrl: 'https://example.test/scan.jpg' }))
      .toEqual({ type: 'image_url', image_url: 'https://example.test/scan.jpg' });
    expect(documentForAsset({ documentType: 'document_url', downloadUrl: 'https://example.test/paper.pdf' }))
      .toEqual({ type: 'document_url', document_url: 'https://example.test/paper.pdf' });
  });

  it('persists structured pages without image payloads', () => {
    const output = normalizeOcrResult({
      model: 'mistral-ocr-latest', usage_info: { pages_processed: 1 },
      pages: [{ index: 0, markdown: 'A table', tables: [{ html: '<table />' }], blocks: [{ type: 'table' }], confidence_scores: { average_page_confidence_score: 0.9 } }],
    });
    expect(output).toMatchObject({ markdown: 'A table', pageCount: 1, model: 'mistral-ocr-latest' });
    expect(output.pages[0].tables).toHaveLength(1);
  });

  it('rejects a rubric package that cannot grade every question', () => {
    expect(() => validateRubricPackage({ questions: [{ number: 'Q1', marks: 1, question_text: 'Choose', correct_answer_summary: '', marking_rubric: 'One mark' }] }))
      .toThrow('incomplete for Q1');
    expect(validateRubricPackage({
      exam: { total_marks: 1 },
      questions: [{ number: 'Q1', marks: 1, question_text: 'Choose', correct_answer_summary: 'A', marking_rubric: '1 mark for A' }],
    }).quality).toMatchObject({ questionCount: 1, totalMarks: 1 });
  });

  it('identifies HTTP 429 rate limit and server errors as retryable statuses while treating 400 and 401 as fatal', () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableMistralStatus(status)).toBe(true);
    }
    for (const fatal of [200, 400, 401, 403, 404, 422]) {
      expect(isRetryableMistralStatus(fatal)).toBe(false);
    }
  });

  it('throws a descriptive error when model response is empty or malformed non-JSON text', () => {
    expect(() => parseJsonModelResponse('I am not JSON at all.')).toThrow('Rubric model did not return a JSON object.');
    expect(() => parseJsonModelResponse('')).toThrow('Rubric model did not return a JSON object.');
    expect(() => parseJsonModelResponse('```json\n{"invalid: json}\n```')).toThrow();
    expect(parseJsonModelResponse('Here is your json:\n```json\n{"ok": true, "score": 10}\n```\nThanks!')).toEqual({ ok: true, score: 10 });
  });

  it('handles partial page failures and missing table structures during OCR result normalization', () => {
    const partialResult = normalizeOcrResult({
      model: 'mistral-ocr-latest',
      pages: [
        { index: 0, markdown: 'Valid page 1' },
        { index: 1, markdown: null, tables: null, confidence_scores: null }, // failed or empty page
        { index: 'invalid-index', markdown: 'Page 3 fallback', tables: 'not-an-array' },
      ],
    });
    expect(partialResult.pageCount).toBe(3);
    expect(partialResult.pages[1]).toMatchObject({ index: 1, markdown: '', tables: [] });
    expect(partialResult.pages[2]).toMatchObject({ index: 2, markdown: 'Page 3 fallback', tables: [] });
    expect(partialResult.markdown).toBe('Valid page 1\n\nPage 3 fallback');
  });

  it('covers underspecified marking bands so the package can reach rubric review', () => {
    const pack = validateRubricPackage({
      questions: [{
        number: '3.4',
        marks_allocated: 2,
        expected_response_type: 'short_answer',
        question_text: 'Distinguish between conductors and insulators.',
        correct_answer_summary: 'Conductors have free electrons; insulators do not.',
        marking_rubric: '1 mark for any two correct differences. (e.g., presence of free electrons, conductivity, resistivity)',
      }],
    });
    expect(pack.questions[0].marking_rubric).toMatch(/1 mark for remaining required content from the answer key/);
  });

  it('accepts distinguishing rubrics whose bands sum to marks_allocated', () => {
    const pack = validateRubricPackage({
      questions: [{
        number: '3.4',
        marks_allocated: 2,
        expected_response_type: 'short_answer',
        question_text: 'Distinguish between conductors and insulators.',
        correct_answer_summary: 'Conductors have free electrons; insulators do not.',
        marking_rubric: '2 marks for any two correct differences; 1 mark for only one correct difference or vague wording.',
      }],
    });
    expect(pack.questions[0].marks_allocated).toBe(2);
  });

  it('skips band-sum checks for MCQ items', () => {
    expect(validateRubricPackage({
      questions: [{
        number: 'Q1',
        marks: 1,
        expected_response_type: 'mcq',
        question_text: 'Pick A',
        correct_answer_summary: 'A',
        marking_rubric: 'Exact option match',
      }],
    }).quality.totalMarks).toBe(1);
  });

  it('warns when a rubric effective mark total is below the declared total', () => {
    const pack = validateRubricPackage({
      exam: { total_marks: 30 },
      questions: [
        { number: 'Q1', marks: 5, question_text: 'Explain photosynthesis.', correct_answer_summary: 'Light + water + CO2 -> glucose', marking_rubric: '5 marks for full explanation' },
        { number: 'Q2', marks: 5, question_text: 'Describe respiration.', correct_answer_summary: 'Glucose -> energy', marking_rubric: '5 marks for full description' },
      ],
    });
    expect(pack.quality.warnings.some((warning) => /below the declared total 30/.test(warning))).toBe(true);
    expect(pack.quality.effectiveTotalMarks).toBe(10);
  });

  it('accepts an optional-question rubric that reconciles against its effective total, not the raw sum', () => {
    const pack = validateRubricPackage({
      exam: {
        total_marks: 30,
        scoring_plan: {
          groups: [{ id: 'section_b', choose: 3, units: [
            { id: 'Q1', question_numbers: ['Q1'] },
            { id: 'Q2', question_numbers: ['Q2'] },
            { id: 'Q3', question_numbers: ['Q3'] },
            { id: 'Q4', question_numbers: ['Q4'] },
          ] }],
        },
      },
      questions: [
        { number: 'Q1', marks: 10, question_text: 'Answer one of the optional parts.', correct_answer_summary: 'A', marking_rubric: '10 marks for full', is_optional: true },
        { number: 'Q2', marks: 10, question_text: 'Second optional part.', correct_answer_summary: 'B', marking_rubric: '10 marks for full', is_optional: true },
        { number: 'Q3', marks: 10, question_text: 'Third optional part.', correct_answer_summary: 'C', marking_rubric: '10 marks for full', is_optional: true },
        { number: 'Q4', marks: 10, question_text: 'Fourth optional part.', correct_answer_summary: 'D', marking_rubric: '10 marks for full', is_optional: true },
      ],
    });
    // Raw sum is 40, but choose=3 makes the effective total 30 == declared.
    expect(pack.quality.totalMarks).toBe(40);
    expect(pack.quality.effectiveTotalMarks).toBe(30);
    expect(pack.quality.declaredTotalMarks).toBe(30);
  });

  it('rejects a question whose text is a placeholder even when non-empty', () => {
    for (const placeholder of [
      '(Question text not provided)',
      'Unknown',
      'N/A',
      'Text not available',
      'To be provided',
      'TBD',
    ]) {
      expect(() => validateRubricPackage({
        questions: [{
          number: 'Q1', marks: 1, question_text: placeholder,
          correct_answer_summary: 'A', marking_rubric: '1 mark for A',
        }],
      })).toThrow(/placeholder question text for Q1/);
    }
  });
});

