import { LANGUAGE_ITEM_RULES } from './languageRules.js';

export default {
  id: 'german',
  label: 'German',
  match: /german|deutsch/i,
  rules: [
    ...LANGUAGE_ITEM_RULES,
    'GERMAN GRAMMAR: in a subordinate clause (weil, dass, wenn, ob, als, obwohl, damit, nachdem, bevor) the conjugated verb comes last ("…, weil ich sehr müde bin" and "…, dass der Kurs interessant ist" are correct word order). After a fronted adverb (trotzdem, deshalb, darum, dann, deswegen) the verb comes second, then the subject ("Trotzdem macht er seine Hausaufgaben"). A wrong verb form (e.g. "durftet" for "durfte") is a verb-form error, not a spelling slip.',
    'WORD-ORDER ITEMS: the word-order mark is earned when the conjugated verb is in the right position, even when the comma is missing or misplaced ("Er meint dass, der Kurs interessant ist"), a full stop or comma follows the conjunction, or a noun is not capitalised. Teachers mark these 1 (Oct 2026 evaluation).',
    'When the rubric gives 2 marks for one sentence and lists no smaller band, a sentence whose structure is right but has one wrong verb ending or form ("Er durftet als Kind allein reisen") earns 1 of the 2.',
  ],
};
