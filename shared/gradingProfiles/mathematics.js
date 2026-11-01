export default {
  id: 'mathematics',
  label: 'Mathematics',
  match: /math/i,
  rules: [
    'MATHEMATICS: Award each method and answer mark the rubric lists on its own. A later step done correctly from an earlier wrong value keeps its method marks when the rubric gives method marks.',
    'Accept any mathematically equivalent final answer (equivalent fractions, decimals, surd or factorised forms) unless the question asks for a specific form.',
    'Read OCR maths carefully: one misread symbol changes the answer. If a step is unreadable, award only what you can read and set needs_review to true.',
  ],
};
