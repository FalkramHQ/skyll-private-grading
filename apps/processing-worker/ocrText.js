import { answerSheetPageKey, sortAnswerSheetPages } from '../../shared/answerSheetOrder.js';

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function text(value) {
  return String(value || '').trim();
}

export const ANSWER_SHEET_CHAR_BUDGET = 140000;
// No real handwritten page comes close to this once padding is compacted
// (observed max ~2k chars). A page over it is OCR garbage, and must not be
// allowed to push every later page out of the budget.
export const ANSWER_SHEET_PAGE_CHAR_CAP = 20000;

/**
 * Remove OCR padding that carries no student content. Datalab/Mistral sometimes
 * render a printed header grid as a markdown table whose cells are padded with
 * tens of thousands of spaces/NBSPs and dashes, or loop on one token
 * ("ext{ ext{ ..."). Left alone, one such page fills the whole prompt budget.
 */
export function compactOcrText(value) {
  return String(value || '')
    // Unresolved table refs; pageOcrText has already appended their contents
    .replace(/\[tbl-\d+\.html\]\(tbl-\d+\.html\)/g, '')
    // Empty HTML cells, then tables (and their [table N] labels) left with none
    .replace(/(?:<td>\s*<\/td>\s*)+/g, '<td></td>')
    .replace(/(?:\[table \d+\]\s*)?<table>(?:\s*<tr>(?:<td><\/td>)*<\/tr>)*\s*<\/table>/g, '')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    // Markdown table separator rows: |---|:--:|---|
    .replace(/^[ ]?\|?(?:[ ]?:?-{2,}:?[ ]?\|)+[ ]?(?::?-{2,}:?)?[ ]?$/gm, '')
    .replace(/-{4,}/g, '---')
    // Runs of empty table cells: "|  |  |  |" -> "| "
    .replace(/(?:\|[ ]?){3,}/g, '| ')
    // Degenerate repetition of a short unit (OCR model looping)
    .replace(/(.{1,40}?)\1{19,}/g, (match, unit) => `${unit.repeat(3)}…`)
    .replace(/\n{3,}/g, '\n\n');
}

// Tables are already inlined into the markdown column (as plain text) by the
// backfill / normalizeOcrResult step. Only append raw table content when the
// markdown still contains unresolved [tbl-N.html] references.
export function pageOcrText(page) {
  const markdown = text(page?.markdown);
  if (!markdown) return '';
  if (!markdown.includes('[tbl-')) return markdown;
  // Fallback: markdown has unresolved table refs — append raw table content
  const sections = [markdown];
  const tables = Array.isArray(page?.tables) ? page.tables : [];
  for (const [index, table] of tables.entries()) {
    const content = text(table?.content || table?.html || table?.markdown || table?.text);
    if (content) sections.push(`[table ${index + 1}]\n${content}`);
  }
  return sections.join('\n\n');
}

function pageLabel(page, index) {
  return `--- page ${Number.isFinite(Number(page?.index)) ? Number(page.index) + 1 : index + 1} ---`;
}

export function ocrRunText(row) {
  const pages = parseJson(row?.pages_json, []);
  if (Array.isArray(pages) && pages.length) {
    return pages
      .map((page, index) => `${pageLabel(page, index)}\n${pageOcrText(page)}`)
      .join('\n\n');
  }
  return text(row?.markdown);
}

function clipPage(value, cap) {
  if (value.length <= cap) return { text: value, clipped: false };
  return { text: `${value.slice(0, cap)}\n[page truncated: ${value.length - cap} chars omitted]`, clipped: true };
}

// Same layout as ocrRunText, but each page is compacted and capped on its own.
function compactRunText(row, pageCap = Infinity) {
  const pages = parseJson(row?.pages_json, []);
  if (Array.isArray(pages) && pages.length) {
    let clipped = false;
    const body = pages
      .map((page, index) => {
        const capped = clipPage(compactOcrText(pageOcrText(page)).trim(), pageCap);
        clipped ||= capped.clipped;
        return `${pageLabel(page, index)}\n${capped.text}`;
      })
      .join('\n\n');
    return { text: body, clipped };
  }
  return clipPage(compactOcrText(text(row?.markdown)).trim(), pageCap);
}

// Answer-sheet pages upload in parallel, so created_at order is not page order.
// Keys end in the page index: "<name>-page-<ts>-2.jpg" or "page-2.jpg".
export function answerSheetPageNumber(storageKey) {
  return answerSheetPageKey(storageKey).page;
}

// Stable sort into the shared page order (batch, then page number): rows of one
// asset stay together, and assets without a page index keep their incoming
// (created_at) order after the numbered ones.
export function sortAnswerSheetRows(rows) {
  return sortAnswerSheetPages(rows);
}

const pageWords = (value) => String(value || '').normalize('NFKC').toLowerCase()
  .split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1);

/**
 * Leaves out answer-sheet pages uploaded twice: a page whose active OCR text
 * shares 90% of its words with an earlier page (and is of similar length) is
 * dropped with all its OCR runs. Checksums would be simpler, but the intake app
 * uploads none. Pages under 30 words are never compared: two nearly blank pages
 * say nothing about each other.
 */
export function dropDuplicatePages(rows, { minWords = 30, minShared = 0.9 } = {}) {
  const seen = [];
  const duplicateAssetIds = new Set();
  for (const row of rows) {
    if (Number(row.is_active) !== 1) continue;
    const words = new Set(pageWords(ocrRunText(row)));
    if (words.size < minWords) continue;
    const match = seen.find((page) => {
      const larger = Math.max(page.words.size, words.size);
      if (Math.min(page.words.size, words.size) / larger < minShared) return false;
      let shared = 0;
      for (const word of words) if (page.words.has(word)) shared += 1;
      return shared / larger >= minShared;
    });
    if (match && match.assetId !== row.asset_id) duplicateAssetIds.add(row.asset_id);
    else seen.push({ assetId: row.asset_id, words });
  }
  return { rows: rows.filter((row) => !duplicateAssetIds.has(row.asset_id)), duplicateAssetIds: [...duplicateAssetIds] };
}

/**
 * Builds the evidence-stage OCR for one student and reports what did not make
 * it in. `clippedAssetIds` lost part of their text, `droppedAssetIds` lost all
 * of it. Either means a blank answer cannot be trusted as a skipped question.
 */
export function answerSheetOcrBundle(rows, { budget = ANSWER_SHEET_CHAR_BUDGET, pageCap = ANSWER_SHEET_PAGE_CHAR_CAP } = {}) {
  const active = rows.filter((row) => Number(row.is_active) === 1);
  const sections = [];
  const includedAssetIds = [];
  const clippedAssetIds = [];
  const droppedAssetIds = [];
  let used = 0;
  for (const row of active) {
    const run = compactRunText(row, pageCap);
    const section = `[asset:${row.asset_id}]\n${run.text}`;
    const separator = sections.length ? 2 : 0;
    const room = budget - used - separator;
    if (room <= 0) {
      droppedAssetIds.push(row.asset_id);
      continue;
    }
    const fits = section.length <= room;
    sections.push(fits ? section : section.slice(0, room));
    used += separator + Math.min(section.length, room);
    includedAssetIds.push(row.asset_id);
    if (run.clipped || !fits) clippedAssetIds.push(row.asset_id);
  }
  return { text: sections.join('\n\n'), includedAssetIds, clippedAssetIds, droppedAssetIds };
}

export function answerSheetOcrText(rows) {
  return answerSheetOcrBundle(rows).text;
}

/**
 * Produces merged multi-OCR prompt with PRIMARY and SUPPLEMENTARY sources labelled.
 * Primary (is_active=1) comes first, then supplementary runs grouped by asset.
 * Each run is compacted before the cap, like answerSheetOcrBundle.
 */
export function mergedAnswerSheetOcrText(rows) {
  const byAsset = new Map();
  for (const row of rows) {
    if (!byAsset.has(row.asset_id)) byAsset.set(row.asset_id, []);
    byAsset.get(row.asset_id).push(row);
  }
  const sections = [];
  for (const [assetId, runs] of byAsset) {
    // Sort: active (primary) first, then supplementary
    runs.sort((a, b) => Number(b.is_active || 0) - Number(a.is_active || 0));
    for (const run of runs) {
      const label = Number(run.is_active) === 1 ? 'PRIMARY' : 'SUPPLEMENTARY';
      const engine = run.engine || 'mistral';
      const model = run.model || engine;
      sections.push(`[asset:${assetId} - ${label} (${model})]\n${compactRunText(run).text}`);
    }
  }
  return sections.join('\n\n').slice(0, 200000);
}

// Question paper / answer key context for rubric building. Compacted first so a
// padded page cannot push later questions or the key past the cap.
export function sourceOcrText(rows) {
  return rows
    .map((row) => `[${row.kind}]\n${compactRunText(row).text}`)
    .join('\n\n')
    .slice(0, 150000);
}
