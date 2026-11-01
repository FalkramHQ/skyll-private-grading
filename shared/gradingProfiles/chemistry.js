export default {
  id: 'chemistry',
  label: 'Chemistry',
  match: /chem/i,
  rules: [
    'CHEMISTRY: Accept a correct formula or a correct name for a compound unless the question asks for one specifically; accept IUPAC and common names unless the question names one.',
    'An equation earns its balancing or condition marks only when the rubric lists them; an unbalanced but otherwise correct equation keeps the marks for reactants and products.',
    'Structures and mechanisms drawn as figures are marked only from the visual evidence.',
  ],
};
