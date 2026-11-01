import { describe, expect, it } from 'vitest';
import {
  applyKeyCheck,
  buildAnswerPrompt,
  checkerFamily,
  classify,
  codeVerdict,
  keyCheckCandidates,
  needsDecision,
  runKeyCheck,
  singleValue,
} from '../../apps/processing-worker/keyCheck.js';
import { checkRubricGate } from '../../shared/rubricGate.js';
import { stampKeyCheckResolutions } from '../../api/_lib/rubricReviewService.js';

const rubric = {
  exam: {},
  questions: [
    { number: 'Q1', question_text: 'Mass of one nitrogen atom: (a) 14/6.02e23 g (b) 7 amu (c) 28 amu (d) 14 amu', correct_answer_summary: '(a) 14/6.02e23', marks_allocated: 1, expected_response_type: 'mcq', marking_rubric: '1 mark', mark_step: 1 },
    { number: 'Q2', question_text: 'Moles in 460 g of H2SO4?', correct_answer_summary: '5 mol', marks_allocated: 1.5, expected_response_type: 'numerical', marking_rubric: '1.5 marks for answer', mark_step: 0.5 },
    { number: 'Q3', question_text: 'Define molarity.', correct_answer_summary: 'moles of solute per litre of solution', marks_allocated: 1, expected_response_type: 'short_answer', marking_rubric: '1 mark for definition', mark_step: 0.5 },
    { number: 'Q4', question_text: 'Explain Bohr\'s postulates.', correct_answer_summary: 'stationary orbits...', marks_allocated: 5, expected_response_type: 'long_answer', marking_rubric: '1 mark for each postulate', mark_step: 1 },
  ],
};

describe('keyCheckCandidates and checkerFamily', () => {
  it('checks only single-answer types', () => {
    expect(keyCheckCandidates(rubric).map((q) => q.number)).toEqual(['Q1', 'Q2', 'Q3']);
  });

  it('never checks with the family that built the rubric', () => {
    expect(checkerFamily('deepseek/deepseek-v4-flash-0731')).toBe('qwen');
    expect(checkerFamily('qwen3.6-flash')).toBe('deepseek');
  });

  it('keeps the key out of the answering prompt', () => {
    const prompt = buildAnswerPrompt({ paperText: 'PAPER', questions: keyCheckCandidates(rubric) });
    expect(prompt).toContain('Define molarity.');
    expect(prompt).not.toContain('5 mol');
    expect(prompt).not.toContain('moles of solute per litre');
  });
});

describe('runKeyCheck and applyKeyCheck', () => {
  it('answers without the key, compares, and opens only findings that need a decision', async () => {
    const calls = [];
    const callJson = async (prompt) => {
      calls.push(prompt);
      if (calls.length === 1) {
        // Numbers come back without the Q prefix: they must still match.
        return { model: 'Qwen/Qwen3.8-Flash', value: { answers: [
          { number: '1', answer: '(d) 14 amu', all_correct_options: ['d'], answerable: true, confidence: 'high' },
          { number: '2', answer: '4.69 mol', answerable: true, confidence: 'high' },
          { number: '3', answer: 'moles of solute in one litre of solution', answerable: true, confidence: 'high' },
        ] } };
      }
      return { model: 'Qwen/Qwen3.8-Flash', value: { verdicts: [
        { number: 'q1', verdict: 'agree', likely_correct: 'key', note: 'model got this wrong; code decides MCQs' },
        { number: 'Q2', verdict: 'disagree', likely_correct: 'independent', note: '460/98 = 4.69.' },
        { number: 'Q3', verdict: 'agree', likely_correct: 'both', note: 'Same definition.' },
      ] } };
    };
    const result = await runKeyCheck({ rubric, paperText: 'PAPER', callJson, now: () => '2026-10-19T00:00:00Z' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Answer key: 5 mol');
    expect(result.items.map((i) => [i.question, i.verdict])).toEqual([['Q1', 'disagree'], ['Q2', 'disagree'], ['Q3', 'agree']]);
    const checked = applyKeyCheck(rubric, result);
    // Q1: code says the letters differ but the model judged the key right -> recorded, not opened.
    expect(checked.questions.map((q) => q.key_check?.status ?? null)).toEqual(['none', 'open', 'none', null]);
    expect(checked.key_check).toMatchObject({ checked: 3, open: 1, disagreements: 2 });
    expect(checkRubricGate(checked).errors.map((e) => [e.code, e.question])).toEqual([['KEY_CHECK_UNRESOLVED', 'Q2']]);
  });

  it('retries answers the model dropped', async () => {
    const calls = [];
    const callJson = async (prompt) => {
      calls.push(prompt);
      if (calls.length === 1) return { value: { answers: [{ number: 'Q2', answer: '4.69 mol' }] } };
      if (calls.length === 2) return { value: { answers: [{ number: 'Q3', answer: 'mol per litre' }, { number: 'Q1', answer: 'a' }] } };
      return { value: { verdicts: [] } };
    };
    await runKeyCheck({ rubric, paperText: 'P', callJson });
    expect(calls[1]).toContain('Define molarity.');
    expect(calls[1]).not.toContain('Moles in 460 g');
  });

  it('turns "not in the paper" into an unsupported finding and missing text into unsure', () => {
    const q = rubric.questions[2];
    expect(classify(q, { answerable: false, why_not: 'not_in_paper' }).verdict).toBe('unsupported');
    expect(classify(q, { answerable: false, why_not: 'missing_or_garbled' }).verdict).toBe('unsure');
    // A warning, not a block: literature questions are answered from the textbook.
    const unsupported = classify(q, { answerable: false, why_not: 'not_in_paper' });
    expect(needsDecision(unsupported)).toBe(false);
    const checked = applyKeyCheck({ questions: [q] }, { model: 'm', ranAt: 't', items: [{ question: q.number, ...unsupported }] });
    const gate = checkRubricGate(checked);
    expect(gate.errors).toEqual([]);
    expect(gate.warnings.map((w) => w.code)).toContain('KEY_CHECK_UNSUPPORTED');
  });

  it('records "both acceptable" disagreements without opening them', () => {
    const both = classify(rubric.questions[2], { answer: 'amount of solute per litre' }, { verdict: 'disagree', likely_correct: 'both' });
    expect(both.verdict).toBe('disagree');
    expect(needsDecision(both)).toBe(false);
    expect(needsDecision({ verdict: 'disagree', likelyCorrect: 'key' })).toBe(false);
    expect(needsDecision({ verdict: 'disagree', likelyCorrect: 'independent' })).toBe(true);
  });

  it('suggests an alternative when another printed option is also correct', () => {
    const mcq = { ...rubric.questions[0], correct_answer_summary: 'D) volt' };
    const finding = classify(mcq, { answer: 'D) volt', all_correct_options: ['C', 'D'] }, { verdict: 'agree' });
    expect(finding).toMatchObject({ verdict: 'alternative', checkerAnswer: 'Also correct: option c' });
  });

  it('settles MCQ letters and equal values in code', () => {
    expect(codeVerdict({ expected_response_type: 'mcq', correct_answer_summary: '(c) AgBr' }, 'd NiO')).toBe('disagree');
    expect(codeVerdict({ expected_response_type: 'numerical', correct_answer_summary: '0.41 V' }, 'E = 0.4105 V')).toBe('agree');
    expect(codeVerdict({ expected_response_type: 'numerical', correct_answer_summary: '5 mol' }, '4.69 mol')).toBeNull();
    expect(singleValue('6.02 x 10^23 atoms') / 6.02e23).toBeCloseTo(1, 9);
  });

  it('skips open-ended questions', () => {
    const idiom = { number: 'Q9', question_text: "'तीर मारना' मुहावरे का वाक्य बनाइए।", correct_answer_summary: 'x', expected_response_type: 'short_answer' };
    const sentence = { ...idiom, number: 'Q10', question_text: 'Use "reluctant" in a sentence of your own.' };
    expect(keyCheckCandidates({ questions: [idiom, sentence, rubric.questions[2]] }).map((q) => q.number)).toEqual(['Q3']);
  });

  it('treats a missing verdict as unsure, not as agreement', async () => {
    const result = await runKeyCheck({
      rubric: { questions: [rubric.questions[2]] },
      paperText: 'P',
      callJson: async () => ({ value: {} }),
    });
    expect(result.items).toEqual([expect.objectContaining({ question: 'Q3', verdict: 'unsure', checkerAnswer: '(no answer)' })]);
  });

  it('warns, without blocking, when the check could not run', () => {
    const gate = checkRubricGate({ ...rubric, key_check: { error: 'DEEPINFRA_API_KEY is not configured.' } });
    expect(gate.errors).toEqual([]);
    expect(gate.warnings.find((w) => w.code === 'KEY_CHECK_UNAVAILABLE').message).toMatch(/could not run/);
  });
});

describe('stampKeyCheckResolutions', () => {
  const open = (number, checker) => ({ number, accepted_variations: [], key_check: { verdict: 'disagree', checker_answer: checker, status: 'open' } });

  it('stamps who resolved each disagreement and adds accepted alternatives', () => {
    const previous = [open('Q1', '(d) 14 amu'), open('Q2', '4.69 mol')];
    const edits = [
      { ...open('Q1', '(d) 14 amu'), key_check: { ...previous[0].key_check, status: 'alternative' } },
      { ...open('Q2', '4.69 mol'), key_check: { ...previous[1].key_check, status: 'kept' } },
    ];
    stampKeyCheckResolutions(edits, previous, { username: 'ops' });
    expect(edits[0].accepted_variations).toEqual(['(d) 14 amu']);
    expect(edits[0].key_check).toMatchObject({ status: 'alternative', resolved_by: 'ops' });
    expect(edits[1].key_check).toMatchObject({ status: 'kept', resolved_by: 'ops' });
    expect(checkRubricGate({ questions: edits.map((q) => ({ ...q, marks_allocated: 1, expected_response_type: 'mcq' })) }).errors).toEqual([]);
  });

  it('reopens an unknown status and clears stamps on undo', () => {
    const edits = [{ ...open('Q1', 'x'), key_check: { verdict: 'disagree', checker_answer: 'x', status: 'whatever', resolved_by: 'ops' } }];
    stampKeyCheckResolutions(edits, [open('Q1', 'x')], { username: 'ops' });
    expect(edits[0].key_check.status).toBe('open');
    expect(edits[0].key_check.resolved_by).toBeUndefined();
  });
});
