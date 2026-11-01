import { locateAnswers } from '../../api/_lib/answerLocator.js';

const TEXT_MATCHES = new Set(['unique', 'ambiguous']);

/**
 * Set each answer's `sourcePages` to the 1-based answer-sheet page where its
 * text was found (#343). The model's own page numbers are always [0] (it never
 * sees page boundaries), so they are replaced, never trusted. Only real text
 * matches are stored: blanks, not-attempted answers and unmatched text get [].
 *
 * @param answers normalized evidence answers, in paper order
 * @param pages   OCR text per sheet page, in display (upload) order
 */
export function withSourcePages(answers, pages) {
  const located = locateAnswers({
    pages,
    questions: answers.map((answer) => ({
      questionNumber: String(answer.question?.number || answer.question_number || ''),
      answer: answer.attempted ? answer.studentAnswer : '',
    })),
  });
  return answers.map((answer, index) => {
    const location = located[index];
    return { ...answer, sourcePages: TEXT_MATCHES.has(location?.match) ? [location.page] : [] };
  });
}
