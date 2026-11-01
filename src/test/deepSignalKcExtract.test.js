// src/test/deepSignalKcExtract.test.js
import { describe, it, expect } from 'vitest';
import { buildSignalExtractionPromptV2, normalizeExtractedSignalsV2 } from '../../apps/processing-worker/deepSignalExtractor.js';

const allowlist = { byId: { kc_a: { label: 'Quadratic formula', slug: 'quad_formula', cognitive: 'apply' } }, validIds: new Set(['kc_a']) };

const batch = [{
  submissionQuestionId: 'sq1', questionNumber: '4', topic: 'Quadratic Equations',
  marksObtained: 2, marksTotal: 4, questionText: 'Solve x^2-5x+6=0',
  markingRubric: 'factor', studentAnswer: 'x=2,3', whatWentCorrect: 'factored', missingOrWrong: '', gradingReason: '', nextStep: '',
}];

describe('extractor v2', () => {
  it('embeds the KC allowlist in the prompt', () => {
    const prompt = buildSignalExtractionPromptV2(batch, { subject: 'Mathematics', studentName: 'A' }, allowlist);
    expect(prompt).toContain('kc_a');
    expect(prompt).toContain('Quadratic formula');
  });

  it('normalises kc_ids to valid allowlist ids and misconception to the enum', () => {
    const result = { signals: [{ question_number: '4', kc_ids: ['kc_a', 'kc_x'], misconception: 'forgot the minus sign', strength: 'ok', confidence: 0.8, evidence_refs: ['4'] }] };
    const out = normalizeExtractedSignalsV2(result, batch, allowlist, 'Mathematics');
    expect(out[0].conceptTags).toEqual(['kc_a']); // kc_x dropped (not in allowlist)
    expect(out[0].misconceptionClass).toBe('sign-error'); // normalised
    expect(out[0].confidence).toBe(0.8);
  });
});
