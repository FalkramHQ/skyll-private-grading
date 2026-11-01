import { describe, expect, it } from 'vitest';
import {
  buildVisualRescuePrompt,
  dedupeAssetsPreserveOrder,
  extractQuestionLabels,
  isReviewerTouchedQuestion,
  markdownMentionsQuestion,
  rankVisualPages,
  validateVisualRescueDescription,
  visualAnswerAnchor,
} from '../../apps/processing-worker/visualRescue.js';

describe('visualRescue targeting', () => {
  it('dedupes asset ids while preserving order', () => {
    expect(dedupeAssetsPreserveOrder(['a', 'a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('detects question labels in OCR markdown', () => {
    expect(markdownMentionsQuestion('Q.8)\nIUPAC', 'Q8')).toBe(true);
    expect(markdownMentionsQuestion('Q.2\nRosenmund', 'Q8')).toBe(false);
    expect(extractQuestionLabels('Q.1) foo\nQ.2 bar\nQ. 9)')).toEqual([1, 2, 9]);
  });

  it('prefers the page whose OCR mentions the target question', () => {
    const ranked = rankVisualPages({
      orderedAssetIds: ['p0', 'p0', 'p1', 'p1', 'p2'],
      sourcePages: [0],
      questionNumber: 'Q8',
      pageMarkdownByAssetId: {
        p0: 'Q.1) mcq\nQ.2 Rosenmund reaction',
        p1: 'Section B\nQ.4) ...',
        p2: 'Q.8)\n2-chloro...\nQ.9)',
      },
    });
    expect(ranked[0].assetId).toBe('p2');
    expect(ranked[0].mentionsTarget).toBe(true);
  });

  it('falls back to source_pages (1-based) when no OCR label exists', () => {
    const ranked = rankVisualPages({
      orderedAssetIds: ['p0', 'p1', 'p2'],
      sourcePages: [3],
      questionNumber: 'Q8',
      pageMarkdownByAssetId: {
        p0: 'Q.1 only',
        p1: 'Q.4 only',
        p2: 'structures with no labels',
      },
    });
    expect(ranked[0].assetId).toBe('p2');
  });

  it('reads source_pages as 1-based page numbers', () => {
    const ranked = rankVisualPages({
      orderedAssetIds: ['p0', 'p1', 'p2'],
      sourcePages: [2],
      questionNumber: 'Q8',
      pageMarkdownByAssetId: { p0: 'notes', p1: 'notes', p2: 'notes' },
    });
    expect(ranked[0].assetId).toBe('p1');
  });

  it('ignores the legacy [0] that old evidence rows carry', () => {
    const ranked = rankVisualPages({
      orderedAssetIds: ['p0', 'p1', 'p2'],
      sourcePages: [0],
      questionNumber: 'Q8',
      pageMarkdownByAssetId: { p0: 'notes', p1: 'notes', p2: 'notes' },
    });
    expect(ranked.every((row) => row.score === 0)).toBe(true);
  });

  it('rejects descriptions that admit the wrong question', () => {
    expect(validateVisualRescueDescription('QUESTION_NOT_ON_PAGE', 'Q8').ok).toBe(false);
    expect(validateVisualRescueDescription(
      'There is no question labeled Q8. Assuming the query refers to Q.2, here is Rosenmund...',
      'Q8',
    ).ok).toBe(false);
    expect(validateVisualRescueDescription(
      'Based on the visual evidence, the section labeled Q.2) (target despite prompt referencing Q8) contains Rosenmund',
      'Q8',
    ).ok).toBe(false);
    expect(validateVisualRescueDescription(
      'Q8.\ni. 2-chloro-4-methyl cyclohexan-1-one\nii. 3,4-Dimethyl benzaldehyde',
      'Q8',
    ).ok).toBe(true);
    expect(validateVisualRescueDescription(
      'The crop shows the phenol reaction. 1. The phenol reacts with chloroform. 2. Hydrolysis gives salicylaldehyde.',
      'Q21',
    ).ok).toBe(true);
  });

  it('builds a prompt that forbids substituting other questions', () => {
    const prompt = buildVisualRescuePrompt(
      { question_number: 'Q8', question_text: 'Give IUPAC names' },
      { visual_requirements: 'structures' },
    );
    expect(prompt).toContain('QUESTION_NOT_ON_PAGE');
    expect(prompt).toContain('Do not describe');
    expect(prompt).toContain('Q8');
  });

  it('detects reviewer-touched questions', () => {
    expect(isReviewerTouchedQuestion({ reviewRevision: 2 })).toBe(true);
    expect(isReviewerTouchedQuestion({ reviewerId: 'achadmin', reviewState: 'approved' })).toBe(true);
    expect(isReviewerTouchedQuestion({ reviewRevision: 0, reviewState: 'pending', reviewerId: null })).toBe(false);
  });

  it('targets a question located on page 3 of a single multi-page asset (FLKRM-158)', () => {
    // One asset whose OCR carries several pages; the target question only appears
    // on the third page. The ranking must select that asset by the page-3 label,
    // not assume the question lives on page 1 / asset index 0.
    const multiPageMarkdown = [
      '--- page 1 ---',
      'Q.1) carbohydrate question',
      '--- page 2 ---',
      'Q.4) isomerism question',
      '--- page 3 ---',
      'Q.9) Draw the structure of 2-methylpropan-2-ol',
    ].join('\n\n');

    const ranked = rankVisualPages({
      orderedAssetIds: ['single-multi-page-pdf'],
      sourcePages: [], // no source-page hint; ranking must rely on the page-3 label
      pageMarkdownByAssetId: { 'single-multi-page-pdf': multiPageMarkdown },
      questionNumber: 'Q9',
    });

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].assetId).toBe('single-multi-page-pdf');
    expect(ranked[0].mentionsTarget).toBe(true);
    // Sanity: the page-3 block is actually within the fed markdown the consumer uses.
    expect(multiPageMarkdown).toContain('Q.9)');
  });
});

// Oct 2026: all 29 unverified diagrams were on the page the OCR reader linked,
// but the page carried no "Q2" / "Q9.3" label (a map on a fresh sheet, an answer
// starting "(i)"), so the label-only prompt answered QUESTION_NOT_ON_PAGE.
describe('visual rescue on an unlabelled source page', () => {
  const question = { question_number: 'Q2', question_text: 'On the outline map of India, mark and name the following.' };
  const answer = 'INDIA KARAKORAM PASS JULAR LAKE Black Soil SATPURA RANGES KONKAN COAST DENSELY POPULATED REGION';

  it('marks which ranked pages the OCR reader linked to the answer', () => {
    const ranked = rankVisualPages({
      orderedAssetIds: ['p1', 'p2', 'p3'],
      sourcePages: [2],
      pageMarkdownByAssetId: { p1: 'Q.1) Answer', p2: 'INDIA KARAKORAM PASS', p3: 'Q.3) Answer' },
      questionNumber: 'Q2',
    });
    expect(ranked[0]).toMatchObject({ assetId: 'p2', sourceHit: true, mentionsTarget: false });
  });

  it('points the prompt at the answer text instead of the question label', () => {
    const anchor = visualAnswerAnchor(answer);
    const prompt = buildVisualRescuePrompt({ ...question, visual_answer_anchor: anchor }, {});
    expect(prompt).toContain('INDIA KARAKORAM PASS');
    expect(prompt).toContain('may not be written on this page');
    expect(prompt).not.toContain('If Q2 is not visibly labeled on this image');
  });

  it('keeps the label-only prompt when there is no anchor', () => {
    expect(buildVisualRescuePrompt(question, {})).toContain('If Q2 is not visibly labeled on this image');
  });

  it('caps the anchor and skips answers too short to anchor on', () => {
    expect(visualAnswerAnchor('x'.repeat(500))).toHaveLength(241);
    expect(visualAnswerAnchor('  (i) ab ')).toBe('');
  });

  it('accepts an anchored description that says the number is not written', () => {
    const description = 'No Q2 label is written on the page, but it shows a hand-drawn map of India with Karakoram Pass and Wular Lake marked.';
    expect(validateVisualRescueDescription(description, 'Q2', { anchored: true }).ok).toBe(true);
    expect(validateVisualRescueDescription(description, 'Q2').ok).toBe(false);
  });

  it('rejects an anchored description that says in prose the answer is not there', () => {
    // Real Oct 2026 replies to the anchored prompt.
    for (const description of [
      'The provided image does not contain the answer to the question "To an astronaut in a spaceship, the earth appears…"',
      "The student's handwritten answer for Q3 is not present on this page.",
      'Not in Syllabus',
    ]) expect(validateVisualRescueDescription(description, 'Q3', { anchored: true }).ok).toBe(false);
  });

  it('accepts a description of what a student left out of a diagram that is there', () => {
    for (const description of [
      'The student drew a ray diagram; the refracted ray is not shown.',
      'Map of India with Wular Lake marked; the label for Chennai is not visible.',
      'The circuit does not show an ammeter.',
    ]) {
      expect(validateVisualRescueDescription(description, 'Q3').ok).toBe(true);
      expect(validateVisualRescueDescription(description, 'Q3', { anchored: true }).ok).toBe(true);
    }
  });

  it('still rejects a miss or a substitute question when anchored', () => {
    expect(validateVisualRescueDescription('QUESTION_NOT_ON_PAGE', 'Q2', { anchored: true }).ok).toBe(false);
    expect(validateVisualRescueDescription('Q5 shows a bar graph of rainfall.', 'Q2', { anchored: true }).ok).toBe(false);
  });
});
