import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { ocrWithDatalab } from '../../apps/processing-worker/datalabOcr.js';
import { buildGradePrompt, normalizeGradeResult } from '../../apps/processing-worker/gradeResult.js';
import { reviewFlagsFor } from '../../shared/reviewFlags.js';
import { hasUnreadRegion, markUnreadRegions, UNREAD_REGION_MARKER, UNREAD_REGION_TAG } from '../../shared/unreadRegion.js';

// Avani's Chemistry Q1 (12th, 4 Oct): the two order lines came back from Datalab
// as Figure blocks with no text, so the grader saw only the headings.
const DATALAB_MARKDOWN = [
  'Q1) The correct arrangement of order is',
  'i) Increasing order of C-X bond strength',
  '![](e03baac34192e6065708e819701aec86_img.jpg)',
  'ii) Increasing order of leaving - group ability',
  '![](8ade5023bc4ef0dde1b8b912f7d8ac0a_img.jpg)',
].join('\n\n');

describe('unread OCR regions', () => {
  it('replaces each image left by OCR with the marker, in place', () => {
    const marked = markUnreadRegions(DATALAB_MARKDOWN);
    expect(marked).not.toContain('_img.jpg');
    expect(marked.split(UNREAD_REGION_MARKER)).toHaveLength(3);
    expect(marked).toContain(`bond strength\n\n${UNREAD_REGION_MARKER}\n\nii)`);
    expect(hasUnreadRegion(marked)).toBe(true);
    expect(hasUnreadRegion('CH3I < CH3Br < CH3Cl < CH3F')).toBe(false);
  });

  it('asks Datalab to keep image regions and marks them in the markdown and pages', async () => {
    let form;
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).endsWith('/convert')) {
        form = init.body;
        return { ok: true, status: 200, json: async () => ({ request_id: 'req_1', request_check_url: 'https://www.datalab.to/api/v1/convert/req_1' }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'complete', markdown: DATALAB_MARKDOWN, pages: [{ index: 0, markdown: DATALAB_MARKDOWN }], images: { 'e03baac34192e6065708e819701aec86_img.jpg': 'base64…' }, page_count: 1 }) };
    });
    const result = await ocrWithDatalab({ buffer: Buffer.from('jpg'), filename: 'page.jpg', mimeType: 'image/jpeg', apiKey: 'key', fetchImpl, pollMs: 0, wait: (fn) => fn() });
    expect(form.get('disable_image_extraction')).toBe('false');
    expect(hasUnreadRegion(result.markdown)).toBe(true);
    expect(hasUnreadRegion(result.pages[0].markdown)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('base64');
  });

  it('flags the question and tells the grader not to call the unread part missing', () => {
    const evidence = { attempted: true, student_answer: markUnreadRegions(DATALAB_MARKDOWN) };
    const prompt = buildGradePrompt({
      question: { question_text: 'Arrange CH3Cl, CH3Br, CH3I and CH3F in increasing order of C–X bond strength and leaving-group ability.', marks_total: 4 },
      rubric: { expected_response_type: 'short_answer', marking_rubric: '1 mark for the bond-strength order. 1 mark for the leaving-group order.' },
      evidence,
      maxMarks: 4,
      subject: 'Chemistry',
    });
    expect(prompt).toContain(`contains ${UNREAD_REGION_MARKER}`);
    expect(prompt).toMatch(/Do not call content missing or wrong/);

    const grade = normalizeGradeResult(
      { marks_awarded: 0, confidence: 'medium', what_went_correct: '', needs_attention: 'Part of the answer could not be read.', grading_reasoning: 'Orders not readable.' },
      { marks_total: 4 },
      evidence,
      'short_answer',
      { markingRubric: '1 mark for the bond-strength order. 1 mark for the leaving-group order.' },
    );
    expect(grade.needsReview).toBe(true);
    expect(grade.reviewReasons).toContain(UNREAD_REGION_TAG);
  });

  it('leaves answers without unread regions alone', () => {
    const prompt = buildGradePrompt({
      question: { question_text: 'Q', marks_total: 2 },
      rubric: { expected_response_type: 'short_answer', marking_rubric: '2 marks for X.' },
      evidence: { attempted: true, student_answer: 'CH3I < CH3Br < CH3Cl < CH3F' },
      maxMarks: 2,
    });
    expect(prompt).not.toContain(UNREAD_REGION_MARKER);
  });

  it('shows teachers a plain-English flag', () => {
    expect(reviewFlagsFor({ reviewTags: [UNREAD_REGION_TAG] })).toEqual([
      expect.objectContaining({ label: 'Part of answer unreadable', tone: 'critical' }),
    ]);
  });
});
