// One page order for a student's answer sheet, used by evidence extraction and
// by the review screen alike.
//
// The intake app names each page "<name>-page-<batchTimestamp>-<pageNumber>.jpg",
// with one timestamp per scan batch. Upload (created_at) order is not page
// order, because pages upload in parallel; the page number alone is not either,
// because older app versions restarted it in each batch. Batch, then page
// number, is. Keys with only a trailing number ("page-2.jpg") sort by that
// number; keys with neither keep their incoming order, after the others.

export function answerSheetPageKey(storageKey) {
  const key = String(storageKey || '');
  const batched = /-page-(\d+)-(\d+)\.[a-z0-9]+$/i.exec(key);
  if (batched) return { batch: Number(batched[1]), page: Number(batched[2]) };
  const numbered = /(?:^|[-_/])(\d{1,3})\.[a-z0-9]+$/i.exec(key);
  if (numbered) return { batch: 0, page: Number(numbered[1]) };
  return { batch: Infinity, page: Infinity };
}

/** Stable sort of answer-sheet rows (assets or OCR runs) into page order. */
export function sortAnswerSheetPages(rows, keyOf = (row) => row?.storage_key) {
  return (rows || [])
    .map((row, index) => ({ row, index, key: answerSheetPageKey(keyOf(row)) }))
    .sort((a, b) => {
      if (a.key.batch !== b.key.batch) return a.key.batch < b.key.batch ? -1 : 1;
      if (a.key.page !== b.key.page) return a.key.page < b.key.page ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}
