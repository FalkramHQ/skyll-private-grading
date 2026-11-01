import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRubricGate,
  effectiveTotal,
  keyOptionLetter,
  markBands,
  printedOptionLetters,
  rubricGateEnabled,
  validOverrideReason,
} from '../../shared/rubricGate.js';
import { markingRubricPolicy, validateRubricPackage } from '../../workers/mistral-ocr/src/ocrProtocol.js';
import {
  approveRubricAndMarkForGrading,
  loadRubricReviewPackage,
  saveRubricReviewEdits,
} from '../../api/_lib/rubricReviewService.js';

const codes = (result) => result.errors.map((e) => [e.code, e.question]);
const q = (number, extra = {}) => ({
  number,
  question_text: 'Explain.',
  correct_answer_summary: 'x',
  marks_allocated: 2,
  expected_response_type: 'short_answer',
  marking_rubric: '1 mark for idea; 1 mark for example',
  mark_step: 0.5,
  mark_step_source: 'key',
  ...extra,
});

describe('rubricGateEnabled', () => {
  it('is off unless RUBRIC_GATE_SCHOOLS names the school by name or id', () => {
    expect(rubricGateEnabled({ school: 'PartnerB' }, {})).toBe(false);
    expect(rubricGateEnabled({ school: 'PartnerB' }, { RUBRIC_GATE_SCHOOLS: 'partnerb, PartnerE' })).toBe(true);
    expect(rubricGateEnabled({ school: 'PartnerD', schoolId: 'school_9' }, { RUBRIC_GATE_SCHOOLS: 'school_9' })).toBe(true);
    expect(rubricGateEnabled({ school: 'PartnerD' }, { RUBRIC_GATE_SCHOOLS: 'PartnerB' })).toBe(false);
    expect(rubricGateEnabled({ school: 'Anyone' }, { RUBRIC_GATE_SCHOOLS: '*' })).toBe(true);
  });
});

describe('checkRubricGate', () => {
  it('passes a clean package', () => {
    const result = checkRubricGate({ exam: { declared_total_marks: 4 }, questions: [q('Q1'), q('Q2')] });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it('flags the automatic filler band and bands that fall short', () => {
    const result = checkRubricGate({ questions: [
      q('Q1', { marks_allocated: 5, marking_rubric: '1 mark for i 4 marks for remaining required content from the answer key.' }),
      q('Q2', { marks_allocated: 3, marking_rubric: '1 mark for idea' }),
      q('Q3', { marks_allocated: 3, marking_rubric: 'Award fairly.' }),
    ] });
    expect(codes(result)).toEqual([['FILLER_BAND', 'Q1'], ['BANDS_BELOW_MARKS', 'Q2'], ['BANDS_MISSING', 'Q3']]);
  });

  it('allows tiered alternatives but not a band above the question marks', () => {
    const tiered = q('Q1', { marking_rubric: '2 marks for both differences; 1 mark for one' });
    expect(checkRubricGate({ questions: [tiered] }).errors).toEqual([]);
    expect(codes(checkRubricGate({ questions: [q('Q2', { marking_rubric: '3 marks for everything' })] }))).toEqual([['BAND_ABOVE_MARKS', 'Q2']]);
  });

  it("checks band values against the question's own step, with no fixed default", () => {
    const halves = q('Q1', { marks_allocated: 1, marking_rubric: '0.5 marks for idea; 0.5 marks for unit', mark_step: 1 });
    expect(codes(checkRubricGate({ questions: [halves] }))).toEqual([['BAND_OFF_STEP', 'Q1']]);
    const quarter = q('Q2', { marks_allocated: 1, marking_rubric: '0.25 marks for each of four items', mark_step: 0.25 });
    expect(checkRubricGate({ questions: [quarter] }).errors).toEqual([]);
  });

  it('trusts per-item bands to reach full marks', () => {
    const each = q('Q1', { marks_allocated: 4, marking_rubric: '1 mark for each correct point', mark_step: 1 });
    expect(checkRubricGate({ questions: [each] }).errors).toEqual([]);
  });

  it('does not require a mark step: it is optional and only checked when an admin sets one', () => {
    const result = checkRubricGate({ questions: [q('Q1', { mark_step: undefined, mark_step_source: undefined })] });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it('flags an MCQ key outside the printed options, and skips MCQs with no printed options', () => {
    const mcq = { expected_response_type: 'mcq', marks_allocated: 1, marking_rubric: '1 mark', mark_step: 1 };
    const bad = q('Q1', { ...mcq, question_text: 'Pick one: (a) 12 (b) 14 (c) 16', correct_answer_summary: '(d) 18' });
    const textOnly = q('Q2', { ...mcq, question_text: 'Pressure cooker cooks faster because', correct_answer_summary: 'd) boiling point rises' });
    const assertionReason = q('Q3', { ...mcq, question_text: 'Assertion (A): CH2O has carbon in state zero. Reason (R): it is covalent. (d) none', correct_answer_summary: 'b' });
    expect(codes(checkRubricGate({ questions: [bad, textOnly, assertionReason] }))).toEqual([['MCQ_KEY_NOT_OPTION', 'Q1']]);
  });

  it('flags several blanks scored as one unit', () => {
    const cloze = q('Q2c', { marks_allocated: 5, marking_rubric: '1 mark for each blank; 1 mark for each blank; 1 mark for each blank; 1 mark for each blank; 1 mark for each blank', question_text: 'Fill in: ____ , ____ , ____ , ____ and ____.', mark_step: 1 });
    expect(codes(checkRubricGate({ questions: [cloze] }))).toEqual([['MULTI_BLANK_SINGLE_UNIT', 'Q2c']]);
  });

  it('checks choice groups against the questions with scoring number folding', () => {
    const questions = [q('Q11(a)'), q('Q11(b)'), q('Q11(c)')];
    const ok = { groups: [{ id: 'q11', choose: 2, units: [{ question_numbers: ['Q11a'] }, { question_numbers: ['11(b)'] }, { question_numbers: ['Q11_c'] }] }] };
    expect(checkRubricGate({ exam: { scoring_plan: ok, declared_total_marks: 4 }, questions }).errors).toEqual([]);
    const dangling = { groups: [{ id: 'q11', choose: 2, units: [{ question_numbers: ['Q11a'] }, { question_numbers: ['Q11b'] }, { question_numbers: ['Q12'] }] }] };
    expect(codes(checkRubricGate({ exam: { scoring_plan: dangling }, questions }))).toEqual([['CHOICE_GROUP_UNKNOWN_QUESTION', null]]);
  });

  it('flags choice rules the paper states but no group encodes', () => {
    const anyN = checkRubricGate({ exam: { optional_rules: 'Attempt any two of Q7–Q9' }, questions: [q('Q7')] });
    expect(codes(anyN)).toEqual([['CHOICE_RULE_NOT_ENCODED', null]]);
    const orAlt = checkRubricGate({ questions: [q('14(iii)'), q('14(iii) OR')] });
    expect(codes(orAlt)).toEqual([['CHOICE_RULE_NOT_ENCODED', '14(iii) OR']]);
  });

  it("compares the effective total with the paper's declared total only", () => {
    const questions = [q('Q1'), q('Q2'), q('Q3')];
    const plan = { groups: [{ id: 'b', choose: 1, units: [{ question_numbers: ['Q2'] }, { question_numbers: ['Q3'] }] }] };
    expect(effectiveTotal(questions, plan)).toBe(4);
    expect(checkRubricGate({ exam: { scoring_plan: plan, declared_total_marks: 4 }, questions }).errors).toEqual([]);
    expect(codes(checkRubricGate({ exam: { scoring_plan: plan }, quality: { declaredTotalMarks: 5 }, questions }))).toEqual([['TOTAL_MISMATCH', null]]);
    // total_marks alone may be the raw sum, so it never triggers a mismatch.
    expect(checkRubricGate({ exam: { scoring_plan: plan, total_marks: 6 }, questions }).errors).toEqual([]);
  });
});

describe('helpers', () => {
  it('reads bands, printed options and key letters', () => {
    expect(markBands('½ mark for unit; 2 marks for working')).toEqual([0.5, 2]);
    expect([...printedOptionLetters('(a) one (b) two (c) three')]).toEqual(['a', 'b', 'c']);
    expect(keyOptionLetter('(b) 14 amu')).toBe('b');
    expect(keyOptionLetter('boiling point')).toBeNull();
  });

  it('requires a real reason to override', () => {
    expect(validOverrideReason('ok')).toBeNull();
    expect(validOverrideReason('  Paper prints 40; questions add to 35.  ')).toBe('Paper prints 40; questions add to 35.');
  });
});

describe('validateRubricPackage with the gate', () => {
  const raw = {
    exam: { total_marks: 5 },
    questions: [{ number: 'Q1', question_text: 'Explain osmosis.', correct_answer_summary: 'x', marking_rubric: '1 mark for definition', marks_allocated: 3, expected_response_type: 'short_answer', mark_step: 0.5, mark_step_source: 'key' }],
  };

  it('keeps today\'s padding when the gate is off', () => {
    const out = validateRubricPackage(raw);
    expect(out.questions[0].marking_rubric).toMatch(/remaining required content/);
    expect(out.exam.declared_total_marks).toBeUndefined();
  });

  it('leaves under-covered bands for the gate to report instead of padding them', () => {
    const out = validateRubricPackage(raw, { gate: true });
    expect(out.questions[0].marking_rubric).toBe('1 mark for definition');
    expect(out.questions[0]).toMatchObject({ mark_step: 0.5, mark_step_source: 'key' });
    expect(out.exam.declared_total_marks).toBe(5);
    expect(codes(checkRubricGate(out))).toEqual([['BANDS_BELOW_MARKS', 'Q1'], ['TOTAL_MISMATCH', null]]);
  });

  it('builds the same rubric prompt whether or not the gate is on', () => {
    // Gated prompt rules were measured and dropped; the prompt is the same either way.
    expect(markingRubricPolicy()).not.toMatch(/mark_step/);
  });
});

// Minimal stand-in for the libsql client: answers the review service's queries.
function fakeDb({ questions, quality = {}, exam = {}, school = 'PartnerB' }) {
  const state = { map: { exam, questions, quality }, quality, batches: [], updates: [] };
  return {
    state,
    async execute({ sql, args }) {
      if (sql.startsWith('SELECT * FROM tests')) return { rows: [{ id: args[0], title: 'Mid term', school, school_id: 'school_partnerb', status: 'rubric_ready_for_review' }] };
      if (sql.includes('FROM exam_rubric_versions')) return { rows: [{ id: 'rubric_1', version: 3, model: 'm', question_map_json: JSON.stringify(state.map), quality_json: JSON.stringify(state.quality) }] };
      if (sql.includes('FROM file_assets')) return { rows: [] };
      if (sql.includes("type = 'materialize_evidence'")) return { rows: [] };
      if (sql.startsWith('UPDATE exam_rubric_versions')) {
        state.map = JSON.parse(args[0]); state.quality = JSON.parse(args[1]); state.updates.push(args);
        return { rows: [] };
      }
      return { rows: [] };
    },
    async batch(ops) { state.batches.push(ops); },
  };
}
const admin = { role: 'skyll_admin', username: 'ops' };

describe('rubric review service with the gate', () => {
  const env = process.env.RUBRIC_GATE_SCHOOLS;
  afterEach(() => { process.env.RUBRIC_GATE_SCHOOLS = env; if (env === undefined) delete process.env.RUBRIC_GATE_SCHOOLS; });
  const broken = [q('Q1', { marks_allocated: 3, marking_rubric: '1 mark for definition' })];

  it('reports the gate as off and approves as before when the school is not listed', async () => {
    delete process.env.RUBRIC_GATE_SCHOOLS;
    const db = fakeDb({ questions: broken });
    const pack = await loadRubricReviewPackage(db, admin, 'test_1');
    expect(pack.gate).toMatchObject({ enabled: false, errors: [] });
    const result = await approveRubricAndMarkForGrading(db, admin, { testId: 'test_1' });
    expect(result.testStatus).toBe('evidence_queued');
  });

  it('blocks approval while errors stand', async () => {
    process.env.RUBRIC_GATE_SCHOOLS = 'PartnerB';
    const db = fakeDb({ questions: broken });
    const pack = await loadRubricReviewPackage(db, admin, 'test_1');
    expect(pack.gate.errors.map((e) => e.code)).toEqual(['BANDS_BELOW_MARKS']);
    await expect(approveRubricAndMarkForGrading(db, admin, { testId: 'test_1', overrideReason: 'too short' })).rejects.toMatchObject({ statusCode: 409 });
    expect(db.state.batches).toEqual([]);
  });

  it('approves with a reason and records the bypass on the job and the rubric version', async () => {
    process.env.RUBRIC_GATE_SCHOOLS = '*';
    const db = fakeDb({ questions: broken });
    const reason = 'Key gives only the definition; 3 marks is a misprint on the paper.';
    await approveRubricAndMarkForGrading(db, admin, { testId: 'test_1', overrideReason: reason });
    const [ops] = db.state.batches;
    expect(JSON.parse(ops[0].args[3])).toMatchObject({ override_reason: reason, override_errors: [{ code: 'BANDS_BELOW_MARKS', question: 'Q1' }] });
    expect(ops[2].sql).toMatch(/\$\.approval/);
  });

  it('re-validates on save and keeps the printed total', async () => {
    process.env.RUBRIC_GATE_SCHOOLS = 'school_partnerb';
    const db = fakeDb({ questions: broken, exam: { declared_total_marks: 3 }, quality: { declaredTotalMarks: 3, warnings: ['stale'] } });
    const fixed = [{ ...broken[0], marking_rubric: '1 mark for definition; 2 marks for an example with explanation' }];
    const pack = await saveRubricReviewEdits(db, admin, { testId: 'test_1', questions: fixed });
    expect(db.state.map.exam.total_marks).toBe(3);
    expect(db.state.quality).toMatchObject({ gate: true, errors: [], warnings: [], effectiveTotalMarks: 3 });
    expect(pack.gate.errors).toEqual([]);
  });
});
