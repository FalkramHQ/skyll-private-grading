export default {
  id: 'english_literature',
  label: 'English Literature',
  // English Literature papers are often tagged plain "English"; the title decides.
  match: /literature/i,
  matchTitle: /literature/i,
  rules: [
    'ENGLISH LITERATURE: Judge each rubric point by substance, not wording. An answer that makes the rubric\'s point in the student\'s own words earns it; quoting the text is not required unless the question asks for a quotation.',
    'Names of characters, speakers and places, and who says what to whom, must be right: a reference-to-context answer that names the wrong speaker or moment earns nothing for that point.',
    'When the rubric lists several acceptable points ("any one of"), any one of them earns the mark; do not dock a mark for leaving out the others.',
    'Spelling, grammar and punctuation cost no marks in literature answers.',
  ],
};
