/**
 * Format dense report text into readable markdown with paragraph breaks
 * and bullet points. Runs after jargon stripping.
 */

// Phrases that should start a new paragraph
const PARAGRAPH_BREAK_BEFORE = [
  /For example,/gi,
  /The pattern is/gi,
  /The recurring issue is/gi,
  /The dominant issue is/gi,
  /The main gap is/gi,
  /The root cause is/gi,
  /Your proof writing/gi,
  /Your geometric constructions/gi,
  /You correctly answered/gi,
  /Your computational work/gi,
  /Your assertion-reason/gi,
  /Your errors cluster/gi,
  /After reaching a final answer/gi,
  /After solving/gi,
  /Before selecting/gi,
  /Before final submission/gi,
  /Break each multi-step/gi,
  /Build on strong/gi,
  /Your proof answers/gi,
  /Transfer this/gi,
  /For each question listed/gi,
  /Focus your practice/gi,
];

/**
 * Convert semicolon-separated Q-lists into markdown bullet points.
 * e.g. "Marks lost on: Q1 (Topic) - 0/3: detail; Q2 (Topic) - 1/2: detail"
 * -> "Marks lost on:\n- Q1 (Topic) - 0/3: detail\n- Q2 (Topic) - 1/2: detail"
 */
function formatQList(text) {
  // Match "Marks lost on: ...; ...; ..." pattern
  const listMatch = text.match(/^(Marks lost on:)\s*(.+)$/i);
  if (listMatch && listMatch[2].includes(';')) {
    const prefix = listMatch[1];
    const items = listMatch[2].split(';').map(s => s.trim()).filter(Boolean);
    if (items.length > 1) {
      return `${prefix}\n- ${items.join('\n- ')}`;
    }
  }
  return text;
}

/**
 * Break a long paragraph into smaller ones at sentence boundaries.
 * Targets ~2 sentences per paragraph for readability.
 * Careful not to split on decimal numbers (e.g. 0.071..).
 */
function splitLongParagraph(text) {
  // If text already has paragraph breaks, leave it alone
  if (text.includes('\n\n')) return text;

  // Split on sentence boundaries: period/!/? followed by space + capital letter
  // This avoids splitting on decimal numbers like 0.071 or ellipsis ..
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/) || [text];
  if (sentences.length <= 2) return text;

  const paragraphs = [];
  for (let i = 0; i < sentences.length; i += 2) {
    const chunk = sentences.slice(i, i + 2).join(' ').trim();
    if (chunk) paragraphs.push(chunk);
  }
  return paragraphs.join('\n\n');
}

/**
 * Insert paragraph breaks before known transition phrases.
 */
function breakBeforeTransitions(text) {
  let result = text;
  for (const pattern of PARAGRAPH_BREAK_BEFORE) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => `\n\n${match}`);
  }
  return result;
}

/**
 * OCR commonly emits table rows without the Markdown divider row. Recover each
 * contiguous pipe-delimited block independently, so a question can contain a
 * balance sheet followed by a separate profit-history table.
 */
function restoreInlineTables(text) {
  const cells = (line) => line
    .split('|')
    .map((cell) => cell.trim())
    .slice(1, -1)
    .map((cell) => cell.trim());
  const lines = String(text).split('\n');
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const isTableRow = (line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('|') && trimmed.endsWith('|') && cells(trimmed).length >= 2;
    };

    if (!isTableRow(lines[index])) {
      output.push(lines[index]);
      index += 1;
      continue;
    }

    const rows = [];
    while (index < lines.length && isTableRow(lines[index])) {
      rows.push(cells(lines[index].trim()));
      index += 1;
    }

    // A single pipe-delimited line is prose, not a recoverable table.
    if (rows.length < 2) {
      output.push(`| ${rows[0].join(' | ')} |`);
      continue;
    }

    const width = Math.max(...rows.map((row) => row.length));
    const normalised = rows.map((row) => [...row, ...Array(width - row.length).fill('')]);
    const formatRow = (row) => `| ${row.join(' | ')} |`;
    const isDividerRow = (row) => row.every((cell) => /^:?-{3,}:?$/.test(cell));
    output.push(formatRow(normalised[0]));
    // OCR sometimes already supplies a valid Markdown divider. Retaining it
    // avoids generating a duplicate divider row, which makes GFM fall back to
    // literal pipes instead of an actual table.
    if (isDividerRow(normalised[1])) {
      output.push(formatRow(normalised[1]));
      output.push(...normalised.slice(2).map(formatRow));
    } else {
      output.push(`| ${normalised[0].map(() => '---').join(' | ')} |`);
      output.push(...normalised.slice(1).map(formatRow));
    }
  }

  return output.join('\n');
}

/**
 * Main formatting function - takes cleaned text and returns markdown-formatted text.
 */
export function formatReportText(text) {
  if (!text) return '';
  let formatted = restoreInlineTables(String(text));

  // 1. Convert Q-lists to bullet points
  formatted = formatQList(formatted);

  // 2. Break before transition phrases
  formatted = breakBeforeTransitions(formatted);

  // 3. Split remaining long paragraphs (only those without existing breaks)
  const paragraphs = formatted.split('\n\n');
  const formattedParagraphs = paragraphs.map(p => {
    // Don't split bullet lists or short paragraphs
    if (p.trim().startsWith('-') || p.length < 120) return p;
    return splitLongParagraph(p);
  });

  return formattedParagraphs.join('\n\n').trim();
}
