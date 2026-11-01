import { nextIssueIndex, removeScanPage, replaceScanPage, summarizeScanReview, warningCategoryFor } from '../src/scanReview';

const clean = (uri = 'clean.jpg') => ({ uri, needsReview: false, qualityNote: '' });
const warning = (uri, qualityNote) => ({ uri, needsReview: true, qualityNote });

describe('scan review helpers', () => {
  test('summarizes a clean 14-page scan without requiring page-by-page confirmation', () => {
    const pages = Array.from({ length: 14 }, (_, index) => clean(`${index}.jpg`));
    expect(summarizeScanReview(pages)).toMatchObject({ pageCount: 14, warningCount: 0, issueIndexes: [], categories: [] });
  });

  test('counts pages needing review exactly once and groups warning categories', () => {
    const pages = [
      clean(),
      warning('low.jpg', 'Low resolution. Retake this page if handwriting is not crisp.'),
      warning('small.jpg', 'Very little image detail was captured. Check for blur, glare, or an incomplete page.'),
    ];
    const summary = summarizeScanReview(pages);
    expect(summary.warningCount).toBe(2);
    expect(summary.issueIndexes).toEqual([1, 2]);
    expect(summary.categories.map(({ key, pageIndexes }) => [key, pageIndexes])).toEqual([
      ['blurry', [2]],
      ['resolution', [1]],
      ['incomplete', [2]],
      ['small', [2]],
    ]);
  });

  test('classifies supported warning categories and falls back to other', () => {
    expect(warningCategoryFor('Low resolution.')).toBe('resolution');
    expect(warningCategoryFor('The on-device legibility check found very little readable content.')).toBe('incomplete');
    expect(warningCategoryFor('Very little image detail was captured.')).toBe('small');
    expect(warningCategoryFor('Could not verify image dimensions.')).toBe('other');
  });

  test('next issue navigation advances and wraps', () => {
    const pages = [warning('1', 'Low resolution.'), clean('2'), warning('3', 'Unknown warning')];
    expect(nextIssueIndex(pages, 0)).toBe(2);
    expect(nextIssueIndex(pages, 2)).toBe(0);
    expect(nextIssueIndex([clean()], 0)).toBe(-1);
  });

  test('remove and retake preserve the remaining page order', () => {
    const pages = [clean('1'), clean('2'), clean('3')];
    expect(removeScanPage(pages, 1).map(({ uri }) => uri)).toEqual(['1', '3']);
    expect(replaceScanPage(pages, 1, clean('2-retake')).map(({ uri }) => uri)).toEqual(['1', '2-retake', '3']);
  });
});
