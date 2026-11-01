import { describe, expect, it } from 'vitest';
import { createStudentReportView, normalizePartsForReport } from '../lib/reportViewModel';

describe('student report view model', () => {
  it('preserves OCR table rows in question summaries', () => {
    const view = createStudentReportView({
      subjects: [{
        name: 'Accounts',
        questions: [{
          number: 'Q11',
          summary: 'Balance sheet:\n| Liabilities | Assets |\n| Creditors | Cash |',
          marks_obtained: 0,
          marks_total: 6,
        }],
      }],
    });

    expect(view.subjects[0].questions[0].summary).toContain('\n| Liabilities | Assets |\n');
  });

  it('keeps student work line breaks but removes internal asset markers', () => {
    const view = createStudentReportView({
      subjects: [{
        name: 'Accounts',
        questions: [{
          number: 'Q8',
          student_answer: 'From asset_7b989: 8] Journal Entry\n| Date | Particulars |\n| --- | --- |',
          marks_obtained: 0,
          marks_total: 3,
        }],
      }],
    });

    const answer = view.subjects[0].questions[0].student_answer;
    expect(answer).not.toContain('From asset_');
    expect(answer).toContain('\n| Date | Particulars |');
  });
});

describe('structured sub-part view model', () => {
  it('exposes structured parts with stable typed shape and text status', () => {
    const view = createStudentReportView({
      subjects: [{
        name: 'English',
        questions: [{
          number: 'Q3',
          summary: 'Write ten synonyms',
          marks_obtained: 7,
          marks_total: 10,
          parts: [
            { label: '(a)', prompt: 'First synonym', response: 'happy', expected: 'joyful', marks_obtained: 1, marks_total: 1, status: 'correct' },
            { label: '(b)', prompt: 'Second synonym', response: 'sad', expected: 'gloomy', marks_obtained: 0, marks_total: 1, status: 'incorrect' },
            { label: '(c)', prompt: 'Third synonym', response: '', expected: 'bright', marks_obtained: 0, marks_total: 1, status: 'not_attempted' },
          ],
        }],
      }],
    });

    const parts = view.subjects[0].questions[0].parts;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ label: '(a)', marks_obtained: 1, marks_total: 1, status: 'correct', statusLabel: 'Correct' });
    expect(parts[2]).toMatchObject({ status: 'not_attempted', statusLabel: 'Not attempted' });
    // State must never rely on colour alone - a text label is always produced.
    expect(parts.every((part) => typeof part.statusLabel === 'string' && part.statusLabel.length > 0)).toBe(true);
  });

  it('keeps row marks consistent with the displayed overall total', () => {
    const view = createStudentReportView({
      subjects: [{
        name: 'Science',
        questions: [{
          number: 'Q5',
          summary: 'Label the parts of a flower',
          marks_obtained: 6,
          marks_total: 10,
          parts: Array.from({ length: 10 }, (_, i) => ({
            label: `(${i + 1})`,
            prompt: `Sub-part ${i + 1}`,
            response: i % 2 ? '' : `answer ${i}`,
            expected: `expected ${i}`,
            marks_obtained: i < 6 ? 1 : 0,
            marks_total: 1,
            status: i < 6 ? 'correct' : 'not_attempted',
          })),
        }],
      }],
    });

    const parts = view.subjects[0].questions[0].parts;
    expect(parts).toHaveLength(10);
    const rowSum = parts.reduce((sum, part) => sum + part.marks_obtained, 0);
    expect(rowSum).toBe(6);
    expect(view.subjects[0].questions[0].marks_obtained).toBe(6);
  });

  it('preserves language and mathematical content in prompts and responses', () => {
    const view = createStudentReportView({
      subjects: [{
        name: 'Maths',
        questions: [{
          number: 'Q1',
          summary: 'Solve',
          marks_obtained: 3,
          marks_total: 6,
          parts: [
            { label: '(i)', prompt: 'हल कीजिए: **integrate** $x^2$', response: '$\\frac{x^3}{3}$', expected: '$\\frac{x^3}{3}+c$', marks_obtained: 2, marks_total: 3, status: 'partial' },
          ],
        }],
      }],
    });

    const part = view.subjects[0].questions[0].parts[0];
    expect(part.prompt).toContain('हल कीजिए');
    expect(part.prompt).toContain('$x^2$');
    expect(part.response).toContain('$\\frac{x^3}{3}$');
    expect(part.statusLabel).toBe('Partial');
  });

  it('renders legacy prose fallback when no structured parts exist', () => {
    const view = createStudentReportView({
      subjects: [{
        name: 'History',
        questions: [{
          number: 'Q2',
          summary: 'Describe the Indus Valley',
          marks_obtained: 4,
          marks_total: 8,
          grading_reason: 'First correct, second wrong.',
          parts: undefined,
        }],
      }],
    });

    const parts = view.subjects[0].questions[0].parts;
    expect(parts).toEqual([]);
    // Legacy prose is preserved for the flattened fallback rendering.
    expect(view.subjects[0].questions[0].grading_reason).toBe('First correct, second wrong.');
  });

  it('defaults missing answers to not_attempted with 0 marks', () => {
    const parts = normalizePartsForReport([
      { label: '(a)', prompt: 'Part a', response: '', expected: 'x', marks_obtained: 0, marks_total: 1, status: 'not_attempted' },
      { label: '(b)', prompt: 'Part b', response: '', expected: 'y', marks_obtained: 0, marks_total: 1 },
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[0].status).toBe('not_attempted');
    expect(parts[1].status).toBe('not_attempted');
    expect(parts[1].marks_obtained).toBe(0);
  });
});
