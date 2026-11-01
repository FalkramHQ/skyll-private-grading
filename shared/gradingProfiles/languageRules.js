// Shared by the language subjects (English Language, Hindi, German, ...).
// Measured Oct 2026 (scripts/evalGrading.mjs): the grader gave 0 to German
// "weil/dass" items whose clause and word order were right because of a comma
// or a capital letter the rubric does not assess.
export const LANGUAGE_ITEM_RULES = [
  'LANGUAGE ITEMS: Judge only the language point the rubric names (for example the conjunction, word order, verb form, tense, article or vocabulary).',
  'Capitalisation, punctuation (including where a comma goes) and spelling slips cost no marks unless the rubric explicitly assesses them; mention them in needs_attention only.',
];
