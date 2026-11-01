import { describe, expect, it } from 'vitest';
import { locateAnswers, normalizeAnswerText } from '../../api/_lib/answerLocator.js';

const byNumber = (rows) => Object.fromEntries(rows.map((row) => [row.questionNumber, row]));

describe('normalizeAnswerText', () => {
  it('keeps letters and marks in any script, drops HTML, LaTeX commands and punctuation', () => {
    expect(normalizeAnswerText('<p><u>Advantages</u> of optical-fiber :-</p>')).toBe(' advantages of optical fiber ');
    expect(normalizeAnswerText('$L = \\text{length} = [L^1]$')).toBe(' l length l 1 ');
    expect(normalizeAnswerText('5 बच्चों का हुजूम।')).toBe(' 5 बच्चों का हुजूम ');
  });
});

describe('locateAnswers', () => {
  it('finds a unique match and estimates how far down the page it starts', () => {
    const pages = [
      'Q.No. 1 i) c> centigrade ii) d> Distance',
      'Q3 i) Quantities:- Fundamental units: The physical quantities which do not depend',
    ];
    const rows = byNumber(locateAnswers({
      pages,
      questions: [
        { id: 'q1', questionNumber: 'Q1ii', answer: 'd> Distance' },
        { id: 'q2', questionNumber: 'Q3i', answer: 'Quantities:- Fundamental ~~units~~: The physical quantities' },
      ],
    }));
    expect(rows.Q1ii).toMatchObject({ id: 'q1', page: 1, match: 'unique', answered: true });
    expect(rows.Q1ii.offset).toBeGreaterThan(0.5);
    expect(rows.Q3i).toMatchObject({ page: 2, match: 'unique' });
    expect(rows.Q3i.offset).toBeLessThan(0.2);
  });

  it('resolves a short answer found on several pages using the question label and its neighbours', () => {
    const pages = [
      'Section A 1) i) b ii) a',
      'iii) c iv) a 2) The derivative of x squared is 2x',
      'i) a 3) Integration by parts gives the result',
    ];
    const rows = byNumber(locateAnswers({
      pages,
      questions: [
        { questionNumber: 'Q1ii', answer: 'a' },
        { questionNumber: 'Q1iii', answer: 'c' },
        { questionNumber: 'Q1iv', answer: 'a' },
        { questionNumber: 'Q2', answer: 'The derivative of x squared is 2x' },
      ],
    }));
    expect(rows.Q1ii).toMatchObject({ page: 1, match: 'unique' });
    expect(rows.Q1iii).toMatchObject({ page: 2, match: 'unique' });
    // "iv a" is only on page 2; a bare "a" would have matched every page.
    expect(rows.Q1iv).toMatchObject({ page: 2, match: 'unique' });
  });

  it('picks the hit after the previous located answer when the text repeats on several pages', () => {
    const pages = [
      'Q1 answer kinetic energy is half m v squared',
      'Q2 work done is force times displacement',
      'Q3 kinetic energy is half m v squared again written',
    ];
    const rows = byNumber(locateAnswers({
      pages,
      questions: [
        { questionNumber: 'Q2', answer: 'work done is force times displacement' },
        { questionNumber: 'Q3', answer: 'kinetic energy is half m v squared' },
      ],
    }));
    expect(rows.Q3).toMatchObject({ page: 3, match: 'ambiguous' });
  });

  it('places a blank answer at the gap between its neighbours', () => {
    const pages = ['1) i) photons obeying waves', '3) i) compound microscope is used to observe'];
    const rows = byNumber(locateAnswers({
      pages,
      questions: [
        { questionNumber: 'Q1i', answer: 'photons obeying waves' },
        { questionNumber: 'Q2v', answer: '' },
        { questionNumber: 'Q3i', answer: 'compound microscope is used to observe' },
        { questionNumber: 'Q4i', answer: '   ' },
      ],
    }));
    // Neighbours on pages 1 and 2: the gap is the page boundary, i.e. the top of page 2.
    expect(rows.Q2v).toMatchObject({ answered: false, page: 2, offset: 0, match: 'inferred' });
    // Nothing after it: where the previous answer starts.
    expect(rows.Q4i).toMatchObject({ answered: false, page: 2, match: 'inferred' });
    expect(rows.Q4i.offset).toBe(rows.Q3i.offset);
  });

  it('places a blank answer just before the next answer when both neighbours share a page', () => {
    const rows = byNumber(locateAnswers({
      pages: ['1) photons obeying waves 2) blank space here 3) compound microscope is used to observe'],
      questions: [
        { questionNumber: 'Q1', answer: 'photons obeying waves' },
        { questionNumber: 'Q2', answer: '' },
        { questionNumber: 'Q3', answer: 'compound microscope is used to observe' },
      ],
    }));
    expect(rows.Q2).toMatchObject({ page: 1, match: 'inferred', offset: rows.Q3.offset });
  });

  it('infers rather than guesses when every repeat of the text lies outside its neighbours', () => {
    // Q1(iii)'s text appears only on pages 2 and 4, but Q1(ii) and Q1(iv) are both on page 1.
    const pages = [
      'Q1 ii) b ultrasonic waves iii) a violet iv) d gamma rays',
      'Q3 a diagram of light dispersion through a prism',
      'Q4 sound needs a medium to travel',
      'Q5 again a diagram of light dispersion through a prism',
    ];
    const rows = byNumber(locateAnswers({
      pages,
      questions: [
        { questionNumber: 'Q1(ii)', answer: 'b ultrasonic waves' },
        { questionNumber: 'Q1(iii)', answer: 'diagram of light dispersion through a prism' },
        { questionNumber: 'Q1(iv)', answer: 'd gamma rays' },
      ],
    }));
    expect(rows['Q1(iii)']).toMatchObject({ page: 1, match: 'inferred', offset: rows['Q1(iv)'].offset });
  });

  it('infers a page for an answered question whose text is not on any page', () => {
    const rows = byNumber(locateAnswers({
      pages: ['1) refraction bends light toward the normal'],
      questions: [
        { questionNumber: 'Q1', answer: 'refraction bends light toward the normal' },
        { questionNumber: 'Q2', answer: 'completely unrelated handwriting the OCR never saw' },
      ],
    }));
    expect(rows.Q2).toMatchObject({ answered: true, page: 1, match: 'inferred' });
  });

  it('returns the page where an answer spanning two pages starts', () => {
    const pages = [
      'Q5 iii) a) Significant figure :- Significant figures in a',
      'measurement are the reliable digits plus the first uncertain digit',
    ];
    const rows = byNumber(locateAnswers({
      pages,
      questions: [{ questionNumber: 'Q5iii', answer: 'iii) a) Significant figure :- Significant figures in a measurement are the reliable digits' }],
    }));
    expect(rows.Q5iii).toMatchObject({ page: 1, match: 'unique' });
  });

  it('matches Devanagari answers', () => {
    const rows = byNumber(locateAnswers({
      pages: ['प्रश्न 1 उत्तर', 'प्रश्न 2 (5) बच्चों का हुजूम मैदान में खेल रहा था'],
      questions: [{ questionNumber: 'Q2(5)', answer: 'बच्चों का हुजूम मैदान में' }],
    }));
    expect(rows['Q2(5)']).toMatchObject({ page: 2, match: 'unique' });
  });

  it('does not let a short label match inside a longer word', () => {
    const rows = byNumber(locateAnswers({
      pages: ['vi a long answer here', 'i a'],
      questions: [{ questionNumber: 'Q1i', answer: 'a' }],
    }));
    expect(rows.Q1i).toMatchObject({ page: 2, match: 'unique' });
  });

  it('reports none when nothing anchors the question', () => {
    expect(locateAnswers({ pages: [], questions: [{ questionNumber: 'Q1', answer: 'anything at all' }] }))
      .toEqual([{ questionNumber: 'Q1', answered: true, page: null, offset: null, match: 'none' }]);
    expect(locateAnswers({ pages: ['some text'], questions: [{ questionNumber: 'Q1', answer: '' }] })[0])
      .toMatchObject({ answered: false, page: null, match: 'none' });
  });
});
