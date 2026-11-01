import { describe, expect, it, vi } from 'vitest';
import {
  DEEP_SIGNAL_EXTRACTOR_VERSION,
  DEEP_SIGNAL_EXTRACTOR_VERSION_V2,
  buildSignalExtractionPrompt,
  chunkQuestions,
  normalizeExtractedSignals,
  persistSignals,
  questionFromDbRow,
  runDeepSignalExtraction,
  shouldExtractQuestion,
} from '../../apps/processing-worker/deepSignalExtractor.js';

describe('deep signal extraction', () => {
  it('skips MCQ and 1-mark questions', () => {
    expect(shouldExtractQuestion({
      expectedResponseType: 'mcq',
      marksTotal: 4,
      attempted: true,
    })).toBe(false);
    expect(shouldExtractQuestion({
      expectedResponseType: 'long_answer',
      marksTotal: 1,
      attempted: true,
    })).toBe(false);
    expect(shouldExtractQuestion({
      expectedResponseType: 'long_answer',
      marksTotal: 3,
      attempted: true,
    })).toBe(true);
  });

  it('chunks into batches of four by default', () => {
    const questions = Array.from({ length: 9 }, (_, index) => ({ questionNumber: `Q${index + 1}` }));
    expect(chunkQuestions(questions).map((chunk) => chunk.length)).toEqual([4, 4, 1]);
  });

  it('normalizes model output against the source batch', () => {
    const batch = [{
      submissionQuestionId: 'sq_1',
      questionNumber: 'Q3',
      topic: 'Induction',
      marksObtained: 2,
      marksTotal: 4,
    }];
    const signals = normalizeExtractedSignals({
      signals: [{
        question_number: 'Q3',
        concept_tags: ['Faraday'],
        misconception: 'Missed Lenz direction',
        strength: 'Correct flux setup',
        method_note: 'Used dΦ/dt',
        next_practice: 'Drill sign of induced emf',
        confidence: 0.8,
        evidence_refs: ['Q3'],
      }],
    }, batch);
    expect(signals).toEqual([expect.objectContaining({
      submissionQuestionId: 'sq_1',
      questionNumber: 'Q3',
      misconception: 'Missed Lenz direction',
      confidence: 0.8,
    })]);
  });

  it('builds an evidence-bound prompt', () => {
    const prompt = buildSignalExtractionPrompt([{
      questionNumber: 'Q2',
      topic: 'Electrostatics',
      marksObtained: 1,
      marksTotal: 3,
      questionText: 'Define potential',
      markingRubric: '1 for definition',
      studentAnswer: 'Work done per unit charge',
      whatWentCorrect: 'Definition present',
      missingOrWrong: 'No unit',
      gradingReason: 'Partial',
      nextStep: 'Add unit',
    }], { school: 'PartnerE', subject: 'Physics' });
    expect(prompt).toContain('PartnerE');
    expect(prompt).toContain('Work done per unit charge');
    expect(prompt).toContain('evidence-bound');
  });

  it('maps DB rows and persists upsert statements', async () => {
    const row = questionFromDbRow({
      id: 'sq_9',
      question_number: 'Q9',
      question_text: 'Explain',
      answer_key_text: 'key',
      rubric_json: JSON.stringify({ topic: 'Waves', expected_response_type: 'long_answer', marking_rubric: '2 marks' }),
      evidence_json: JSON.stringify({ attempted: true, student_answer: 'answer' }),
      payload_json: JSON.stringify({ gradeRationale: { whatWentCorrect: 'ok', missingOrWrong: 'gap', reasoning: 'why', nextStep: 'do' } }),
      approved_marks: 1,
      marks_total: 3,
    });
    expect(row.submissionQuestionId).toBe('sq_9');
    expect(shouldExtractQuestion(row)).toBe(true);

    const batch = vi.fn().mockResolvedValue({});
    const db = { batch };
    const written = await persistSignals(db, {
      schoolId: 'school_1',
      studentId: 'student_1',
      submissionId: 'sub_1',
      examId: 'exam_1',
      model: 'deepseek-chat',
      signals: [{
        submissionQuestionId: 'sq_9',
        questionNumber: 'Q9',
        topic: 'Waves',
        marksObtained: 1,
        marksTotal: 3,
        conceptTags: ['wave'],
        misconception: 'gap',
        strength: 'ok',
        methodNote: null,
        nextPractice: 'do',
        confidence: 0.5,
        evidenceRefs: ['Q9'],
        raw: {},
      }],
    });
    expect(written).toBe(1);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][0][0].sql).toContain('INSERT INTO evidence_signals');
  });

  it('stamps v2 rows with KC/misconception columns and the v2 extractor version', async () => {
    const batch = vi.fn().mockResolvedValue({});
    const db = { batch };
    const base = {
      submissionQuestionId: 'sq_9',
      questionNumber: 'Q9',
      topic: 'Algebra',
      marksObtained: 1,
      marksTotal: 3,
      misconception: 'dropped a minus',
      strength: null,
      methodNote: null,
      nextPractice: null,
      confidence: 0.9,
      evidenceRefs: ['Q9'],
      raw: {},
    };
    await persistSignals(db, {
      schoolId: 'school_1',
      studentId: 'student_1',
      submissionId: 'sub_1',
      examId: 'exam_1',
      model: 'deepseek-chat',
      signals: [
        { ...base, conceptTags: ['kc_a'], misconceptionClass: 'sign-error' }, // v2
        { ...base, conceptTags: ['algebra'] }, // v1 (no misconceptionClass key)
      ],
    });
    const [v2Op, v1Op] = batch.mock.calls[0][0];
    expect(v2Op.sql).toContain('kc_ids_json, misconception_class');
    expect(v2Op.args).toContain('["kc_a"]');
    expect(v2Op.args).toContain('sign-error');
    expect(v2Op.args).toContain(DEEP_SIGNAL_EXTRACTOR_VERSION_V2);
    expect(v1Op.sql).not.toContain('kc_ids_json');
    expect(v1Op.args).toContain(DEEP_SIGNAL_EXTRACTOR_VERSION);
    expect(v1Op.args).not.toContain(DEEP_SIGNAL_EXTRACTOR_VERSION_V2);
  });

  it('falls back to v1 extraction when allowlist resolution throws', async () => {
    const questionRows = [{
      id: 'sq_2',
      question_number: 'Q2',
      question_text: 'Long form',
      answer_key_text: 'key',
      rubric_json: JSON.stringify({ topic: 'Optics', expected_response_type: 'long_answer' }),
      evidence_json: JSON.stringify({ attempted: true, student_answer: 'rays bend' }),
      payload_json: JSON.stringify({ gradeRationale: {} }),
      approved_marks: 2,
      marks_total: 4,
    }];
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: questionRows }) // loadExtractableQuestions
        .mockRejectedValueOnce(new Error('knowledge_components table missing')), // resolveExamMeta
      batch: vi.fn().mockResolvedValue({}),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await runDeepSignalExtraction(db, {
        submissionId: 'sub_1',
        schoolId: 'school_1',
        studentId: 'student_1',
        examId: 'exam_1',
        school: 'Demo',
        subject: 'Physics',
        callModel: async () => ({
          model: 'flash',
          signals: [{
            submissionQuestionId: 'sq_2',
            questionNumber: 'Q2',
            topic: 'Optics',
            marksObtained: 2,
            marksTotal: 4,
            conceptTags: ['refraction'],
            misconception: 'diagram',
            strength: null,
            methodNote: null,
            nextPractice: null,
            confidence: 0.7,
            evidenceRefs: ['Q2'],
            raw: {},
          }],
        }),
      });
      expect(result).toEqual(expect.objectContaining({ extracted: 1, skipped: false }));
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain('deep_signal_allowlist_resolution_failed');
    } finally {
      warn.mockRestore();
    }
  });

  it('runs extraction end-to-end with an injected model caller', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [{
          id: 'sq_2',
          question_number: 'Q2',
          question_text: 'Long form',
          answer_key_text: 'key',
          rubric_json: JSON.stringify({ topic: 'Optics', expected_response_type: 'long_answer' }),
          evidence_json: JSON.stringify({ attempted: true, student_answer: 'rays bend' }),
          payload_json: JSON.stringify({ gradeRationale: { whatWentCorrect: 'idea', missingOrWrong: 'diagram', reasoning: 'partial', nextStep: 'draw' } }),
          approved_marks: 2,
          marks_total: 4,
        }],
      }),
      batch: vi.fn().mockResolvedValue({}),
    };

    const result = await runDeepSignalExtraction(db, {
      submissionId: 'sub_1',
      schoolId: 'school_1',
      studentId: 'student_1',
      examId: 'exam_1',
      school: 'Demo',
      subject: 'Physics',
      callModel: async () => ({
        model: 'flash',
        signals: [{
          submissionQuestionId: 'sq_2',
          questionNumber: 'Q2',
          topic: 'Optics',
          marksObtained: 2,
          marksTotal: 4,
          conceptTags: ['refraction'],
          misconception: 'diagram',
          strength: 'idea',
          methodNote: null,
          nextPractice: 'draw',
          confidence: 0.7,
          evidenceRefs: ['Q2'],
          raw: {},
        }],
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      extracted: 1,
      skipped: false,
      questionCount: 1,
      batchCount: 1,
      model: 'flash',
    }));
  });
});
