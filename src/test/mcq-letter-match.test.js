// Letter-by-letter marking of MCQ blocks. Shapes come from the Oct 2026 PartnerD
// ICSE English Literature semi-prelim, where the model marked correct letters
// wrong over wording or OCR noise; the answer text here is made up.
import { describe, expect, it } from 'vitest';
import {
  MCQ_LETTER_UNCLEAR_TAG,
  markMcqBlock,
  matchOptionText,
  mcqBlockGradeJson,
  parseMcqKeyItems,
  parseMcqOptions,
  parseMcqStudentItems,
} from '../../shared/mcqBlock.js';
import { gradeWithSupervision } from '../../apps/processing-worker/gradeSupervisor.js';

const questionText = 'Choose the correct answers: [4] '
  + '1. What does the soothsayer say? (a) Beware the ides of March (b) Good luck (c) Farewell (d) Stay home '
  + '2. Put these in order. 1. Brutus speaks. 2. Antony speaks. (a) 1, 2 (b) 2, 1 (c) both at once (d) neither '
  + '3. Who stabs first? (a) Casca (b) Brutus (c) Cinna (d) Cassius '
  + '4. The poem\'s mood is (a) a calm and peaceful evening (b) a shattering, shocking storm of emotions (c) quiet joy (d) boredom';
const keyText = '1-(a), 2-(a), 3-(a), 4-(b)';

describe('MCQ block parsing', () => {
  it('reads a per-item key', () => {
    expect([...parseMcqKeyItems(keyText)]).toEqual([[1, 'a'], [2, 'a'], [3, 'a'], [4, 'b']]);
    expect(parseMcqKeyItems('(b) 14 amu').size).toBe(0);
  });

  it('groups printed options by item, ignoring numbered lists inside a stem', () => {
    const options = parseMcqOptions(questionText, 4);
    expect(options.get(2)).toEqual({ a: '1, 2', b: '2, 1', c: 'both at once', d: 'neither' });
    expect(options.get(4).b).toBe('a shattering, shocking storm of emotions');
  });

  it('reads answer lines in the usual handwritten formats, and overwrites', () => {
    const items = parseMcqStudentItems('1. a) Beware\n(2) (b) 2, 1\n- 3 c - Cinna\n4. (b)(d) storm');
    expect(items.get(1).letters).toEqual(['a']);
    expect(items.get(2).letters).toEqual(['b']);
    expect(items.get(3)).toMatchObject({ letters: ['c'], text: 'Cinna' });
    expect(items.get(4).letters).toEqual(['b', 'd']);
  });

  it('reads roman item labels, "]" brackets and a label written alone on its line', () => {
    const items = parseMcqStudentItems('(i) (b) text\n(ii)\n(a) (b) Monsoon\niv] c] text\nv] a] text');
    expect(items.get(1).letters).toEqual(['b']);
    expect(items.get(2)).toMatchObject({ letters: ['a', 'b'], text: 'Monsoon' });
    expect(items.get(4).letters).toEqual(['c']);
    expect(items.get(5).letters).toEqual(['a']);
    expect([...parseMcqKeyItems('(i) (b) Mild winters; (ii) (b) Monsoon; (iii) (a) Chambal Valley')]).toEqual([[1, 'b'], [2, 'b'], [3, 'a']]);
  });

  it('ignores a key whose items do not run 1…n', () => {
    expect(parseMcqKeyItems('1-(a), 3-(b)').size).toBe(0);
  });

  it('reads the article "A" as text, not as option (a)', () => {
    const items = parseMcqStudentItems('2. A cyclone\n1. (b) A sense of loss\n- 3 d - I wish\n5. b\n6. a. text');
    expect(items.get(2)).toMatchObject({ letters: [], text: 'A cyclone' });
    expect(items.get(1)).toMatchObject({ letters: ['b'], text: 'A sense of loss' });
    expect(items.get(3).letters).toEqual(['d']);
    expect(items.get(5).letters).toEqual(['b']);
    expect(items.get(6).letters).toEqual(['a']);
  });

  it('matches written option text only when one option clearly wins', () => {
    const options = parseMcqOptions(questionText, 4).get(4);
    expect(matchOptionText('A shattering shocking storm of emotion', options)).toBe('b');
    expect(matchOptionText('emotions', options)).toBeNull();
  });
});

describe('markMcqBlock', () => {
  it('marks by letter even when the wording or a typo differs from the option', () => {
    const result = markMcqBlock({ keyText, questionText, maxMarks: 4, studentAnswer: '1. a) Bewear the ides\n2. a) 1,2\n3. a) Caska\n4. b) storm' });
    expect(result.marks).toBe(4);
    expect(result.unclear).toEqual([]);
  });

  it('falls back to the option text when OCR misreads the letter', () => {
    const result = markMcqBlock({ keyText, questionText, maxMarks: 4, studentAnswer: '1. a) Beware\n2. a) 1, 2\n3. b) Brutus\n4. (1) A shattering, shocking storm of emotions' });
    expect(result.marks).toBe(3);
    expect(result.items.find((row) => row.item === 4)).toMatchObject({ chosen: 'b', status: 'correct', how: 'option_text' });
  });

  it('settles an overwrite by the written text, and flags one it cannot settle', () => {
    const settled = markMcqBlock({ keyText, questionText, maxMarks: 4, studentAnswer: '4. d) b) a shattering, shocking storm of emotions' });
    expect(settled.items.find((row) => row.item === 4)).toMatchObject({ chosen: 'b', status: 'correct' });
    const open = markMcqBlock({ keyText, questionText, maxMarks: 4, studentAnswer: '3. (b)(a) ...' });
    expect(open.unclear).toEqual([3]);
    expect(open.items.find((row) => row.item === 3).status).toBe('unclear');
  });

  it('scores a missing item as not attempted, never as correct', () => {
    const result = markMcqBlock({ keyText, questionText, maxMarks: 4, studentAnswer: '1. a)\n2. a)\n3. a)' });
    expect(result.marks).toBe(3);
    expect(result.items.find((row) => row.item === 4).status).toBe('not_attempted');
  });

  it('follows a numbering restart only when the text confirms the item', () => {
    const confirmed = markMcqBlock({ keyText, questionText, maxMarks: 4, studentAnswer: '1. a)\n2. a)\n3. a)\n2. b) a shattering, shocking storm of emotions' });
    expect(confirmed.marks).toBe(4);
    const unconfirmed = markMcqBlock({ keyText, questionText, maxMarks: 4, studentAnswer: '1. a)\n2. a)\n3. a)\n2. b) something else' });
    expect(unconfirmed.unclear).toEqual([4]);
  });

  it('declines a block it cannot mark, so the model grades it', () => {
    expect(markMcqBlock({ keyText: 'See marking scheme', questionText, maxMarks: 4, studentAnswer: '1. a)' })).toBeNull();
    expect(markMcqBlock({ keyText, questionText, maxMarks: 5, studentAnswer: '1. a)' })).toBeNull();
    // A truncated key: the rubric's 1 mark each does not reach the question's 15 marks.
    expect(markMcqBlock({ keyText: '1-(d), 2-(b), 3-(d) …', questionText, maxMarks: 15, markingRubric: '1 mark for each correct option; 15 marks total.', studentAnswer: '1. d)' })).toBeNull();
    expect(markMcqBlock({ keyText, questionText, maxMarks: 4, markingRubric: '1 mark for each correct option.', studentAnswer: '1. a)' })).not.toBeNull();
  });

  it('produces grade JSON whose parts add up to the mark, flagged when an item is unclear', () => {
    const json = mcqBlockGradeJson(markMcqBlock({ keyText, questionText, maxMarks: 4, studentAnswer: '1. a)\n2. b)\n3. (b)(a)\n4. b)' }));
    expect(json.marks_awarded).toBe(2);
    expect(json.parts.reduce((sum, part) => sum + part.marks_obtained, 0)).toBe(2);
    expect(json.needs_review).toBe(true);
    expect(json.review_reasons).toEqual([MCQ_LETTER_UNCLEAR_TAG]);
    expect(json.needs_attention).toMatch(/Incorrect: 2 \(chose b, answer a\)/);
  });
});

describe('MCQ blocks in grading', () => {
  const question = { question_text: questionText, answer_key_text: keyText, marks_total: 4, expected_response_type: 'mcq' };
  const rubric = { expected_response_type: 'mcq', marking_rubric: '1 mark for each correct option. 4 marks total.' };

  it('are marked letter by letter without calling the model', async () => {
    const callJson = async () => { throw new Error('the model should not be called'); };
    const result = await gradeWithSupervision({ question, rubric, evidence: { attempted: true, student_answer: '1. a) x\n2. b) y\n3. a) z\n4. b) w' }, callJson });
    expect(result.model).toBe('mcq_letter_match');
    expect(result.grade.marks).toBe(3);
    expect(result.grade.parts).toHaveLength(4);
    expect(result.grade.needsReview).toBe(false);
  });

  it('still go to the model when the key is not per item', async () => {
    let called = false;
    const callJson = async () => { called = true; return { value: { marks_awarded: 2, criteria: [] } }; };
    await gradeWithSupervision({ question: { ...question, answer_key_text: 'Refer to the scheme.' }, rubric, evidence: { attempted: true, student_answer: '1. a)' }, callJson });
    expect(called).toBe(true);
  });
});
