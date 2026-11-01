/**
 * Detect SMILES / reaction-SMILES spans in OCR/VL chemistry text so the UI
 * can draw rings instead of dumping c1ccccc1 strings.
 */

const STRUCTURAL = /(?:c1ccccc1|[cC]1|[=\(\[]|#)/;
const SMILES_CHARS = /^[A-Za-z0-9@+\-\[\]\(\)=#$.:\\/%]+$/;

/**
 * Only draw structures that are hard to read as plain text (rings, aromatics, reactions).
 * Simple halides / alkene chains stay as text so inequality sequences remain readable.
 */
export function shouldDrawStructure(raw) {
  if (!isLikelySmiles(raw)) return false;
  const token = String(raw || '').trim();
  if (token.includes('>')) return true;
  if (/c1ccccc1/i.test(token)) return true;
  if (/[cCnNoOsS]\d/.test(token)) return true;
  return false;
}

function findProtectedSpans(source) {
  const spans = [];
  let i = 0;
  const text = String(source || '');
  while (i < text.length) {
    if (text[i] === '$') {
      const close = text.indexOf('$', i + 1);
      if (close !== -1) {
        spans.push({ start: i, end: close + 1 });
        i = close + 1;
        continue;
      }
    }
    if (text.slice(i, i + 6) === '\\text{') {
      let j = i + 5;
      let depth = 1;
      j += 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      spans.push({ start: i, end: j });
      i = j;
      continue;
    }
    i += 1;
  }
  return spans;
}

function insideProtectedSpan(start, length, spans) {
  const end = start + length;
  return spans.some((span) => start >= span.start && end <= span.end);
}

export function isLikelySmiles(raw) {
  const token = String(raw || '').trim();
  if (token.length < 5 || token.length > 500) return false;
  if (!/[cC]/.test(token)) return false;
  if (!STRUCTURAL.test(token)) return false;
  if (/^[A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+){1,}$/.test(token)) return false;
  // Molecules: no whitespace. Reactions: may include > and limited spaces.
  if (token.includes('>')) {
    const compact = token.replace(/\s+/g, '');
    if (!/[cC].*>/.test(compact)) return false;
    if (!/[0-9=()\[\]]/.test(compact)) return false;
    // Allow digits / + / spaces around reaction arrows; reject prose.
    if (/[a-z]{4,}/i.test(token.replace(/c1ccccc1/gi, 'X'))) {
      // Long lowercase runs outside aromatic rings → probably English.
      const withoutChem = token
        .replace(/[A-Za-z0-9@+\-\[\]\(\)=#$.:\\/%<>\s]+/g, (chunk) => (
          STRUCTURAL.test(chunk) || chunk.includes('>') ? ' ' : chunk
        ));
      if (/[a-z]{4,}/i.test(withoutChem)) return false;
    }
    return true;
  }
  if (/\s/.test(token)) return false;
  return SMILES_CHARS.test(token);
}

/**
 * Pull molecule SMILES out of a (possibly messy) reaction string for fallback drawing.
 */
export function splitReactionMolecules(raw) {
  const text = String(raw || '');
  const parts = text
    .split(/>/)
    .flatMap((chunk) => chunk.split(/\+/))
    .flatMap((chunk) => chunk.split(/\./))
    .map((part) => part.replace(/^\d+\s*/, '').trim())
    .filter(Boolean);
  return parts.filter((part) => isLikelySmiles(part) && !part.includes('>'));
}

function findReactionCandidates(source, protectedSpans) {
  const out = [];
  // VL often dumps a full reaction on one line with several '>' steps.
  const re = /[A-Za-z][A-Za-z0-9@+\-\[\]\(\)=#$.:\\/%]*(?:\.[A-Za-z0-9@+\-\[\]\(\)=#$.:\\/%]+)*(?:\s*>\s*[^\n>]+)+/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const value = match[0].trim().replace(/[.,;:]+$/, '');
    if (!shouldDrawStructure(value)) continue;
    if (insideProtectedSpan(match.index, match[0].length, protectedSpans)) continue;
    out.push({ start: match.index, end: match.index + match[0].length, value });
  }
  return out;
}

/**
 * Split free text into alternating plain / smiles segments.
 * @returns {{ type: 'text'|'smiles', value: string }[]}
 */
export function splitTextWithSmiles(text) {
  const source = String(text || '');
  if (!source) return [];

  const protectedSpans = findProtectedSpans(source);
  const candidates = findReactionCandidates(source, protectedSpans);

  // Standalone molecule tokens (aromatic rings, carbonyls, etc.).
  const molRe = /(?<![\w@+\-\[\]\(\)=#$.:\\/%])([A-Za-z][A-Za-z0-9@+\-\[\]\(\)=#$.:\\/%]{4,})(?![\w@+\-\[\]\(\)=#$.:\\/%])/g;
  let match;
  while ((match = molRe.exec(source)) !== null) {
    const value = match[1];
    if (!shouldDrawStructure(value)) continue;
    if (insideProtectedSpan(match.index, value.length, protectedSpans)) continue;
    candidates.push({ start: match.index, end: match.index + value.length, value });
  }

  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const cand of candidates) {
    if (kept.some((k) => cand.start < k.end && cand.end > k.start)) continue;
    kept.push(cand);
  }

  if (!kept.length) return [{ type: 'text', value: source }];

  const segments = [];
  let cursor = 0;
  for (const cand of kept) {
    if (cand.start > cursor) {
      segments.push({ type: 'text', value: source.slice(cursor, cand.start) });
    }
    segments.push({ type: 'smiles', value: cand.value });
    cursor = cand.end;
  }
  if (cursor < source.length) {
    segments.push({ type: 'text', value: source.slice(cursor) });
  }
  return segments;
}
