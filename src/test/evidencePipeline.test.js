import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import {
  buildExtractionPrompt,
  cleanOcrText,
  classifyExam,
  parseNumberedWrittenAnswersFromOcr,
  shouldUseMarkers,
} from '../../apps/processing-worker/evidencePipeline.js';

describe('shouldUseMarkers (FLKRM-156)', () => {
  it('returns true for Physics even when fewer than 50% of questions contain math keywords', () => {
    // The exact bug case: a physics paper with a mix of numeric and theory questions
    // can fall under the old >50% keyword-density threshold and be mis-routed.
    const questions = [
      { number: 'Q1', question_text: 'State Newton\'s first law of motion.', marks_allocated: 2, expected_response_type: 'short_answer' },
      { number: 'Q2', question_text: 'Define electric current and its SI unit.', marks_allocated: 2, expected_response_type: 'short_answer' },
      { number: 'Q3', question_text: 'Explain the working of a transformer.', marks_allocated: 3, expected_response_type: 'long_answer' },
      { number: 'Q4', question_text: 'What is the difference between speed and velocity?', marks_allocated: 3, expected_response_type: 'long_answer' },
      { number: 'Q5', question_text: 'Compute the value of cos(60°) + sin(30°).', marks_allocated: 2, expected_response_type: 'numerical' },
      { number: 'Q6', question_text: 'Differentiate y = tan(x) with respect to x.', marks_allocated: 2, expected_response_type: 'proof' },
    ];
    // Only 2 of the 6 question texts contain math keywords — previously < 50%, so it
    // would NOT have been routed to the marker prompt. Subject must override this.
    expect(shouldUseMarkers(questions, 'Physics')).toBe(true);
  });

  it('returns true for a maths paper where every question contains cos', () => {
    const questions = Array.from({ length: 4 }, (_, i) => ({
      number: `Q${i + 1}`,
      question_text: `Prove: cos^2(x) + sin^2(x) = 1 for angle ${i + 1}`,
      marks_allocated: 2,
      expected_response_type: 'proof',
    }));
    expect(shouldUseMarkers(questions, 'Mathematics')).toBe(true);
  });

  it('returns true for Mathematics regardless of subject casing', () => {
    expect(shouldUseMarkers([{ number: 'Q1', question_text: 'Add 2+2', expected_response_type: 'numerical' }], 'mathematics')).toBe(true);
    expect(shouldUseMarkers([{ number: 'Q1', question_text: 'Add 2+2', expected_response_type: 'numerical' }], 'Applied Maths')).toBe(true);
  });

  it('excludes all-MCQ papers from marker mode', () => {
    const mcq = [{ number: 'Q1', question_text: 'cos(0) = ?', marks_allocated: 1, expected_response_type: 'mcq' }];
    expect(shouldUseMarkers(mcq, 'Physics')).toBe(false);
  });

  it('falls back to keyword density for untagged subjects', () => {
    // Unknown subject but highly math-heavy content -> markers
    const heavy = [{ number: 'Q1', question_text: 'Integrate cos(x)', expected_response_type: 'long_answer' }, { number: 'Q2', question_text: 'Find integral of tan', expected_response_type: 'long_answer' }];
    expect(shouldUseMarkers(heavy, '')).toBe(true);
    // Unknown subject, no math keywords -> keyword mode
    const theory = [{ number: 'Q1', question_text: 'Describe photosynthesis', expected_response_type: 'long_answer' }];
    expect(shouldUseMarkers(theory, '')).toBe(false);
  });

  it('returns false for empty questions', () => {
    expect(shouldUseMarkers([], 'Physics')).toBe(false);
  });
});

describe('buildExtractionPrompt routing (FLKRM-156)', () => {
  it('uses the marker-based MATH prompt for a Physics paper regardless of keyword density', () => {
    const questions = [
      { number: 'Q1', question_text: 'State Ohm\'s law.', marks_allocated: 2, expected_response_type: 'short_answer' },
      { number: 'Q2', question_text: 'Define resistance and conductance.', marks_allocated: 2, expected_response_type: 'short_answer' },
      { number: 'Q3', question_text: 'Explain Faraday\'s law of induction.', marks_allocated: 3, expected_response_type: 'long_answer' },
      { number: 'Q4', question_text: 'Compute tan(45°) if applicable.', marks_allocated: 2, expected_response_type: 'numerical' },
    ];
    const classification = classifyExam(questions);
    const prompt = buildExtractionPrompt({ questions, label: 'all' }, 'Q1 Electron flow\nQ2 R = V/I\nQ3 EMF detected\nQ4 tan45=1', classification, 'Physics');
    // Must be the marker (TRUST student Q-markers) prompt, not the keyword prompt.
    expect(prompt).toContain('TRUST student question markers');
    expect(prompt).not.toContain('Match ONLY by content keywords');
  });

  it('uses the keyword prompt for a non-marker subject without math-heavy content', () => {
    const questions = [
      { number: 'Q1', question_text: 'Describe the water cycle.', marks_allocated: 2, expected_response_type: 'long_answer' },
    ];
    const classification = classifyExam(questions);
    const prompt = buildExtractionPrompt({ questions, label: 'all' }, 'Evaporation and condensation', classification, 'Biology');
    expect(prompt).toContain('Match ONLY by content keywords');
    expect(prompt).not.toContain('TRUST student question markers');
  });
});

describe('cleanOcrText marker preservation (FLKRM-156)', () => {
  // These are the marker forms the issue is about: a lone "Q1" line (OCR section
  // header) and a "Q2" appearing as a pipe-cell. cleanOcrText strips both by default,
  // which destroys the Q-markers the marker-based prompt needs on math/physics papers.
  const ocr = 'Q1\nx^2 + y^2 = z^2\nQ2 | 5 + 5\n--- page 2 ---';

  it('strips question markers by default (existing behavior)', () => {
    const cleaned = cleanOcrText(ocr);
    expect(cleaned).not.toContain('Q1');
    expect(cleaned).not.toContain('Q2');
  });

  it('preserves question markers when preserveMarkers is true', () => {
    const cleaned = cleanOcrText(ocr, { preserveMarkers: true });
    expect(cleaned).toContain('Q1');
    expect(cleaned).toContain('Q2');
    // Non-marker noise (page markers) is still removed.
    expect(cleaned).not.toContain('--- page 2 ---');
  });
});

describe('classifyQuestionType honors written 1-mark items', () => {
  it('does not treat short_answer 1-mark questions as MCQ', () => {
    const questions = Array.from({ length: 12 }, (_, i) => ({
      number: `Q${i + 1}`,
      question_text: 'Verbinden Sie mit weil.',
      marks_allocated: 1,
      expected_response_type: 'short_answer',
    }));
    const classification = classifyExam(questions);
    expect(classification.allMcq).toBe(false);
    expect(classification.mcqCount).toBe(0);
    const prompt = buildExtractionPrompt({ questions, label: 'teil1' }, 'Teil 1\nA\n1) Ich bleibe heute zu Hause, weil ich krank bin.', classification, 'German');
    expect(prompt).not.toContain('ALL-MCQ');
    expect(prompt).toContain('identify 2-3 KEYWORDS');
  });
});

describe('parseNumberedWrittenAnswersFromOcr', () => {
  it('recovers German weil/dass sentences and ignores Teil A/B headers', () => {
    const ocr = `# Teil 1\nA\n1) Ich bleibe heute zu Hause, weil ich krank bin\n2) Lara lernt Deutsch, weil sie in Deutschland arbeiten möchte\nB\n- 13) 7) Ich glaube, dass er heute keine Zeit hat.\n8. Meine Lehrerin sagt, dass die Prüfung um 9 Uhr beginnt.`;
    const parsed = parseNumberedWrittenAnswersFromOcr(ocr);
    expect(parsed.get('1')).toContain('weil ich krank bin');
    expect(parsed.get('2')).toContain('Lara lernt Deutsch');
    expect(parsed.get('7')).toContain('Ich glaube');
    expect(parsed.get('8')).toContain('Meine Lehrerin sagt');
    expect(parsed.get('13')).toBeUndefined();
  });

  it('parses circled numbers and unnumbered Q12 continuations', () => {
    const ocr = `- A. ① Ich bleibe zu Hause, weil ich krank bin.\n⑦ Ich glaube, dass er heute keine Zeit hat.\n- 11) Er meint, dass der Kurs interessant ist\nsie findet es gut, dass wir zusammen lernen\n- ④⑧ sie werde am wochenende ihre Freunde besuchen`;
    const parsed = parseNumberedWrittenAnswersFromOcr(ocr);
    expect(parsed.get('1')).toContain('weil ich krank bin');
    expect(parsed.get('7')).toContain('Ich glaube');
    expect(parsed.get('8')).toBeUndefined();
    expect(parsed.get('11')).toContain('Er meint');
    expect(parsed.get('12')).toContain('zusammen lernen');
    expect(parsed.get('48')).toContain('wochenende');
  });
});

describe('evidence extraction calls (processEvidence → extractStudentAnswers)', () => {
  // FLKRM-156: every extraction prompt (first pass, supervisor retry, presence
  // gap-fill retry) must get the paper subject, or math/physics papers fall
  // back to keyword matching on that pass.
  it('passes the subject to every buildExtractionPrompt call', () => {
    const source = readFileSync(resolve(process.cwd(), 'apps/processing-worker/evidenceExtract.js'), 'utf8');
    const calls = source.match(/buildExtractionPrompt\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) expect(call).toMatch(/,\s*subject\)$/);
  });
});

