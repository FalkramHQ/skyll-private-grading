// Independent key check (grading fix plan, phase 1b).
//
// A model from a different family than the one that built the rubric answers each
// checkable question from the question paper alone, without seeing the key. A second
// call compares those answers with the key and says which side looks right. MCQ letters
// and single values are compared in code first. Findings that need an admin decision are
// written onto the question as key_check.status = 'open', and the rubric gate blocks
// approval until each is resolved in Rubric Review (keep the key, accept the checker's
// answer as an alternative, or correct the key).
//
// Verdicts:
//   agree        key and independent answer match
//   disagree     they differ; opened only when the comparison judges the independent
//                answer right ("both acceptable" is recorded, not opened)
//   alternative  MCQ: another printed option is also correct; opened
//   unsupported  the paper does not contain what the key states; a warning only, since
//                literature questions are answered from the textbook, not the paper
//   unsure       could not decide (missing figure, garbled text, no answer)
//
// Measured on 47 tests (770 questions), this policy caught 13 of 23 adjudicated wrong
// keys and opened 19 other findings, about half of them real key problems.
import { keyOptionLetter, normalizeQuestionNumber } from '../../shared/rubricGate.js';

/** Response types with a single checkable answer; long answers, essays and drawings are skipped. */
export const KEY_CHECK_TYPES = new Set(['mcq', 'numerical', 'short_answer']);
const CHUNK = 15;

// Open-ended prompts have no single right answer to check against.
const OPEN_ENDED = /\b(?:make|frame|write|use)\b[^.?]{0,40}\bsentences?\b|in your own words|give (?:your|an) (?:own )?(?:example|opinion)|express your|write a (?:letter|paragraph|story|notice|email)|वाक्य (?:बनाइए|बनाओ|में प्रयोग)|अपने शब्दों में/i;

export function keyCheckCandidates(rubric) {
  return (rubric.questions || []).filter((q) => KEY_CHECK_TYPES.has(String(q.expected_response_type || '').toLowerCase())
    && String(q.correct_answer_summary || '').trim()
    && !OPEN_ENDED.test(String(q.question_text || '')));
}

/** Which family checks a rubric: never the one that built it. */
export function checkerFamily(builderModel = '') {
  return /qwen/i.test(String(builderModel)) ? 'deepseek' : 'qwen';
}

export function buildAnswerPrompt({ paperText, questions }) {
  const list = questions.map((q) => `- ${q.number} (${q.marks_allocated} marks, ${q.expected_response_type}): ${q.question_text}`).join('\n');
  return `You are checking an exam answer key. Answer each listed question yourself, as a careful subject teacher, using only the question paper below. You have not seen the answer key.
- MCQ: give the option letter and its text, and list in all_correct_options every printed option that is correct (usually one).
- Numerical: give the final value with units.
- Short answer: give the expected answer in one sentence.
- If you cannot answer, set answerable to false and why_not to "not_in_paper" when the paper itself does not contain the information the question needs, or "missing_or_garbled" when a passage, figure or the question text seems missing or unreadable.
Use the question numbers exactly as listed.
Return JSON only: {"answers":[{"number":"","answer":"","all_correct_options":[],"answerable":true,"why_not":"","confidence":"high|medium|low"}]}

QUESTIONS TO ANSWER:
${list}

QUESTION PAPER:
${paperText}`;
}

export function buildComparePrompt({ items }) {
  const list = items.map((item) => `- ${item.number}\n  Question: ${item.question_text}\n  Answer key: ${item.key}\n  Independent answer: ${item.checker}`).join('\n');
  return `For each question, decide whether the answer key and the independent answer agree on the substance: the same option, the same value within rounding, or the same meaning in different words. When they disagree, judge as a subject expert which one is correct: "key", "independent", "both" (both acceptable) or "unclear". Explain in one short sentence. Use the question numbers exactly as listed.
Return JSON only: {"verdicts":[{"number":"","verdict":"agree|disagree|unsure","likely_correct":"key|independent|both|unclear","note":""}]}

${list}`;
}

const byNumber = (rows = []) => new Map(rows
  .filter((row) => row && row.number != null)
  .map((row) => [normalizeQuestionNumber(row.number), row]));

/** Option letter at the start of an answer ("d NiO", "(d) 14 amu", "D) volt"), or null. */
export function answerLetter(answer) {
  return keyOptionLetter(answer) || (String(answer || '').trim().match(/^([a-dA-D])\b/) || [])[1]?.toLowerCase() || null;
}

/** The single number in an answer, ignoring a trailing unit; null when there is not exactly one. */
export function singleValue(answer) {
  const numbers = String(answer || '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?(?:\s*[x×]\s*10\^?\s*-?\d+|e-?\d+)?/gi) || [];
  if (numbers.length !== 1) return null;
  const sci = numbers[0].match(/^(-?\d+(?:\.\d+)?)\s*[x×]\s*10\^?\s*(-?\d+)$/i);
  const value = sci ? Number(sci[1]) * 10 ** Number(sci[2]) : Number(numbers[0]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Settle what code can settle. Returns 'agree', 'disagree' or null (leave to the model).
 * MCQ: compare option letters. Numerical: equal single values within 2% agree; different
 * values are left to the model, since unit or format differences are common.
 */
export function codeVerdict(question, checkerAnswer) {
  const type = String(question.expected_response_type || '').toLowerCase();
  if (type === 'mcq') {
    const key = answerLetter(question.correct_answer_summary);
    const checker = answerLetter(checkerAnswer);
    if (key && checker) return key === checker ? 'agree' : 'disagree';
    return null;
  }
  if (type === 'numerical') {
    const key = singleValue(question.correct_answer_summary);
    const checker = singleValue(checkerAnswer);
    if (key != null && checker != null && Math.abs(key - checker) <= Math.max(Math.abs(key), Math.abs(checker)) * 0.02) return 'agree';
  }
  return null;
}

/** Combine the checker's answer, the code verdict and the model's comparison into one finding. */
export function classify(question, answer = {}, compared = {}) {
  const checkerAnswer = String(answer.answer || '').trim() || '(no answer)';
  if (answer.answerable === false) {
    return answer.why_not === 'not_in_paper'
      ? { verdict: 'unsupported', likelyCorrect: 'unclear', checkerAnswer, note: 'The paper does not seem to contain what the key states.' }
      : { verdict: 'unsure', likelyCorrect: 'unclear', checkerAnswer, note: 'A passage, figure or the question text seems missing or unreadable.' };
  }
  if (checkerAnswer === '(no answer)') return { verdict: 'unsure', likelyCorrect: 'unclear', checkerAnswer, note: 'No independent answer was returned.' };

  const keyLetter = String(question.expected_response_type || '').toLowerCase() === 'mcq' ? answerLetter(question.correct_answer_summary) : null;
  const allCorrect = (Array.isArray(answer.all_correct_options) ? answer.all_correct_options : [])
    .map((option) => answerLetter(option) || String(option).trim().toLowerCase()).filter(Boolean);
  const byCode = codeVerdict(question, checkerAnswer);
  const verdict = byCode || (['agree', 'disagree', 'unsure'].includes(compared.verdict) ? compared.verdict : 'unsure');
  const likelyCorrect = ['key', 'independent', 'both', 'unclear'].includes(compared.likely_correct) ? compared.likely_correct : 'unclear';
  const note = String(compared.note || '').slice(0, 300);

  if (verdict === 'agree' && keyLetter && allCorrect.length > 1 && allCorrect.includes(keyLetter)) {
    const others = allCorrect.filter((letter) => letter !== keyLetter);
    return { verdict: 'alternative', likelyCorrect: 'both', checkerAnswer: `Also correct: option ${others.join(', ')}`, note: note || 'More than one printed option looks correct.' };
  }
  return { verdict, likelyCorrect, checkerAnswer, note };
}

/** Whether a finding needs an admin decision before grading. */
export function needsDecision(finding) {
  if (finding.verdict === 'alternative') return true;
  return finding.verdict === 'disagree' && finding.likelyCorrect === 'independent';
}

/**
 * Run the check. `callJson(prompt, maxTokens)` must call the checker model and resolve to {value, model}.
 * @returns {Promise<{model: string|null, ranAt: string, items: object[]}>}
 */
export async function runKeyCheck({ rubric, paperText, callJson, now = () => new Date().toISOString() }) {
  const candidates = keyCheckCandidates(rubric);
  const items = [];
  let model = null;
  const answerChunk = async (chunk) => {
    const response = await callJson(buildAnswerPrompt({ paperText, questions: chunk }), 8000);
    model = response.model || model;
    return byNumber(response.value?.answers);
  };
  for (let start = 0; start < candidates.length; start += CHUNK) {
    const chunk = candidates.slice(start, start + CHUNK);
    const answers = await answerChunk(chunk);
    // One retry for answers the model dropped (truncation or renumbering).
    const missing = chunk.filter((q) => !answers.has(normalizeQuestionNumber(q.number)));
    if (missing.length) {
      for (const [key, value] of await answerChunk(missing)) answers.set(key, value);
    }
    const answerOf = (q) => answers.get(normalizeQuestionNumber(q.number)) || {};
    const toCompare = chunk.filter((q) => answerOf(q).answerable !== false && String(answerOf(q).answer || '').trim());
    let verdicts = new Map();
    if (toCompare.length) {
      const compared = await callJson(buildComparePrompt({ items: toCompare.map((q) => ({
        number: q.number, question_text: q.question_text, key: q.correct_answer_summary, checker: String(answerOf(q).answer),
      })) }), 6000);
      verdicts = byNumber(compared.value?.verdicts);
    }
    for (const q of chunk) {
      const finding = classify(q, answerOf(q), verdicts.get(normalizeQuestionNumber(q.number)) || {});
      items.push({ question: q.number, confidence: String(answerOf(q).confidence || 'low'), ...finding });
    }
  }
  return { model, ranAt: now(), items };
}

/**
 * Write a key-check result onto the rubric: one key_check per checked question and a
 * summary on the package. Only findings that need a decision are opened.
 */
export function applyKeyCheck(rubric, result) {
  const byQuestion = new Map(result.items.map((item) => [normalizeQuestionNumber(item.question), item]));
  const questions = (rubric.questions || []).map((q) => {
    const item = byQuestion.get(normalizeQuestionNumber(q.number));
    if (!item) return q;
    return {
      ...q,
      key_check: {
        verdict: item.verdict,
        likely_correct: item.likelyCorrect,
        checker_answer: item.checkerAnswer,
        note: item.note,
        status: needsDecision(item) ? 'open' : 'none',
      },
    };
  });
  const count = (verdict) => result.items.filter((item) => item.verdict === verdict).length;
  return {
    ...rubric,
    questions,
    key_check: {
      model: result.model,
      ran_at: result.ranAt,
      checked: result.items.length,
      open: result.items.filter(needsDecision).length,
      disagreements: count('disagree'),
      unsupported: count('unsupported'),
      alternatives: count('alternative'),
      unsure: count('unsure'),
    },
  };
}
