import { sortAnswerSheetPages } from '../../shared/answerSheetOrder.js';

export function pageNumberFromStorageKey(storageKey) {
  const match = String(storageKey || '').match(/-page-\d+-(\d+)\.[^./]+$/i)
    || String(storageKey || '').match(/-(\d+)\.[^./]+$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function indexIntakeAnswerSheetAssets(rows) {
  // Same page order as evidence extraction (shared/answerSheetOrder.js): scan
  // batch, then page number. Neither upload order (pages upload in parallel) nor
  // the page number alone (older apps restarted it per batch) is reliable.
  return sortAnswerSheetPages(rows).map((row, index) => ({ ...row, page: index + 1 }));
}

export function findIntakeAnswerSheetAsset(rows, page) {
  const requestedPage = Number(page);
  if (!Number.isInteger(requestedPage) || requestedPage < 1) return null;
  const indexed = indexIntakeAnswerSheetAssets(rows);
  const numbered = indexed.find((asset) => asset.page === requestedPage);
  if (numbered) return numbered;

  // A small number of pre-canonical uploads do not carry a page suffix. They
  // were still created in scan order, so retain that order as a compatibility
  // fallback instead of making a previously reviewable script disappear.
  return indexed.length === 0 ? (rows || [])[requestedPage - 1] || null : null;
}
