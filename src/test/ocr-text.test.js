import { describe, expect, it } from 'vitest';
import {
  ANSWER_SHEET_PAGE_CHAR_CAP,
  answerSheetOcrBundle,
  answerSheetOcrText,
  answerSheetPageNumber,
  compactOcrText,
  mergedAnswerSheetOcrText,
  ocrRunText,
  pageOcrText,
  sortAnswerSheetRows,
  sourceOcrText,
} from '../../apps/processing-worker/ocrText.js';

describe('OCR context rendering', () => {
  const tableOnlyPage = JSON.stringify([{
    index: 0,
    markdown: '[tbl-0.html](tbl-0.html)',
    tables: [{ id: 'tbl-0.html', content: '<table><tr><td>Q1(i)</td><td>C) 36</td></tr></table>' }],
  }]);

  it('includes structured Mistral table contents in student evidence context', () => {
    const output = answerSheetOcrText([{ asset_id: 'page-one', pages_json: tableOnlyPage, markdown: '[tbl-0.html](tbl-0.html)', is_active: 1 }]);
    expect(output).toContain('[asset:page-one]');
    expect(output).toContain('Q1(i)');
    expect(output).toContain('C) 36');
  });

  it('includes structured table contents when building question and rubric context', () => {
    const output = sourceOcrText([{ kind: 'question_paper', pages_json: tableOnlyPage, markdown: '[tbl-0.html](tbl-0.html)' }]);
    expect(output).toContain('[question_paper]');
    expect(output).toContain('Q1(i)');
  });

  it('caps one giant page at the per-page limit instead of letting it fill the 140,000-char budget', () => {
    // Non-repeating junk, so compaction cannot shrink it.
    const hugeMarkdown = Array.from({ length: 20000 }, (_, i) => `w${i}`).join(' ');
    const bundle = answerSheetOcrBundle([
      { asset_id: 'page-huge', markdown: hugeMarkdown, is_active: 1 },
      { asset_id: 'page-next', markdown: 'Q3 ii) Avogadro number is 6.022 x 10^23', is_active: 1 },
    ]);
    expect(bundle.text).toMatch(/^\[asset:page-huge\]\nw0 w1/);
    expect(bundle.text).toMatch(/\[page truncated: \d+ chars omitted\]/);
    expect(bundle.text).toContain('Avogadro number');
    expect(bundle.text.length).toBeLessThan(ANSWER_SHEET_PAGE_CHAR_CAP + 200);
    expect(bundle.clippedAssetIds).toEqual(['page-huge']);
    expect(bundle.droppedAssetIds).toEqual([]);
  });

  it('caps merged answer sheet OCR text at 200,000 characters and orders primary before supplementary', () => {
    const rows = [
      { asset_id: 'asset_a', is_active: 0, engine: 'secondary', markdown: Array.from({ length: 20000 }, (_, i) => `b${i}`).join(' ') },
      { asset_id: 'asset_a', is_active: 1, engine: 'mistral', markdown: Array.from({ length: 20000 }, (_, i) => `a${i}`).join(' ') },
    ];
    const output = mergedAnswerSheetOcrText(rows);
    expect(output.length).toBe(200000);
    expect(output).toContain('PRIMARY');
    expect(output.indexOf('PRIMARY')).toBeLessThan(output.indexOf('SUPPLEMENTARY'));
  });

  it('handles empty tables array, malformed json, and missing table references gracefully without crashing', () => {
    expect(pageOcrText({ markdown: '[tbl-99.html](tbl-99.html)', tables: [] })).toBe('[tbl-99.html](tbl-99.html)');
    expect(ocrRunText({ pages_json: '{malformed-json}', markdown: 'Fallback markdown text' })).toBe('Fallback markdown text');
    expect(ocrRunText({ pages_json: null, markdown: null })).toBe('');
  });

  it('carries content from ALL pages of a multi-page asset, not just the first (FLKRM-158)', () => {
    const threePages = JSON.stringify([
      { index: 0, markdown: 'Q.1) mcq answer' },
      { index: 1, markdown: 'Q.2) hydrogen bonding' },
      { index: 2, markdown: 'Q.9) diagram labelled' },
    ]);
    // ac3 fixture: a 3-page asset must surface content from every page.
    const output = ocrRunText({ pages_json: threePages });
    expect(output).toContain('--- page 1 ---');
    expect(output).toContain('--- page 2 ---');
    expect(output).toContain('--- page 3 ---');
    expect(output).toContain('Q.1) mcq answer');
    expect(output).toContain('Q.2) hydrogen bonding');
    expect(output).toContain('Q.9) diagram labelled');

    // And through the answer-sheet renderer (the evidence/region consumer path).
    const sheet = answerSheetOcrText([
      { asset_id: 'multi', is_active: 1, pages_json: threePages },
    ]);
    expect(sheet).toContain('[asset:multi]');
    expect(sheet).toContain('Q.2) hydrogen bonding');
    expect(sheet).toContain('Q.9) diagram labelled');
  });
});

// A Datalab page whose printed Q.No. header grid came back as a markdown table
// padded with ~165k spaces/dashes put the rest of the sheet past the 140k cut,
// so 14 of 15 pages never reached extraction and 25/27 answers read as blank.
function paddedHeaderGridPage(answerLines) {
  const pad = ' '.repeat(24204);
  const dash = '-'.repeat(24204);
  return [
    '3',
    '',
    '|       |  |  |  |  |  |       |  |  |  |  |',
    '|-------|--|--|--|--|--|-------|--|--|--|--|',
    '| Q.No. |  |  |  |  |  | Q.No. |  |  |  |  |',
    '',
    `|                   |      |${pad}|`,
    `|-------------------|------|${dash}|`,
    `| Q.No. | 2    |${pad}|`,
    ...answerLines.map((line) => `|                   | ${line} |${pad}|`),
  ].join('\n');
}

describe('OCR padding compaction', () => {
  it('collapses space, NBSP and dash padding but keeps the answer text', () => {
    const page = paddedHeaderGridPage(['i) | Silicon = 14 1s2 2s2 2p6 3s2 3p2', 'ii) | mass no. = protons + neutrons, 11 = x + 6']);
    expect(page.length).toBeGreaterThan(90000);
    const out = compactOcrText(page);
    expect(out.length).toBeLessThan(600);
    expect(out).toContain('Silicon = 14 1s2 2s2 2p6 3s2 3p2');
    expect(out).toContain('11 = x + 6');
    expect(out).not.toMatch(/ {2,}/);
    expect(out).not.toMatch(/-{4,}/);
    expect(compactOcrText(`a${' '.repeat(90000)}b`)).toBe('a b');
  });

  it('drops empty markdown and HTML table grids and unresolved table refs', () => {
    expect(compactOcrText('| | | | | | | | |\n|---|---|:--:|\nreal answer').trim()).toBe('| \n\nreal answer'.trim());
    const html = `[tbl-0.html](tbl-0.html)[tbl-1.html](tbl-1.html)\n\n[table 1]\n<table><tr>${'<td></td>'.repeat(11)}</tr><tr>${'<td></td>'.repeat(11)}</tr></table>\nQ1) answer`;
    expect(compactOcrText(html).trim()).toBe('Q1) answer');
    // A table with content survives with its cells.
    expect(compactOcrText('<table><tr><td>Q1(i)</td><td></td><td>C) 36</td></tr></table>')).toContain('C) 36');
  });

  it('collapses a looping OCR token but leaves ordinary repetition alone', () => {
    const looped = `(+1) + (-2) + ${'ext{ '.repeat(400)}= 0`;
    const out = compactOcrText(looped);
    expect(out.length).toBeLessThan(60);
    expect(out).toContain('(+1) + (-2) +');
    expect(out).toContain('= 0');
    // Under 20 repeats is real content (lists, dotted lines, |x| notation).
    expect(compactOcrText('rice, rice, rice, wheat')).toBe('rice, rice, rice, wheat');
    expect(compactOcrText('1, 2, 3, 4, 5')).toBe('1, 2, 3, 4, 5');
    expect(compactOcrText('|x| = |-x|')).toBe('|x| = |-x|');
    expect(compactOcrText('2x + 3 = 7 => x = 2')).toBe('2x + 3 = 7 => x = 2');
  });
});

describe('answerSheetOcrBundle', () => {
  const normalPage = (n) => ({ asset_id: `page-${n}`, is_active: 1, markdown: `Q${n}) answer written on page ${n}` });

  it('keeps every page when a padded header-grid page sorts first (the reported incident)', () => {
    const rows = [
      { asset_id: 'page-2', is_active: 1, markdown: paddedHeaderGridPage(['i) | Silicon = 14']) },
      ...Array.from({ length: 14 }, (_, i) => normalPage(i + 3)),
    ];
    const bundle = answerSheetOcrBundle(rows);
    expect(bundle.includedAssetIds).toHaveLength(15);
    expect(bundle.clippedAssetIds).toEqual([]);
    expect(bundle.droppedAssetIds).toEqual([]);
    expect(bundle.text).toContain('Silicon = 14');
    expect(bundle.text).toContain('answer written on page 16');
    expect(bundle.text.length).toBeLessThan(2000);
  });

  it('reports pages that do not fit the budget instead of dropping them silently', () => {
    const rows = Array.from({ length: 5 }, (_, i) => normalPage(i + 1));
    const bundle = answerSheetOcrBundle(rows, { budget: 80 });
    expect(bundle.text.length).toBeLessThanOrEqual(80);
    expect(bundle.includedAssetIds.length + bundle.droppedAssetIds.length).toBe(5);
    expect(bundle.droppedAssetIds.length).toBeGreaterThan(0);
    expect(bundle.clippedAssetIds.length).toBe(1);
  });

  it('applies the per-page cap to each page of a multi-page asset', () => {
    const junk = Array.from({ length: 8000 }, (_, i) => `t${i}`).join(' ');
    const pages_json = JSON.stringify([{ index: 0, markdown: junk }, { index: 1, markdown: 'Q2) last page answer' }]);
    const bundle = answerSheetOcrBundle([{ asset_id: 'pdf', is_active: 1, pages_json }], { pageCap: 1000 });
    expect(bundle.text).toContain('--- page 2 ---\nQ2) last page answer');
    expect(bundle.clippedAssetIds).toEqual(['pdf']);
  });

  it('ignores supplementary runs and keeps answerSheetOcrText as the bundle text', () => {
    const rows = [normalPage(1), { asset_id: 'page-1', is_active: 0, markdown: 'supplementary noise' }];
    expect(answerSheetOcrBundle(rows).text).not.toContain('supplementary noise');
    expect(answerSheetOcrText(rows)).toBe(answerSheetOcrBundle(rows).text);
  });
});

describe('answer-sheet page order', () => {
  it('reads the page index from both storage key formats', () => {
    expect(answerSheetPageNumber('schools/x/assets/asset_1/Kirtana_Dabke-page-1791452321160-2.jpg')).toBe(2);
    expect(answerSheetPageNumber('schools/x/assets/asset_1/Ismail_Tambe-page-1784711171629-15.jpg')).toBe(15);
    expect(answerSheetPageNumber('review-images/partner-academy-b/chemistry/page-3.jpg')).toBe(3);
    // The 13-digit upload timestamp is never mistaken for a page index.
    expect(answerSheetPageNumber('Name-page-1784711171629.jpg')).toBe(Infinity);
    expect(answerSheetPageNumber('skyll-oci-answer-sheet.png')).toBe(Infinity);
    expect(answerSheetPageNumber(null)).toBe(Infinity);
  });

  it('sorts by page index, keeps an asset\'s OCR runs together, and leaves unnumbered pages last', () => {
    // Upload (created_at) order seen in production: 2, 1, 4, 5, 3.
    const key = (n) => `s/a/Name-page-1791452321160-${n}.jpg`;
    const rows = [
      { asset_id: 'p2', storage_key: key(2), is_active: 1 },
      { asset_id: 'p2', storage_key: key(2), is_active: 0 },
      { asset_id: 'p1', storage_key: key(1), is_active: 1 },
      { asset_id: 'extra', storage_key: 's/a/extra-sheet.jpg', is_active: 1 },
      { asset_id: 'p4', storage_key: key(4), is_active: 1 },
      { asset_id: 'p5', storage_key: key(5), is_active: 1 },
      { asset_id: 'p3', storage_key: key(3), is_active: 1 },
    ];
    expect(sortAnswerSheetRows(rows).map((r) => `${r.asset_id}:${r.is_active}`))
      .toEqual(['p1:1', 'p2:1', 'p2:0', 'p3:1', 'p4:1', 'p5:1', 'extra:1']);
    expect(rows[0].asset_id).toBe('p2'); // input is not mutated
    const text = answerSheetOcrText(sortAnswerSheetRows(rows.map((r) => ({ ...r, markdown: `content ${r.asset_id}` }))));
    expect(text.indexOf('content p1')).toBeLessThan(text.indexOf('content p2'));
    expect(text.indexOf('content p3')).toBeLessThan(text.indexOf('content p4'));
  });
});

describe('source and merged OCR caps compact before cutting', () => {
  it('keeps the answer key when the question paper has a padded page', () => {
    const paddedPaper = `Q1. Define mole.\n|${' '.repeat(160000)}|\nQ2. State Avogadro's law.`;
    const out = sourceOcrText([
      { kind: 'question_paper', markdown: paddedPaper },
      { kind: 'answer_key', markdown: 'Q1. 6.022 x 10^23 particles' },
    ]);
    expect(out.length).toBeLessThan(500);
    expect(out).toContain("Q2. State Avogadro's law.");
    expect(out).toContain('[answer_key]');
    expect(out).toContain('6.022 x 10^23');
  });

  it('keeps the supplementary run when the primary run is padded', () => {
    const out = mergedAnswerSheetOcrText([
      { asset_id: 'a1', is_active: 1, model: 'datalab', markdown: `Q1) primary${' '.repeat(190000)}end` },
      { asset_id: 'a1', is_active: 0, model: 'mistral', markdown: 'Q1) supplementary reading' },
    ]);
    expect(out.length).toBeLessThan(300);
    expect(out).toContain('SUPPLEMENTARY (mistral)');
    expect(out).toContain('Q1) supplementary reading');
  });
});

