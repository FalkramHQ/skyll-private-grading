/* global process */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGradePrompt, normalizeGradeResult } from '../../apps/processing-worker/gradeResult.js';
import { auditGrade, gradeWithSupervision } from '../../apps/processing-worker/gradeSupervisor.js';
import { PARTIAL_CREDIT_ENFORCED_TAG, normalizeCriteria } from '../../shared/harshZero.js';
import {
  DUPLICATE_EVIDENCE_TAG,
  IDEA_CREDIT_REVIEW_TAG,
  STATED_ERROR_TAG,
  THIN_ANSWER_TAG,
  UNQUOTED_CREDIT_TAG,
  answerContentSize,
  findDuplicateAnswers,
  gradingCalibrationMode,
  isThinAnswer,
  namesError,
  quoteFoundInAnswer,
} from '../../shared/gradingCalibration.js';

const stubs = [
  { id: 'reagent', max: 1, label: 'reagent' },
  { id: 'product', max: 1, label: 'product' },
];

describe('grading calibration mode', () => {
  it('defaults to legacy and only switches on an explicit strict value', () => {
    expect(gradingCalibrationMode({})).toBe('legacy');
    expect(gradingCalibrationMode({ GRADE_CALIBRATION: 'off' })).toBe('legacy');
    expect(gradingCalibrationMode({ GRADE_CALIBRATION: 'calibrated' })).toBe('calibrated');
    expect(gradingCalibrationMode({ GRADE_CALIBRATION: ' Strict ' })).toBe('strict');
  });
});

describe('calibration helpers', () => {
  it('treats feedback that names an error as an error, not credit', () => {
    expect(namesError('Student identified CH2(F)CH2CH2COOH as the stronger acid, which is the incorrect acid')).toBe(true);
    expect(namesError('The order is reversed.')).toBe(true);
    expect(namesError('No significant issues; the response is complete.')).toBe(false);
    expect(namesError('')).toBe(false);
  });

  it('matches quotes across LaTeX, HTML and spacing differences', () => {
    const answer = 'MnO<sub>4</sub><sup>-</sup> is the $\\text{stronger}$ oxidising agent';
    expect(quoteFoundInAnswer('MnO4- is the stronger oxidising agent', answer)).toBe(true);
    expect(quoteFoundInAnswer('Cr2O7 is stronger', answer)).toBe(false);
    expect(quoteFoundInAnswer('is', answer)).toBe(false);
  });

  it('counts only content beyond the question wording', () => {
    const question = "i) Give Fehling's test for ethanal. ii) Give reason: Cyanohydrins are used. iii) Give the action of HCN.";
    expect(answerContentSize("2. i. Fehling's Test for ethanal :- ii. iii.", question)).toBe(0);
    expect(isThinAnswer({ studentAnswer: "Fehling's Test for ethanal :- ii. iii.", questionText: question, maxMarks: 4, responseType: 'long_answer' })).toBe(true);
    // Short but complete answers on small items are never touched.
    expect(isThinAnswer({ studentAnswer: 'PbO2, Tl2SO4', questionText: 'Write the formulae.', maxMarks: 2, responseType: 'short_answer' })).toBe(false);
    expect(isThinAnswer({ studentAnswer: 'CH3CHO + 2Cu2+ + 5OH- gives CH3COO- + Cu2O red precipitate + 3H2O', questionText: question, maxMarks: 4, responseType: 'long_answer' })).toBe(false);
  });

  it('keeps one copy of an answer extracted under two questions', () => {
    const nitration = 'Direct nitration of aniline with conc HNO3 and conc H2SO4 at 288 K gives p-nitroaniline 51%, m-nitroaniline 47%';
    const duplicates = findDuplicateAnswers([
      { questionNumber: 'Q5(1)', questionText: 'Why are aromatic aldehydes less reactive than aliphatic aldehydes?', answerKey: 'resonance', studentAnswer: nitration },
      { questionNumber: 'Q5(3)', questionText: 'Give the reaction of direct nitration of aniline.', answerKey: 'p-nitroaniline m-nitroaniline', studentAnswer: nitration },
      { questionNumber: 'Q2(i)', questionText: 'What are soaps?', answerKey: '', studentAnswer: 'Soaps are sodium salts of fatty acids' },
    ]);
    expect(duplicates.get('Q5(1)')).toBe('Q5(3)');
    expect(duplicates.has('Q5(3)')).toBe(false);
    expect(duplicates.has('Q2(i)')).toBe(false);
  });
});

describe('normalizeCriteria strict mode', () => {
  it('neither bumps nor flags a zero criterion whose note reads as credit, in any mode', () => {
    const raw = [
      { id: 'reagent', max: 1, marks: 0, note: 'Student correctly mentioned the reagent but wrote it on the wrong side.' },
      { id: 'product', max: 1, marks: 0, note: 'Student correctly stated the product class.' },
    ];
    for (const mode of [undefined, 'legacy', 'calibrated', 'strict', 'flag']) {
      const result = normalizeCriteria(raw, stubs, { whatWentCorrect: 'Student correctly stated the product class.', mode });
      expect(result.sum).toBe(0);
      expect(result.enforcedIds).toEqual([]);
      expect(result.flaggedIds).toEqual([]);
    }
  });

  it('removes credit whose evidence quote is not in the student answer', () => {
    const result = normalizeCriteria(
      [
        { id: 'reagent', max: 1, marks: 1, note: 'ok', evidence_quote: 'conc HNO3 and conc H2SO4' },
        { id: 'product', max: 1, marks: 1, note: 'ok', evidence_quote: 'gives m-nitroaniline' },
      ],
      stubs,
      { mode: 'strict', studentAnswer: 'Aniline with conc HNO3 and conc H2SO4 at 288 K gives p-nitroaniline' },
    );
    expect(result.criteria.map((c) => c.marks)).toEqual([1, 0]);
    expect(result.unquotedIds).toEqual(['product']);
  });
});

describe('normalizeGradeResult strict mode', () => {
  const question = {
    question_text: "i) Give Fehling's test for ethanal. ii) Give reason: Cyanohydrins are used as intermediates. iii) Give the action of HCN on acetone.",
    marks_total: 4,
    expected_response_type: 'long_answer',
  };
  const raw = {
    marks_awarded: 3,
    criteria: [{ id: 'overall', max: 4, marks: 3, note: 'Student identified the Fehling test.' }],
    what_went_correct: 'Student identified the Fehling test.',
  };

  it('zeroes a heading-only answer and tags it for review', () => {
    const grade = normalizeGradeResult(raw, question, { attempted: true, student_answer: "2. i. Fehling's Test for ethanal :- ii. iii." }, 'long_answer', { mode: 'strict' });
    expect(grade.marks).toBe(0);
    expect(grade.needsReview).toBe(true);
    expect(grade.reviewReasons).toContain(THIN_ANSWER_TAG);
  });

  it('zeroes an answer already credited under another question', () => {
    const grade = normalizeGradeResult(raw, question, {
      attempted: true,
      duplicate_of: 'Q5(3)',
      student_answer: 'Direct nitration of aniline with conc HNO3 and conc H2SO4 at 288 K gives p-nitroaniline and m-nitroaniline',
    }, 'long_answer', { mode: 'strict' });
    expect(grade.marks).toBe(0);
    expect(grade.reviewReasons).toContain(DUPLICATE_EVIDENCE_TAG);
  });

  it('tags unquoted credit without adding marks or flagging idea credit', () => {
    const grade = normalizeGradeResult({
      marks_awarded: 1,
      criteria: [
        { id: 'reagent', max: 1, marks: 0, note: 'Student correctly mentioned Fehling solution.' },
        { id: 'product', max: 1, marks: 1, note: 'ok', evidence_quote: 'red precipitate of Cu2O' },
      ],
    }, { question_text: 'Give Fehling test.', marks_total: 2, expected_response_type: 'short_answer' }, {
      attempted: true,
      student_answer: 'Ethanal with Fehling solution gives a blue colour',
    }, 'short_answer', { mode: 'strict', rubricCriteria: stubs });
    expect(grade.marks).toBe(0);
    expect(grade.reviewReasons).toContain(UNQUOTED_CREDIT_TAG);
    expect(grade.reviewReasons).not.toContain(IDEA_CREDIT_REVIEW_TAG);
    expect(grade.reviewReasons).not.toContain(PARTIAL_CREDIT_ENFORCED_TAG);
  });

  it('leaves legacy grading unchanged', () => {
    const grade = normalizeGradeResult(raw, question, { attempted: true, student_answer: "2. i. Fehling's Test for ethanal :- ii. iii." }, 'long_answer', { mode: 'legacy' });
    expect(grade.marks).toBe(3);
    expect(grade.reviewReasons).not.toContain(THIN_ANSWER_TAG);
  });
});

describe('strict supervision', () => {
  const prior = process.env.GRADE_CALIBRATION;
  beforeEach(() => { process.env.GRADE_CALIBRATION = 'strict'; });
  afterEach(() => {
    if (prior === undefined) delete process.env.GRADE_CALIBRATION;
    else process.env.GRADE_CALIBRATION = prior;
  });

  const question = {
    question_text: 'Justify the following reaction as redox reaction. 2Na + S -> Na2S. Find the oxidizing and reducing agents.',
    answer_key_text: 'Na loses electrons (oxidised), S gains electrons (reduced); S oxidising agent, Na reducing agent.',
    marks_total: 3,
    expected_response_type: 'long_answer',
  };
  const evidence = {
    attempted: true,
    student_answer: 'The following reaction is not an redox reaction. It is a combination reaction. Oxidizing agent = S. Reducing agent = 2Na',
  };
  const lenient = {
    marks_awarded: 2.5,
    criteria: [
      { id: 'justification', max: 1.5, marks: 1, note: 'Student named the reaction type.', evidence_quote: 'It is a combination reaction' },
      { id: 'agents', max: 1.5, marks: 1.5, note: 'Agents correct.', evidence_quote: 'Oxidizing agent = S' },
    ],
    needs_attention: 'The student incorrectly claimed the reaction is not a redox reaction and did not show electron transfer.',
  };

  it('audits a high mark whose feedback names an error', () => {
    const grade = normalizeGradeResult(lenient, question, evidence, 'long_answer', { mode: 'strict' });
    const audit = auditGrade(grade, { question, evidence, responseType: 'long_answer', mode: 'strict' });
    expect(audit.action).toBe('repair_down');
    expect(audit.reasons).toContain('stated_error_high_marks');
  });

  it('keeps the first grade: the downward recheck is off for every subject', async () => {
    const calls = [];
    const callJson = async (prompt) => { calls.push(prompt); return { value: lenient, model: 'grader' }; };
    const result = await gradeWithSupervision({ question, rubric: { expected_response_type: 'long_answer' }, evidence, callJson });
    expect(calls).toHaveLength(1);
    expect(result.grade.reviewReasons).not.toContain(STATED_ERROR_TAG);
    expect(result.supervisor.action).toBe('ok');
  });

  it('asks the grader for a quote per credited criterion', () => {
    const prompt = buildGradePrompt({ question, rubric: { expected_response_type: 'long_answer', marking_rubric: '' }, evidence, maxMarks: 3 });
    expect(prompt).toContain('evidence_quote');
    expect(prompt).toContain('what_went_correct may be empty');
    expect(prompt).not.toContain('Reserve marks_awarded = 0 only for blank');
  });
});

describe('calibrated mode', () => {
  const raw = [
    { id: 'reagent', max: 1, marks: 0, note: 'Student identified CH2(F)CH2CH2COOH as the stronger acid, which is the incorrect acid.' },
    { id: 'product', max: 1, marks: 0, note: 'Student correctly stated the product class.' },
  ];

  it('no longer adds idea credit', () => {
    const result = normalizeCriteria(raw, stubs, { whatWentCorrect: '', mode: 'calibrated' });
    expect(result.criteria.map((c) => c.marks)).toEqual([0, 0]);
    expect(result.enforcedIds).toEqual([]);
  });

  it('does not treat an error-naming what_went_correct as a harsh zero', () => {
    const audit = auditGrade({
      marks: 0,
      attempted: true,
      whatWentCorrect: 'The student identified the reaction but the product is incorrect.',
      criteria: [{ id: 'overall', max: 2, marks: 0, note: 'Product is incorrect.' }],
      isHarshZero: true,
    }, {
      question: { marks_total: 2, expected_response_type: 'long_answer' },
      evidence: { attempted: true, student_answer: 'x' },
      responseType: 'long_answer',
      markingRubric: '2 marks for the product.',
      mode: 'calibrated',
    });
    expect(audit.reasons).not.toContain('harsh_zero');
  });

  it('applies the thin-answer floor in calibrated mode too', () => {
    const grade = normalizeGradeResult(
      { marks_awarded: 3, criteria: [{ id: 'overall', max: 4, marks: 3, note: 'Student stated the test name.' }] },
      { question_text: "i) Give Fehling's test for ethanal. ii) Give reason. iii) Give action of HCN.", marks_total: 4, expected_response_type: 'long_answer' },
      { attempted: true, student_answer: "Fehling's Test for ethanal :- ii. iii." },
      'long_answer',
      { mode: 'calibrated' },
    );
    expect(grade.marks).toBe(0);
    expect(grade.reviewReasons).toContain(THIN_ANSWER_TAG);
  });
});
