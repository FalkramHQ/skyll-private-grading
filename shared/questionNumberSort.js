/**
 * Natural question-number ordering for review queues and reports.
 * Handles: Q1, Q10, Q1A(i), Q1B(ii), Q2.A1, Q2.A4(i), Q5A, Q1.A(1), Q3(1)
 * Order: Q number → letter section (A/B) → numeric part (A1/A2) → roman/paren sub-part
 */

const ROMAN = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12,
};

export function parseQuestionNumber(qn) {
  const s = String(qn || '').trim();
  const m = s.match(/^Q?(\d+)(?:[.\s_-]*([A-Za-z]))?(.*)$/i);
  if (!m) {
    const fallback = s.match(/(\d+)/);
    return { q: fallback ? parseInt(fallback[1], 10) : 0, sec: 0, part: 0, sub: 0 };
  }
  const q = parseInt(m[1], 10);
  const sec = m[2] ? m[2].toUpperCase().charCodeAt(0) : 0;
  const rest = m[3] || '';
  const partMatch = rest.match(/^(\d+)/);
  const part = partMatch ? parseInt(partMatch[1], 10) : 0;
  let sub = 0;
  for (const token of [...rest.matchAll(/\(([^)]+)\)/g)].map((match) => match[1].toLowerCase())) {
    if (ROMAN[token] !== undefined) { sub = ROMAN[token]; break; }
    if (/^\d+$/.test(token)) { sub = parseInt(token, 10); break; }
    if (token.length === 1) { sub = token.charCodeAt(0); break; }
  }
  return { q, sec, part, sub };
}

export function compareQuestionNumbers(a, b) {
  const left = typeof a === 'string' || typeof a === 'number' ? a : a?.questionNumber ?? a?.question_number ?? a?.number;
  const right = typeof b === 'string' || typeof b === 'number' ? b : b?.questionNumber ?? b?.question_number ?? b?.number;
  const pa = parseQuestionNumber(left);
  const pb = parseQuestionNumber(right);
  if (pa.q !== pb.q) return pa.q - pb.q;
  if (pa.sec !== pb.sec) return pa.sec - pb.sec;
  if (pa.part !== pb.part) return pa.part - pb.part;
  return pa.sub - pb.sub;
}

export function sortByQuestionNumber(items = [], getNumber = (item) => item) {
  return [...items].sort((a, b) => compareQuestionNumbers(getNumber(a), getNumber(b)));
}
