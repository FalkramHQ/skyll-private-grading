import { describe, expect, it } from 'vitest';
import {
  buildExtractionPrompt,
  classifyExam,
  parseMcqAnswersFromOcr,
} from '../../apps/processing-worker/evidencePipeline.js';

describe('parseMcqAnswersFromOcr', () => {
  it('parses bracket and paren option lists', () => {
    const ocr = `
Name: Test
1] A.
2] C
3]
4] D
(14) (D)
Q15) C
`;
    const parsed = parseMcqAnswersFromOcr(ocr, ['Q1', 'Q2', 'Q3', 'Q4', 'Q14', 'Q15']);
    expect(parsed.get('Q1').letter).toBe('A');
    expect(parsed.get('Q2').letter).toBe('C');
    expect(parsed.get('Q3')).toBeUndefined();
    expect(parsed.get('Q4').letter).toBe('D');
    expect(parsed.get('Q14').letter).toBe('D');
    expect(parsed.get('Q15').letter).toBe('C');
  });

  it('parses Ans) (A) style lines', () => {
    const ocr = `
Q.3.
Ans) (A)
Q.5.
Ans) (D)
Q.7.
Ans) (A)
`;
    const parsed = parseMcqAnswersFromOcr(ocr, ['Q3', 'Q5', 'Q7', 'Q8']);
    expect(parsed.get('Q3').letter).toBe('A');
    expect(parsed.get('Q5').letter).toBe('D');
    expect(parsed.get('Q7').letter).toBe('A');
    expect(parsed.get('Q8')).toBeUndefined();
  });
});

describe('MCQ extraction prompt', () => {
  it('uses number/letter matching for all-MCQ exams, not keyword matching', () => {
    const questions = Array.from({ length: 3 }, (_, i) => ({
      number: `Q${i + 1}`,
      question_text: 'Pick an option about vectors',
      marks_allocated: 4,
      expected_response_type: 'mcq',
    }));
    const classification = classifyExam(questions);
    expect(classification.allMcq).toBe(true);
    const prompt = buildExtractionPrompt(
      { questions, label: 'all' },
      '1] A\n2] B',
      classification,
    );
    expect(prompt).toContain('ALL-MCQ');
    expect(prompt).toContain('Do NOT ignore question numbers');
    expect(prompt).not.toContain('IGNORE all section headers');
    expect(prompt).not.toContain('identify 2-3 KEYWORDS');
  });
});
