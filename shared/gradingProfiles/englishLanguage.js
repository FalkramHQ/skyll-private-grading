import { LANGUAGE_ITEM_RULES } from './languageRules.js';

export default {
  id: 'english_language',
  label: 'English Language',
  match: /english|\beng\b/i,
  rules: [
    ...LANGUAGE_ITEM_RULES,
    'COMPOSITION AND LETTERS: Mark only against the rubric\'s own criteria (content, organisation, expression, format); do not deduct for a point the rubric does not name.',
  ],
};
