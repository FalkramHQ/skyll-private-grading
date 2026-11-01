const WARNING_CATEGORIES = [
  { key: 'blurry', label: 'Blurry or low confidence', matches: ['blur', 'glare'] },
  { key: 'resolution', label: 'Low resolution', matches: ['low resolution'] },
  { key: 'incomplete', label: 'Incomplete or low text', matches: ['readable content', 'incomplete page'] },
  { key: 'small', label: 'Unusually small file', matches: ['very little image detail'] },
];

export function warningCategoryFor(note = '') {
  const normalized = String(note).toLowerCase();
  return WARNING_CATEGORIES.find((category) => category.matches.some((match) => normalized.includes(match)))?.key || 'other';
}

export function summarizeScanReview(pages = []) {
  const safePages = Array.isArray(pages) ? pages : [];
  const issuePages = safePages
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => Boolean(page?.needsReview));
  const categories = WARNING_CATEGORIES
    .map((category) => ({
      key: category.key,
      label: category.label,
      pageIndexes: issuePages
        .filter(({ page }) => category.matches.some((match) => String(page.qualityNote || '').toLowerCase().includes(match)))
        .map(({ index }) => index),
    }))
    .filter((category) => category.pageIndexes.length > 0);
  const categorizedIndexes = new Set(categories.flatMap((category) => category.pageIndexes));
  const otherIndexes = issuePages.filter(({ index }) => !categorizedIndexes.has(index)).map(({ index }) => index);
  if (otherIndexes.length) categories.push({ key: 'other', label: 'Other warnings', pageIndexes: otherIndexes });

  return {
    pageCount: safePages.length,
    warningCount: issuePages.length,
    issueIndexes: issuePages.map(({ index }) => index),
    categories,
  };
}

export function nextIssueIndex(pages = [], currentIndex = -1) {
  const indexes = summarizeScanReview(pages).issueIndexes;
  return indexes.find((index) => index > currentIndex) ?? indexes[0] ?? -1;
}

export function removeScanPage(pages = [], index) {
  return pages.filter((_, pageIndex) => pageIndex !== index);
}

export function replaceScanPage(pages = [], index, replacement) {
  return pages.map((page, pageIndex) => pageIndex === index ? replacement : page);
}
