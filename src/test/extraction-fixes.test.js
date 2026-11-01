// Phase 3 extraction fixes: each block pins one reading bug found in the review.
/* global process */
import { describe, expect, it } from 'vitest';
import { cleanOcrText, dropBookletPageNumbers, overlayLetterOnlyAnswersFromNumberedOcr } from '../../apps/processing-worker/evidencePipeline.js';

const answer = (number, studentAnswer, type = 'short_answer') => ({ question: { number, expected_response_type: type }, studentAnswer, attempted: Boolean(studentAnswer), confidence: 'medium' });

describe('numbered-answer overlay', () => {
  const ocr = '1) Photosynthesis needs:\n2) light\n3) water and carbon dioxide';

  it('never fills a blank question from a numbered sub-point', () => {
    const out = overlayLetterOnlyAnswersFromNumberedOcr([
      answer('Q1', 'Photosynthesis needs: 2) light 3) water and carbon dioxide'),
      answer('Q3', ''),
    ], ocr);
    expect(out[1].studentAnswer).toBe('');
    expect(out[1].attempted).toBe(false);
  });

  it('still repairs a written answer collapsed to a section letter', () => {
    const out = overlayLetterOnlyAnswersFromNumberedOcr([answer('Q7', 'B')], '7. Ich glaube, dass er morgen kommt.');
    expect(out[0]).toMatchObject({ studentAnswer: 'Ich glaube, dass er morgen kommt.', attempted: true });
  });

  it('keeps an MCQ letter, and never reuses text that belongs to another answer', () => {
    expect(overlayLetterOnlyAnswersFromNumberedOcr([answer('Q2', 'C', 'mcq')], '2) the second option').at(0).studentAnswer).toBe('C');
    const out = overlayLetterOnlyAnswersFromNumberedOcr([
      answer('Q1', 'water and carbon dioxide are needed'),
      answer('Q3', 'A'),
    ], '3) water and carbon dioxide');
    expect(out[1].studentAnswer).toBe('A');
  });
});

describe('bare numbers in OCR cleaning', () => {
  it('keeps a final answer that is just a number', () => {
    const cleaned = cleanOcrText('Area = l x b = 12 x 10\n120\n\nv = 3.14 x 2\n6.28');
    expect(cleaned.split('\n')).toEqual(expect.arrayContaining(['120', '6.28']));
  });

  it('drops printed booklet page numbers that continue across pages', () => {
    const raw = ['[asset:a1]', '--- page 1 ---', '2', 'Q1 answer text', 'More working', '--- page 2 ---', '3', 'Q2 answer text', '45'].join('\n');
    const lines = dropBookletPageNumbers(raw).split('\n');
    expect(lines).not.toContain('2');
    expect(lines).not.toContain('3');
    expect(lines).toContain('45');
  });

  it('keeps a lone number at a page edge with no neighbouring page number', () => {
    const raw = ['--- page 1 ---', 'Total marks scored', '120'].join('\n');
    expect(dropBookletPageNumbers(raw).split('\n')).toContain('120');
  });

  it('still drops header fragments', () => {
    expect(cleanOcrText('Q.No. 5. No.\nAnswer text')).toBe('Answer text');
  });
});

describe('strike-through', () => {
  it('keeps OCR strike tags through cleaning, tables included, as ~~…~~', () => {
    expect(cleanOcrText('x = <del>5</del> 7')).toBe('x = ~~5~~ 7');
    expect(cleanOcrText('<table><tr><td><s>wrong unit</s> m/s</td></tr></table>')).toContain('~~wrong unit~~');
  });

  it('moves struck text out of the graded answer into crossed_out_work', async () => {
    const { normalizeEvidenceAnswers, splitStruckText } = await import('../../apps/processing-worker/evidenceAnswers.js');
    expect(splitStruckText('v = ~~2.5~~ 3 m/s')).toEqual({ kept: 'v = 3 m/s', struck: '2.5' });
    const [q1] = normalizeEvidenceAnswers({ answers: [{ question_number: 'Q1', attempted: true, confidence: 'high', student_answer: 'Speed = ~~d x t~~ d / t = 3 m/s', crossed_out_work: 'old working' }] }, { questions: [{ number: 'Q1' }] });
    expect(q1.studentAnswer).toBe('Speed = d / t = 3 m/s');
    expect(q1.crossedOutWork).toBe('old working\nd x t');
  });

  it('leaves an answer with no strike markup unchanged', async () => {
    const { splitStruckText } = await import('../../apps/processing-worker/evidenceAnswers.js');
    expect(splitStruckText('Ich glaube, dass er kommt.')).toEqual({ kept: 'Ich glaube, dass er kommt.', struck: '' });
  });
});

describe('no double credit', () => {
  it('finds a Hindi answer extracted under two questions', async () => {
    const { findDuplicateAnswers } = await import('../../shared/gradingCalibration.js');
    const hindi = 'हरिहर काका सीधे-सादे, भोले और परिश्रमी व्यक्ति थे।';
    const duplicates = findDuplicateAnswers([
      { questionNumber: 'Q4', questionText: 'हरिहर काका के चरित्र की विशेषताएँ लिखिए।', studentAnswer: hindi },
      { questionNumber: 'Q5', questionText: 'ठाकुरबारी का वर्णन कीजिए।', studentAnswer: hindi },
    ]);
    expect([...duplicates]).toEqual([['Q5', 'Q4']]);
  });

  it('zeroes the duplicate in legacy and flag modes too', async () => {
    const { normalizeGradeResult } = await import('../../apps/processing-worker/gradeResult.js');
    const question = { question_text: 'Explain osmosis.', marks_total: 3, expected_response_type: 'long_answer' };
    const evidence = { attempted: true, student_answer: 'Water moves across a membrane from low to high solute concentration.', duplicate_of: 'Q2' };
    const raw = { marks_awarded: 2, criteria: [{ id: 'overall', max: 3, marks: 2, note: 'Correct idea.' }] };
    for (const mode of ['legacy', 'flag']) {
      const grade = normalizeGradeResult(raw, question, evidence, 'long_answer', { mode });
      expect(grade.marks).toBe(0);
      expect(grade.reviewReasons).toContain('duplicate_evidence');
    }
    expect(normalizeGradeResult(raw, question, { ...evidence, duplicate_of: undefined }, 'long_answer', { mode: 'legacy' }).marks).toBe(2);
  });
});

describe('duplicate answers under legacy supervision', () => {
  it('stays at zero: no idea-credit bump, clamp or harsh-zero tag', async () => {
    const { gradeWithSupervision } = await import('../../apps/processing-worker/gradeSupervisor.js');
    const prior = process.env.GRADE_CALIBRATION;
    delete process.env.GRADE_CALIBRATION;
    try {
      const question = { question_text: 'Explain osmosis.', marks_total: 3, expected_response_type: 'long_answer' };
      const evidence = { attempted: true, student_answer: 'Water moves across a membrane from low to high solute concentration.', duplicate_of: 'Q2' };
      const callJson = async () => ({ value: { marks_awarded: 2, criteria: [{ id: 'overall', max: 3, marks: 2, note: 'Student correctly explained water movement.' }] } });
      const result = await gradeWithSupervision({ question, rubric: { expected_response_type: 'long_answer' }, evidence, callJson });
      expect(result.grade.marks).toBe(0);
      expect(result.grade.reviewReasons).toEqual(['duplicate_evidence']);
      expect(result.supervisor.action).toBe('ok');
    } finally {
      if (prior === undefined) delete process.env.GRADE_CALIBRATION; else process.env.GRADE_CALIBRATION = prior;
    }
  });
});

describe('answer-sheet pages', () => {
  it('orders pages the same way for extraction and review: batch, then page number', async () => {
    const { sortAnswerSheetRows } = await import('../../apps/processing-worker/ocrText.js');
    const { indexIntakeAnswerSheetAssets } = await import('../../api/_lib/answerSheetAssets.js');
    const rows = [
      { asset_id: 'b2p1', storage_key: 'Asha-page-2000-1.jpg' },
      { asset_id: 'b1p2', storage_key: 'Asha-page-1000-2.jpg' },
      { asset_id: 'b1p1', storage_key: 'Asha-page-1000-1.jpg' },
      { asset_id: 'legacy', storage_key: 'scan.jpg' },
    ];
    const order = ['b1p1', 'b1p2', 'b2p1', 'legacy'];
    expect(sortAnswerSheetRows(rows).map((row) => row.asset_id)).toEqual(order);
    expect(indexIntakeAnswerSheetAssets(rows).map((row) => row.asset_id)).toEqual(order);
  });

  it('drops a page uploaded twice, keeping the first, and never compares near-blank pages', async () => {
    const { dropDuplicatePages } = await import('../../apps/processing-worker/ocrText.js');
    const body = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const rows = [
      { asset_id: 'p1', is_active: 1, markdown: `Q1 answer ${body}` },
      { asset_id: 'p2', is_active: 1, markdown: `Q2 a different answer about osmosis and membranes ${Array.from({ length: 40 }, (_, i) => `other${i}`).join(' ')}` },
      { asset_id: 'p1-again', is_active: 1, markdown: `Q1 answer ${body} smudge` },
      { asset_id: 'p1-again', is_active: 0, markdown: 'older OCR run' },
      { asset_id: 'blank1', is_active: 1, markdown: 'Rough work' },
      { asset_id: 'blank2', is_active: 1, markdown: 'Rough work' },
    ];
    const { rows: kept, duplicateAssetIds } = dropDuplicatePages(rows);
    expect(duplicateAssetIds).toEqual(['p1-again']);
    expect(kept.map((row) => row.asset_id)).toEqual(['p1', 'p2', 'blank1', 'blank2']);
  });
});

describe('verbatim check', () => {
  it('accepts an answer copied from the OCR and rejects one the model rewrote', async () => {
    const { answerFoundInOcr } = await import('../../apps/processing-worker/evidenceAnswers.js');
    const ocr = 'Ich habe gestern meinen Freund besuchen und wir spielen Fussball im Park.';
    expect(answerFoundInOcr('Ich habe gestern meinen Freund besuchen und wir spielen Fussball', ocr)).toBe(true);
    // The model "corrected" the student's German: besucht / haben gespielt.
    expect(answerFoundInOcr('Ich habe gestern meinen Freund besucht und wir haben im Park Fußball gespielt', ocr)).toBe(false);
    expect(answerFoundInOcr('B', ocr)).toBe(true);
    expect(answerFoundInOcr('हरिहर काका सीधे-सादे और भोले व्यक्ति थे', 'हरिहर काका सीधे-सादे और भोले व्यक्ति थे। वे परिश्रमी थे।')).toBe(true);
  });

  it('marks a rewritten answer low-confidence during extraction', async () => {
    const { extractStudentAnswers } = await import('../../apps/processing-worker/evidenceExtract.js');
    const { EvidenceSupervisor } = await import('../../apps/processing-worker/evidenceSupervisor.js');
    const rubric = { questions: [{ id: 'q1', number: 'Q1', question_text: 'Describe your weekend.', expected_response_type: 'long_answer', marks_allocated: 4 }] };
    const assets = [{ asset_id: 'a1', storage_key: 'x-page-1-1.jpg', is_active: 1, markdown: 'Ich habe gestern meinen Freund besuchen und wir spielen Fussball im Park.' }];
    const callJson = async () => ({ value: { answers: [{ question_number: 'Q1', attempted: true, confidence: 'high', student_answer: 'Ich habe gestern meinen Freund besucht und wir haben im Park Fußball gespielt' }] } });
    const log = console.log; console.log = () => {};
    try {
      const { answers } = await extractStudentAnswers({ assets, rubric, subject: 'German', supervisor: new EvidenceSupervisor(rubric.questions), callJson });
      expect(answers[0]).toMatchObject({ confidence: 'low', notVerbatim: true, attempted: true });
    } finally { console.log = log; }
  });
});

describe('unclear maths answers', () => {
  it('detects symbol-heavy answers in maths, physics and chemistry only', async () => {
    const { isSymbolHeavyAnswer } = await import('../../shared/gradingCalibration.js');
    expect(isSymbolHeavyAnswer('v = u + at = 0 + 9.8 x 3 = 29.4 m/s', 'Physics')).toBe(true);
    expect(isSymbolHeavyAnswer('2H2 + O2 -> 2H2O', 'Chemistry')).toBe(true);
    expect(isSymbolHeavyAnswer('v = u + at = 29.4', 'History')).toBe(false);
    expect(isSymbolHeavyAnswer('Newton stated that every action has an equal and opposite reaction.', 'Physics')).toBe(false);
  });

  it('tags a low-confidence symbol-heavy answer for the top of the queue', async () => {
    const { normalizeGradeResult } = await import('../../apps/processing-worker/gradeResult.js');
    const question = { question_text: 'Find v.', marks_total: 3, expected_response_type: 'numerical', test_subject: 'Physics' };
    const raw = { marks_awarded: 1, criteria: [] };
    const low = normalizeGradeResult(raw, question, { attempted: true, student_answer: 'v = u + at = 0 + 9.8 x 3 = 29.4', extraction_confidence: 'low' }, 'numerical', { subject: 'Physics' });
    expect(low.reviewReasons).toEqual(expect.arrayContaining(['low_extraction_confidence', 'symbol_answer_unclear']));
    const clear = normalizeGradeResult(raw, question, { attempted: true, student_answer: 'v = u + at = 0 + 9.8 x 3 = 29.4', extraction_confidence: 'high' }, 'numerical', { subject: 'Physics' });
    expect(clear.reviewReasons).not.toContain('symbol_answer_unclear');
  });

  it('ranks a student with an unclear maths answer first in the roster', async () => {
    const { filterAndSortStudents } = await import('../components/StudentRoster.jsx');
    const students = [
      { studentId: 'a', name: 'A', flaggedCount: 5, pending: 10 },
      { studentId: 'b', name: 'B', flaggedCount: 1, urgentCount: 1, pending: 2 },
    ];
    expect(filterAndSortStudents(students).map((s) => s.studentId)).toEqual(['b', 'a']);
  });
});
