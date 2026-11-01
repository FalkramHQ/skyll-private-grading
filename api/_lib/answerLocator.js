/**
 * Locate each extracted answer on the student's answer-sheet pages (#342).
 *
 * `evidence_json.source_pages` is unusable (#343), but `student_answer` is
 * copied verbatim from OCR, so the page whose OCR text contains the start of
 * the answer is where the student wrote it. Pure: callers load the data.
 */

// Short needles ("a", "kg") appear on most pages, so they only count when
// prefixed with the question label the student wrote ("iv a", "2 5 kg").
const MIN_UNLABELLED_NEEDLE_CHARS = 4;
const NEEDLE_WORD_COUNTS = [8, 5, 3, 2];

/**
 * Lowercase, script-agnostic word stream: letters, digits and combining marks
 * in any script survive (Devanagari matras are marks), while HTML tags, LaTeX
 * commands and punctuation collapse to single spaces.
 */
export function normalizeAnswerText(value) {
  return ` ${String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/\\[a-z]+/g, ' ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()} `;
}

function labelTokens(questionNumber) {
  return String(questionNumber || '')
    .replace(/^\s*q\.?/i, '')
    .toLowerCase()
    .match(/\d+|\p{L}+/gu) || [];
}

function needlesFor(answer, questionNumber) {
  const words = answer.trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const labels = labelTokens(questionNumber);
  const labelPrefixes = [...new Set([labels.slice(-1).join(' '), labels.join(' ')])].filter(Boolean);
  const needles = [];
  for (const count of NEEDLE_WORD_COUNTS) {
    const needle = words.slice(0, count).join(' ');
    if (needles.includes(needle)) continue;
    if (needle.length >= MIN_UNLABELLED_NEEDLE_CHARS) needles.push(needle);
    else needles.push(...labelPrefixes.map((prefix) => `${prefix} ${needle}`));
  }
  return [...new Set(needles)];
}

function occurrencesOf(needle, pages) {
  const padded = ` ${needle} `;
  const hits = [];
  pages.forEach((text, index) => {
    const at = text.indexOf(padded);
    if (at < 0) return;
    hits.push({ page: index + 1, offset: Math.min(1, Math.max(0, at / Math.max(1, text.length))) });
  });
  return hits;
}

function firstHitsFor(needles, pages) {
  for (const needle of needles) {
    const hits = occurrencesOf(needle, pages);
    if (hits.length) return hits;
  }
  return [];
}

const before = (a, b) => a.page < b.page || (a.page === b.page && a.offset <= b.offset);

// Several pages match: students mostly answer in order, so take the first
// hit at or after the previous located answer and not after the next one.
// When every hit lies outside its neighbours the text is not a reliable
// anchor (often a phrase reused elsewhere), so leave it for the inferred pass.
function pickAmbiguous(hits, previous, next) {
  return hits.find((hit) => (!previous || before(previous, hit)) && (!next || hit.page <= next.page)) || null;
}

/**
 * @param {{ pages: string[], questions: { id?: string, questionNumber: string, answer: string }[] }} input
 *   `pages` is raw OCR text per sheet page in display order (page 1 first);
 *   `questions` must already be in paper order.
 * @returns {{ id?: string, questionNumber: string, answered: boolean, page: number|null, offset: number|null,
 *   match: 'unique'|'ambiguous'|'inferred'|'none' }[]}
 */
export function locateAnswers({ pages = [], questions = [] }) {
  const pageText = pages.map(normalizeAnswerText);
  const rows = questions.map((question) => {
    const answer = normalizeAnswerText(question.answer);
    const answered = answer.trim().length > 0;
    const hits = answered && pageText.length ? firstHitsFor(needlesFor(answer, question.questionNumber), pageText) : [];
    return { question, answered, hits, located: null, match: 'none' };
  });

  // Unique matches first: they anchor the ambiguous and inferred passes.
  for (const row of rows) {
    if (row.hits.length && new Set(row.hits.map((hit) => hit.page)).size === 1) {
      row.located = row.hits[0];
      row.match = 'unique';
    }
  }
  rows.forEach((row, index) => {
    if (row.located || !row.hits.length) return;
    const previous = rows.slice(0, index).reverse().find((candidate) => candidate.located)?.located;
    const next = rows.slice(index + 1).find((candidate) => candidate.match === 'unique')?.located;
    row.located = pickAmbiguous(row.hits, previous, next);
    if (row.located) row.match = 'ambiguous';
  });
  // Blank or unmatched: point at the gap between the located neighbours. On
  // one page that is where the next answer starts (the scroll margin shows
  // the end of the previous one); across pages it is the top of the later
  // page, which the panel shows together with the end of the earlier one.
  const anchors = rows.map((row) => row.located);
  rows.forEach((row, index) => {
    if (row.located) return;
    const next = anchors.slice(index + 1).find(Boolean);
    const previous = anchors.slice(0, index).reverse().find(Boolean);
    const anchor = next && previous && previous.page < next.page
      ? { page: next.page, offset: 0 }
      : next || previous;
    if (!anchor) return;
    row.located = anchor;
    row.match = 'inferred';
  });

  return rows.map(({ question, answered, located, match }) => ({
    ...(question.id ? { id: question.id } : {}),
    questionNumber: question.questionNumber,
    answered,
    page: located?.page ?? null,
    offset: located ? Math.round(located.offset * 1000) / 1000 : null,
    match,
  }));
}
