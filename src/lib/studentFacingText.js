/**
 * Grader feedback is written about "the student". Reports show it to the
 * student, so it is turned into second person here, and sentences that only
 * state a rubric mark split ("Award 1 mark for …") are dropped.
 *
 * Whole sentences are dropped, never phrases inside them: cutting "1 mark for
 * stating a = 3." out of "The student earned 1 mark for stating a = 3." used to
 * leave "You earned" glued to the next sentence.
 */

// Sentences that are rubric bookkeeping rather than feedback.
const MARK_SPLIT_SENTENCE = [
  /^award\s+\d+(?:\.\d+)?\s+marks?\b/i,
  /^\d+(?:\.\d+)?\s+marks?\s+for\b/i,
  /^mark split\b/i,
  /^no\s+marks?\s+(?:awarded|given|allocated)\.?$/i,
  /^therefore,\s+none\s+of\s+them\s+are\s+valid\b/i,
];

// Third-person verbs the grader uses after "the student", in the form "you" takes.
const VERBS = {
  has: 'have', is: 'are', was: 'were', does: 'do', gives: 'give', uses: 'use', writes: 'write', shows: 'show',
  states: 'state', makes: 'make', needs: 'need', gets: 'get', applies: 'apply', earns: 'earn', omits: 'omit',
  confuses: 'confuse', reaches: 'reach', identifies: 'identify', sets: 'set', substitutes: 'substitute',
  finds: 'find', leaves: 'leave', recognises: 'recognise', recognizes: 'recognize', understands: 'understand',
  calculates: 'calculate', computes: 'compute', provides: 'provide', includes: 'include', attempts: 'attempt',
  forgets: 'forget', misses: 'miss', draws: 'draw', labels: 'label', selects: 'select', chooses: 'choose',
  demonstrates: 'demonstrate', explains: 'explain', obtains: 'obtain', arrives: 'arrive', fails: 'fail',
};
const ADVERBS = '(?:(?:also|then|only|correctly|incorrectly|clearly|partially|still|again|first|later|not)\\s+)*';
const AGREE = new RegExp(`\\b([Yy]ou)\\s+(${ADVERBS})(${Object.keys(VERBS).join('|')})\\b`, 'g');

function secondPerson(sentence) {
  return sentence
    .replace(/\b([Tt])he student['’]s\b/g, (_, t) => (t === 'T' ? 'Your' : 'your'))
    .replace(/\b([Tt])he student (answer|response|work|working|solution|attempt)\b/g, (_, t, noun) => `${t === 'T' ? 'Your' : 'your'} ${noun}`)
    .replace(/\b([Tt])he student\b/g, (_, t) => (t === 'T' ? 'You' : 'you'))
    .replace(/^Student['’]s\b/, 'Your')
    .replace(/^Student\b/, 'You')
    .replace(AGREE, (_, you, adverbs, verb) => `${you} ${adverbs}${VERBS[verb]}`);
}

/** Grader feedback as the student should read it. */
export function toStudentFacingText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !MARK_SPLIT_SENTENCE.some((pattern) => pattern.test(sentence.trim())))
    .map(secondPerson)
    .join(' ')
    .replace(/\bautopsy\b/gi, 'detailed breakdown')
    .replace(/\bmarking rubric\b/gi, 'the marking scheme')
    .replace(/\s+\./g, '.')
    .trim();
}
