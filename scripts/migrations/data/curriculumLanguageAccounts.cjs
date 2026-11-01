/**
 * Seed catalogue: ICSE English/Hindi 10 + CBSE/ICSE Accounts foundations
 * for live PartnerD + Partner Academy C cohorts.
 */

function entry(board, grade, subject, slug, topic, subTopics, difficultyWeight = 0.5) {
  const boardKey = String(board).toLowerCase();
  const gradeKey = String(grade).replace(/[^0-9]/g, '') || 'x';
  const subjectKey = String(subject).toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return {
    id: `${boardKey}_${gradeKey}_${subjectKey}_${slug}`,
    board,
    grade,
    subject,
    topic,
    subTopics,
    difficultyWeight,
  };
}

const ICSE_ENGLISH_10 = [
  entry('ICSE', '10th', 'English', 'notice', 'Notice Writing', ['formal notice', 'charity / event notices'], 0.4),
  entry('ICSE', '10th', 'English', 'email', 'Email Writing', ['formal email', 'request letters'], 0.45),
  entry('ICSE', '10th', 'English', 'letter', 'Letter Writing', ['formal letter', 'informal letter'], 0.45),
  entry('ICSE', '10th', 'English', 'tenses', 'Tenses / Verb Forms', ['correct form of the verb', 'sequence of tenses'], 0.55),
  entry('ICSE', '10th', 'English', 'prepositions', 'Prepositions', ['fill in the blanks', 'phrasal verbs'], 0.5),
  entry('ICSE', '10th', 'English', 'joining', 'Joining Sentences', ['synthesis', 'without and/but'], 0.5),
  entry('ICSE', '10th', 'English', 'transformation', 'Transformation of Sentences', ['voice', 'narration', 'degrees'], 0.55),
  entry('ICSE', '10th', 'English', 'comprehension', 'Comprehension', ['unseen passage', 'vocabulary'], 0.5),
  entry('ICSE', '10th', 'English', 'composition', 'Composition', ['essay', 'story writing'], 0.55),
];

  // Prefer exact Devanagari / short Hindi section labels over English gloss.
  const ICSE_HINDI_10 = [
  entry('ICSE', '10th', 'Hindi', 'gadya', 'गद्य', ['गद्य (Prose)', 'अपठित गद्यांश', 'कृति', 'prose'], 0.5),
  entry('ICSE', '10th', 'Hindi', 'padya', 'पद्य', ['पद्य (Poetry)', 'भावार्थ', 'प्रवाह तालिका', 'poetry'], 0.5),
  entry('ICSE', '10th', 'Hindi', 'purak', 'पूरक पठन', ['पाठ आधारित प्रश्न', 'पर्याय', 'supplementary'], 0.45),
  entry('ICSE', '10th', 'Hindi', 'vyakaran', 'व्याकरण', ['क्रिया', 'प्रेरणार्थक', 'वचन', 'विलोम', 'grammar'], 0.55),
  entry('ICSE', '10th', 'Hindi', 'upyogit', 'उपयोजित विभाग', ['कहानी लेखन', 'कहावत', 'applied writing'], 0.5),
  entry('ICSE', '10th', 'Hindi', 'patra', 'पत्र लेखन', ['औपचारिक पत्र', 'letter writing'], 0.4),
];

const ACCOUNTS_FOUNDATIONS = [
  entry('CBSE', '11th', 'Accounts', 'journal', 'Journal Entries', ['debit credit', 'narration'], 0.5),
  entry('CBSE', '11th', 'Accounts', 'ledger', 'Ledger Posting', ['balancing accounts'], 0.5),
  entry('CBSE', '11th', 'Accounts', 'trial_balance', 'Trial Balance', ['errors', 'suspense'], 0.55),
  entry('CBSE', '11th', 'Accounts', 'cash_book', 'Cash Book / Bank', ['petty cash', 'bank reconciliation'], 0.5),
  entry('CBSE', '11th', 'Accounts', 'bills', 'Bills of Exchange', ['acceptance', 'dishonour'], 0.55),
  entry('CBSE', '11th', 'Accounts', 'depreciation', 'Depreciation', ['straight line', 'written down'], 0.55),
  entry('CBSE', '11th', 'Accounts', 'final_accounts', 'Final Accounts', ['trading', 'P&L', 'balance sheet'], 0.6),
  entry('CBSE', '11th', 'Accounts', 'rectification', 'Rectification of Errors', ['errors of omission', 'commission'], 0.55),
  entry('CBSE', '12th', 'Accounts', 'partnership_basics', 'Partnership Fundamentals', ['fixed capital', 'fluctuating capital', 'interest on capital', 'interest on drawings', 'current account'], 0.55),
  entry('CBSE', '12th', 'Accounts', 'profit_sharing', 'Profit Sharing / Gaining Ratio', ['gaining ratio', 'sacrificing ratio', 'new ratio'], 0.55),
  entry('CBSE', '12th', 'Accounts', 'admission', 'Admission of a Partner', ['goodwill', 'revaluation', 'capital adjustment'], 0.6),
  entry('CBSE', '12th', 'Accounts', 'retirement', 'Retirement / Death of a Partner', ['gaining ratio', 'executor account'], 0.6),
  entry('CBSE', '12th', 'Accounts', 'dissolution', 'Dissolution of Partnership', ['realisation account', 'settlement'], 0.6),
  entry('ICSE', '10th', 'Accounts', 'journal', 'Journal Entries', ['double entry'], 0.5),
  entry('ICSE', '10th', 'Accounts', 'ledger', 'Ledger Accounts', ['personal real nominal'], 0.5),
  entry('ICSE', '10th', 'Accounts', 'trial_balance', 'Trial Balance', ['agreement'], 0.5),
  entry('ICSE', '10th', 'Accounts', 'final_accounts', 'Final Accounts of Sole Trader', ['trading account', 'balance sheet'], 0.6),
  entry('ICSE', '10th', 'Accounts', 'bank_recon', 'Bank Reconciliation Statement', ['cheques', 'bank charges'], 0.55),
  entry('ICSE', '10th', 'Accounts', 'depreciation', 'Depreciation', ['methods'], 0.55),
  entry('ICSE', '10th', 'Accounts', 'partnership', 'Partnership Accounts', ['interest on capital', 'interest on drawings', 'fixed capital', 'fluctuating capital', 'gaining ratio'], 0.55),
];

const LANGUAGE_ACCOUNTS_CURRICULUM_SEED = [
  ...ICSE_ENGLISH_10,
  ...ICSE_HINDI_10,
  ...ACCOUNTS_FOUNDATIONS,
];

module.exports = {
  LANGUAGE_ACCOUNTS_CURRICULUM_SEED,
  ICSE_ENGLISH_10,
  ICSE_HINDI_10,
  ACCOUNTS_FOUNDATIONS,
};
