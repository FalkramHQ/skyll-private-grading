export default {
  id: 'geography',
  label: 'Geography',
  match: /geog|\bsst\b|social/i,
  rules: [
    'GEOGRAPHY: Accept standard alternative spellings and names of places (for example Wular / Jular Lake, Bengaluru / Bangalore) unless the question asks for a specific form.',
    'Map work is marked item by item from the visual evidence: each item earns its mark only when it is both named and placed in the right location.',
    'Grid references and other values read from a map must match the answer key exactly unless the rubric gives a range.',
    'For "give a reason" or "state two" items, each mark needs one distinct, geographically correct point; two wordings of the same point earn one mark, and a factually wrong point (for example a reversed monsoon direction) earns none.',
  ],
};
