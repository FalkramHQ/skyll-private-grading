/* global process */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGradePrompt, normalizeGradeResult } from '../../apps/processing-worker/gradeResult.js';
import { auditGrade, gradeWithSupervision } from '../../apps/processing-worker/gradeSupervisor.js';
import { callGradeJson } from '../../apps/processing-worker/llmGateway.js';
import { PARTIAL_CREDIT_ENFORCED_TAG } from '../../shared/harshZero.js';
import { IDEA_CREDIT_REVIEW_TAG, STATED_ERROR_TAG, THIN_ANSWER_TAG, gradingCalibrationMode, gradingCalibrationModeFor } from '../../shared/gradingCalibration.js';

const withEnv = (vars) => {
  const prior = {};
  beforeEach(() => {
    for (const [key, value] of Object.entries(vars)) {
      prior[key] = process.env[key];
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  });
  afterEach(() => {
    for (const key of Object.keys(vars)) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
  });
};

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
    { id: 'justification', max: 1.5, marks: 1, note: 'Student named the reaction type.' },
    { id: 'agents', max: 1.5, marks: 1.5, note: 'Agents correct.' },
  ],
  needs_attention: 'The student incorrectly claimed the reaction is not a redox reaction and did not show electron transfer.',
};
const creditZero = {
  marks_awarded: 1.5,
  criteria: [
    { id: 'justification', max: 1.5, marks: 0, note: 'Student correctly identified that electrons move between Na and S.' },
    { id: 'agents', max: 1.5, marks: 1.5, note: 'Agents correct.' },
  ],
  what_went_correct: 'Correct agents.',
  needs_attention: 'Electron transfer explanation is thin.',
};

describe('flag calibration mode', () => {
  it('is selected only by an explicit GRADE_CALIBRATION=flag', () => {
    expect(gradingCalibrationMode({ GRADE_CALIBRATION: 'flag' })).toBe('flag');
    expect(gradingCalibrationMode({})).toBe('legacy');
  });

  it('neither bumps nor flags a zero that reads like credit, in flag or legacy mode', () => {
    for (const mode of ['legacy', 'flag']) {
      const grade = normalizeGradeResult(creditZero, question, evidence, 'long_answer', { mode });
      expect(grade.marks).toBe(1.5);
      expect(grade.reviewReasons).not.toContain(IDEA_CREDIT_REVIEW_TAG);
      expect(grade.reviewReasons).not.toContain(PARTIAL_CREDIT_ENFORCED_TAG);
    }
  });

  it('keeps credit without quotes and does not zero Hindi answers as thin', () => {
    const hindiQuestion = { question_text: 'हरिहर काका के चरित्र की विशेषताएँ लिखिए।', marks_total: 3, expected_response_type: 'long_answer' };
    const hindiEvidence = { attempted: true, student_answer: 'हरिहर काका सीधे-सादे, भोले और परिश्रमी व्यक्ति थे। वे अपनी ज़मीन से बहुत प्रेम करते थे।' };
    const raw = { marks_awarded: 2, criteria: [{ id: 'overall', max: 3, marks: 2, note: 'Good traits listed.' }] };
    const strict = normalizeGradeResult(raw, hindiQuestion, hindiEvidence, 'long_answer', { mode: 'strict', subject: 'Hindi' });
    const flag = normalizeGradeResult(raw, hindiQuestion, hindiEvidence, 'long_answer', { mode: 'flag', subject: 'Hindi' });
    expect(strict.reviewReasons).toContain(THIN_ANSWER_TAG);
    expect(flag.marks).toBe(2);
    expect(flag.reviewReasons).not.toContain(THIN_ANSWER_TAG);
  });

  it('uses the normal grading prompt, not the strict quote prompt', () => {
    process.env.GRADE_CALIBRATION = 'flag';
    try {
      const prompt = buildGradePrompt({ question, rubric: { expected_response_type: 'long_answer', marking_rubric: '1.5 marks for justification; 1.5 marks for agents' }, evidence, maxMarks: 3 });
      expect(prompt).not.toContain('evidence_quote');
    } finally { delete process.env.GRADE_CALIBRATION; }
  });
});

describe('flag supervision', () => {
  withEnv({ GRADE_CALIBRATION: 'flag' });

  it('never asks for more marks, even for a credit-reading zero', async () => {
    const calls = [];
    const callJson = async (prompt) => { calls.push(prompt); return { value: creditZero, model: 'grader' }; };
    const result = await gradeWithSupervision({ question, rubric: { expected_response_type: 'long_answer' }, evidence, callJson });
    expect(calls).toHaveLength(1);
    expect(result.grade.marks).toBe(1.5);
    expect(result.supervisor).toMatchObject({ mode: 'flag', enforced: false, action: 'ok' });
  });

  it('keeps a high mark whose own feedback names an error: no subject gets the downward recheck', async () => {
    expect(auditGrade(normalizeGradeResult(lenient, question, evidence, 'long_answer', { mode: 'flag' }), { question, evidence, responseType: 'long_answer', mode: 'flag' }).action).toBe('repair_down');
    const calls = [];
    const callJson = async (prompt) => { calls.push(prompt); return { value: lenient }; };
    const result = await gradeWithSupervision({ question, rubric: { expected_response_type: 'long_answer' }, evidence, subject: 'Chemistry', callJson });
    expect(calls).toHaveLength(1);
    expect(result.grade.marks).toBe(2.5);
    expect(result.grade.reviewReasons).not.toContain(STATED_ERROR_TAG);
    expect(result.supervisor.action).toBe('ok');
  });
});

describe('per-subject calibration (GRADE_CALIBRATION_SUBJECTS)', () => {
  it('applies the mode only to listed subjects, matched in full and case-insensitively', () => {
    const env = { GRADE_CALIBRATION: 'flag', GRADE_CALIBRATION_SUBJECTS: 'Chemistry, physics ,SST' };
    expect(gradingCalibrationModeFor('chemistry', env)).toBe('flag');
    expect(gradingCalibrationModeFor('  Physics ', env)).toBe('flag');
    expect(gradingCalibrationModeFor('SST', env)).toBe('flag');
    expect(gradingCalibrationModeFor('German', env)).toBe('legacy');
    expect(gradingCalibrationModeFor('Physical Education', env)).toBe('legacy');
    expect(gradingCalibrationModeFor('', env)).toBe('legacy');
  });

  it('applies the mode to every subject when the list is empty, and stays legacy without a mode', () => {
    expect(gradingCalibrationModeFor('German', { GRADE_CALIBRATION: 'flag' })).toBe('flag');
    expect(gradingCalibrationModeFor('Chemistry', { GRADE_CALIBRATION_SUBJECTS: 'Chemistry' })).toBe('legacy');
  });

  describe('in supervision', () => {
    withEnv({ GRADE_CALIBRATION: 'flag', GRADE_CALIBRATION_SUBJECTS: 'Chemistry' });

    it('keeps the grader\'s mark for a listed and an unlisted subject alike', async () => {
      const callJson = async () => ({ value: creditZero });
      const rubric = { expected_response_type: 'long_answer' };
      const chemistry = await gradeWithSupervision({ question, rubric, evidence, subject: 'Chemistry', callJson });
      expect(chemistry.grade.marks).toBe(1.5);
      expect(chemistry.supervisor.mode).toBe('flag');

      const german = await gradeWithSupervision({ question, rubric, evidence, subject: 'German', callJson });
      expect(german.grade.marks).toBe(1.5);
      expect(german.supervisor.mode).toBe('legacy');
      expect(german.grade.reviewReasons).not.toContain(PARTIAL_CREDIT_ENFORCED_TAG);
    });

    it('takes the subject from the question when the caller passes none', async () => {
      const callJson = async () => ({ value: creditZero });
      const result = await gradeWithSupervision({ question: { ...question, test_subject: 'Chemistry' }, rubric: { expected_response_type: 'long_answer' }, evidence, callJson });
      expect(result.grade.marks).toBe(1.5);
    });
  });
});

describe('legacy supervision', () => {
  withEnv({ GRADE_CALIBRATION: null });

  it('no longer repairs upward or adds idea credit', async () => {
    const calls = [];
    const callJson = async (prompt) => { calls.push(prompt); return { value: creditZero }; };
    const result = await gradeWithSupervision({ question, rubric: { expected_response_type: 'long_answer' }, evidence, callJson });
    expect(calls).toHaveLength(1);
    expect(result.grade.marks).toBe(1.5);
    expect(result.grade.reviewReasons).not.toContain(PARTIAL_CREDIT_ENFORCED_TAG);
  });

  it('makes no downward recheck either', async () => {
    const calls = [];
    const callJson = async (prompt) => { calls.push(prompt); return { value: lenient }; };
    const result = await gradeWithSupervision({ question, rubric: { expected_response_type: 'long_answer' }, evidence, callJson });
    expect(calls).toHaveLength(1);
    expect(result.supervisor).toMatchObject({ mode: 'legacy', action: 'ok' });
  });
});

describe('callGradeJson', () => {
  const ok = (model) => ({ ok: true, json: async () => ({ model, choices: [{ message: { content: '{"marks_awarded":1}' }, finish_reason: 'stop' }] }) });
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  describe('with GRADE_MODEL set', () => {
    withEnv({ GRADE_MODEL: 'Qwen/Qwen3.8-Flash', DEEPINFRA_API_KEY: 'test-key', DEEPINFRA_REASONING_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash', PHALA_API_KEY: null, DEEPSEEK_API_KEY: null });

    it('grades with the named model', async () => {
      fetchMock.mockResolvedValueOnce(ok('Qwen/Qwen3.8-Flash'));
      const result = await callGradeJson('prompt', 100);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('Qwen/Qwen3.8-Flash');
      expect(result.value).toEqual({ marks_awarded: 1 });
    });

    it('falls back to the reasoning chain when the grading model is rate limited', async () => {
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: { message: 'Rate limit exceeded (429)' } }) })
        .mockResolvedValueOnce(ok('deepseek-ai/DeepSeek-V4.1-Flash'));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = await callGradeJson('prompt', 100);
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
      expect(result.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
    });
  });

  describe('without GRADE_MODEL', () => {
    withEnv({ GRADE_MODEL: null, DEEPINFRA_API_KEY: 'test-key', DEEPINFRA_REASONING_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash', PHALA_API_KEY: null, DEEPSEEK_API_KEY: null });

    it('uses today\'s reasoning model', async () => {
      fetchMock.mockResolvedValueOnce(ok('deepseek-ai/DeepSeek-V4.1-Flash'));
      await callGradeJson('prompt', 100);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('deepseek-ai/DeepSeek-V4.1-Flash');
    });
  });
});
