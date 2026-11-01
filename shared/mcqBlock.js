/**
 * Deterministic marking for a block of MCQs ("Q1: 16 MCQs, 1 mark for each
 * correct option"). The model used to grade these as a short answer and marked
 * correct letters wrong over wording or OCR noise, and once replaced the key
 * with its own answer (PartnerD ICSE English Literature semi-prelim, Oct 2026:
 * 6 of 8 students lost 1-2 marks). Here each item's letter is compared with the
 * key. When the letter cannot be read, the written option text is matched to the
 * printed options; an item settled by neither is left at 0 and flagged.
 */

export const MCQ_LETTER_UNCLEAR_TAG = 'mcq_letter_unclear';

const LETTERS = ['a', 'b', 'c', 'd', 'e'];
const ROMAN = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx'];
// An item label: "12" or a roman numeral "(viii)".
const ITEM = String.raw`(\d{1,2}|[ivx]{1,5})`;

/** Item number for "12" or "viii"; null otherwise. */
function itemNumber(label) {
  const value = String(label || '').toLowerCase();
  if (/^\d+$/.test(value)) return Number(value);
  const index = ROMAN.indexOf(value);
  return index > 0 ? index : null;
}

/**
 * "1-(d), 2-(b), 3 (a)" or "(i) (b) …; (ii) (b) …" -> Map { 1 => 'd', 2 => 'b', … }.
 * Empty unless the items run 1…n with no gaps, so a stray number or word in a
 * prose key never reads as an item.
 */
export function parseMcqKeyItems(keyText = '') {
  const items = new Map();
  const re = new RegExp(String.raw`(?:^|[\s,;])\(?${ITEM}\)?\s*[-–.:)]?\s*\(?([a-e])\)?(?=[\s,;.]|$)`, 'gi');
  let match;
  while ((match = re.exec(String(keyText || ''))) !== null) {
    const item = itemNumber(match[1]);
    if (item && !items.has(item)) items.set(item, match[2].toLowerCase());
  }
  const numbers = [...items.keys()].sort((a, b) => a - b);
  return numbers.every((n, index) => n === index + 1) ? items : new Map();
}

/**
 * Printed options per item, from the question text: the k-th "(a) … (b) … (c) …"
 * group belongs to item k. Numbered lists inside a stem (item 2's "1. … 2. …")
 * do not matter because groups are found by their "(a)".
 */
export function parseMcqOptions(questionText = '', itemCount = 0) {
  const text = String(questionText || '');
  const starts = [];
  const re = /\(a\)/gi;
  let match;
  while ((match = re.exec(text)) !== null) starts.push(match.index);
  const groups = new Map();
  starts.forEach((start, index) => {
    const item = index + 1;
    if (itemCount && item > itemCount) return;
    let block = text.slice(start, starts[index + 1] ?? text.length);
    // The last option runs into the next item's stem: cut it at "<next>. " or "(<roman>)".
    const next = block.search(new RegExp(String.raw`\s(?:${item + 1}\s*[.)]|\(${ROMAN[item + 1] || 'zz'}\))\s`, 'i'));
    if (next > 0) block = block.slice(0, next);
    const options = {};
    const parts = block.split(/\(([a-e])\)/i).slice(1);
    for (let i = 0; i + 1 < parts.length; i += 2) options[parts[i].toLowerCase()] = parts[i + 1].trim();
    groups.set(item, options);
  });
  return groups;
}

// "1. d) text", "(2) (c) text", "- 3 a - text", "iv] c] text", or a label alone
// on its line with the answer on the next ("(ii)" then "(a) (b) Monsoon").
const LINE = new RegExp(String.raw`^\s*[-*•]?\s*[([]?${ITEM}[)\]]?\s*[.):\-–\]]?(?:\s+(.*))?$`, 'i');
// An option letter: "(b)", "[b]", "b)", "b]", "b.", "b -" or a lone "b" at the
// end of the line. A bare letter followed by a word is text, so the article in
// "2. A cyclone" is not read as option (a).
const LETTER_TOKEN = /^(?:[([]([a-e])\s*[)\]]|([a-e])\s*[)\].](?![a-z])|([a-e])(?=\s*[-–:]\s)|([a-e])\s*$)[.,:\-–]?\s*/i;

/**
 * Student answers per item from OCR text, one item per line: "1. d) text",
 * "(2) (c) text", "- 3 a - text". Returns Map item -> { letters, text, renumbered }
 * where letters lists every leading option letter (two different ones = an
 * overwrite). A number seen again after a later one ("…13, 11, 12, 13") is a
 * numbering restart: it takes the next item after the last one read, marked
 * renumbered so the caller can confirm it by the written option text.
 */
export function parseMcqStudentItems(answer = '') {
  const items = new Map();
  let last = 0;
  let labelOnly = null;
  for (const line of String(answer || '').split(/\n+/)) {
    let match = line.match(LINE);
    // A line with no item label continues a label written alone on the line before.
    if ((!match || !itemNumber(match[1])) && labelOnly && line.trim()) match = [line, labelOnly, line.trim()];
    labelOnly = null;
    if (!match) continue;
    let item = itemNumber(match[1]);
    if (!item) continue;
    if (!String(match[2] || '').trim()) {
      labelOnly = match[1];
      continue;
    }
    let renumbered = false;
    if (items.has(item)) {
      if (items.has(last + 1)) continue;
      item = last + 1;
      renumbered = true;
    }
    last = item;
    let rest = match[2] || '';
    const letters = [];
    for (let i = 0; i < 2; i += 1) {
      const token = rest.match(LETTER_TOKEN);
      if (!token) break;
      letters.push((token[1] || token[2] || token[3] || token[4]).toLowerCase());
      rest = rest.slice(token[0].length);
    }
    items.set(item, { letters, text: rest.replace(/^[-–:\s]+/, '').trim(), renumbered });
  }
  return items;
}

const words = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

function similarity(a, b) {
  const left = words(a);
  const right = new Set(words(b));
  if (!left.length || !right.size) return 0;
  const shared = left.filter((w) => right.has(w)).length;
  return (2 * shared) / (left.length + right.size);
}

/** The option letter whose printed text the student's text clearly matches, or null. */
export function matchOptionText(studentText, options = {}) {
  const scored = Object.entries(options)
    .map(([letter, optionText]) => ({ letter, score: similarity(studentText, optionText) }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const [best, second] = scored;
  if (best.score >= 0.6 && best.score - (second?.score || 0) >= 0.2) return best.letter;
  return null;
}

/**
 * Mark a block of MCQs against a per-item key. Returns null when this is not a
 * block this can mark (no per-item key, or the key does not cover the marks), so
 * the caller falls back to the model.
 *
 * @returns {null | { marks: number, perItem: number, items: Array<{item:number, expected:string, chosen:string|null, status:string, how:string}>, unclear: number[] }}
 */
export function markMcqBlock({ keyText, questionText, studentAnswer, maxMarks, markingRubric = '' }) {
  const key = parseMcqKeyItems(keyText);
  const max = Number(maxMarks) || 0;
  if (key.size < 2 || !(max > 0)) return null;
  const perItem = max / key.size;
  // The key must cover the whole question: the rubric's own per-item mark ("1 mark
  // for each correct option") times the keyed items must equal the marks. Without
  // one, accept only whole or half marks of at most 2 per item. Anything else (a
  // truncated key, a mixed block) is left to the model.
  const stated = String(markingRubric || '').match(/(\d+(?:\.\d+)?)\s*marks?\s+(?:for|per)\s+(?:each|every)\b/i);
  if (stated ? Math.abs(Number(stated[1]) * key.size - max) > 1e-9 : (!Number.isInteger(perItem * 2) || perItem > 2)) return null;
  const options = parseMcqOptions(questionText, key.size);
  const answers = parseMcqStudentItems(studentAnswer);
  const items = [];
  const unclear = [];
  for (const [item, expected] of [...key.entries()].sort((a, b) => a[0] - b[0])) {
    const answer = answers.get(item);
    if (!answer || (!answer.letters.length && !answer.text)) {
      items.push({ item, expected, chosen: null, status: 'not_attempted', how: 'blank' });
      continue;
    }
    const distinct = [...new Set(answer.letters)];
    const textLetter = matchOptionText(answer.text, options.get(item));
    // A renumbered line is trusted only when its text is one of this item's options.
    if (answer.renumbered && options.get(item) && !textLetter) {
      unclear.push(item);
      items.push({ item, expected, chosen: distinct.join('/') || null, status: 'unclear', how: 'renumbered' });
      continue;
    }
    let chosen = null;
    let how = 'letter';
    if (distinct.length === 1 && LETTERS.includes(distinct[0])) {
      chosen = distinct[0];
    } else if (textLetter && (distinct.length === 0 || distinct.includes(textLetter))) {
      // No readable letter, or an overwrite the written option text settles.
      chosen = textLetter;
      how = 'option_text';
    }
    if (!chosen) {
      unclear.push(item);
      items.push({ item, expected, chosen: distinct.join('/') || null, status: 'unclear', how: distinct.length > 1 ? 'overwrite' : 'unreadable' });
      continue;
    }
    items.push({ item, expected, chosen, status: chosen === expected ? 'correct' : 'incorrect', how });
  }
  const marks = Math.round(items.filter((row) => row.status === 'correct').length * perItem * 100) / 100;
  return { marks, perItem, items, unclear };
}

/**
 * The block's result in the grader's JSON shape, so it goes through the same
 * normalisation, storage and report code as a model grade.
 */
export function mcqBlockGradeJson(result, { criterionId = 'each_correct_option' } = {}) {
  const correct = result.items.filter((row) => row.status === 'correct').map((row) => row.item);
  const wrong = result.items.filter((row) => row.status === 'incorrect');
  const blank = result.items.filter((row) => row.status === 'not_attempted').map((row) => row.item);
  const describeWrong = wrong.map((row) => `${row.item} (chose ${row.chosen}, answer ${row.expected})`).join(', ');
  const max = result.perItem * result.items.length;
  return {
    marks_awarded: result.marks,
    criteria: [{ id: criterionId, max, marks: result.marks, note: `${correct.length} of ${result.items.length} options correct.` }],
    parts: result.items.map((row) => ({
      label: String(row.item),
      prompt: '',
      response: row.chosen ? `(${row.chosen})` : '',
      expected: `(${row.expected})`,
      marks_obtained: row.status === 'correct' ? result.perItem : 0,
      marks_total: result.perItem,
      status: row.status === 'unclear' ? 'incorrect' : row.status,
    })),
    confidence: result.unclear.length ? 'low' : 'high',
    needs_review: result.unclear.length > 0,
    review_reasons: result.unclear.length ? [MCQ_LETTER_UNCLEAR_TAG] : [],
    what_went_correct: correct.length ? `Correct options: ${correct.join(', ')}.` : '',
    needs_attention: [
      describeWrong ? `Incorrect: ${describeWrong}.` : '',
      blank.length ? `Not answered: ${blank.join(', ')}.` : '',
      result.unclear.length ? `The chosen option could not be read for ${result.unclear.join(', ')}; the teacher will check.` : '',
    ].filter(Boolean).join(' '),
    next_step: '',
    grading_reasoning: `Marked option by option against the answer key (${result.perItem} mark each).`,
  };
}
