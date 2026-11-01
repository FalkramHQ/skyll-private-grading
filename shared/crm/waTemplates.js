// Skyll's WhatsApp message templates (CRM M2 phase 2, D3/D6), stored as
// versioned data. Meta approves each one per class number, in English and
// Hindi. Blanks are numbered in the order they appear, per language, and are
// filled only from the allowlist below (never notes, reasons or staff names).
// Changing wording means a new `version` (a new Meta template name), so the
// approved old one keeps working until the new one is approved.

export const WA_LANGUAGES = Object.freeze(['en', 'hi']);
export const WA_LANGUAGE_LABELS = Object.freeze({ en: 'English', hi: 'हिन्दी (Hindi)' });

// The only values that may fill a blank (CRM-020: approved variables only).
export const WA_VARIABLES = Object.freeze({
  guardianName: { maxLength: 60, example: 'Kavita Sharma' },
  senderName: { maxLength: 60, example: 'Sharma Classes, Andheri' },
  studentName: { maxLength: 80, example: 'Arjun' },
  amount: { maxLength: 20, example: '12,000' },
  itemLabel: { maxLength: 80, example: 'Instalment 2' },
  dueDate: { maxLength: 30, example: '17 Jan 2027' },
  overdueDetail: { maxLength: 100, example: 'due on 17 Jan 2027' },
  paymentInstructions: { maxLength: 200, example: 'Pay by UPI to sharmaclasses@okhdfc' },
  contactLine: { maxLength: 120, example: '98200 00000 (office, 10 am to 6 pm)' },
  paymentDate: { maxLength: 30, example: '14 Jan 2027' },
  receiptNumber: { maxLength: 40, example: 'SDS/RCP/2026-27/0004' },
  balanceDue: { maxLength: 20, example: '0' },
  assessmentTitle: { maxLength: 80, example: 'Unit Test 2' },
  className: { maxLength: 80, example: 'Grade 10 Maths' },
  when: { maxLength: 60, example: '21 Oct 2026, 5:00 pm' },
  newWhen: { maxLength: 60, example: '23 Oct 2026, 5:00 pm' },
  dates: { maxLength: 60, example: '1 Nov 2026' },
  occasion: { maxLength: 40, example: 'Diwali' },
  item: { maxLength: 60, example: 'a geometry box' },
});

// Used when a class leaves a detail empty (Meta rejects empty blanks).
export const WA_DEFAULTS = Object.freeze({
  en: {
    guardianName: 'Parent',
    paymentInstructions: 'Please pay at the class office.',
    contactLine: 'reply to this message',
  },
  hi: {
    guardianName: 'अभिभावक',
    paymentInstructions: 'कृपया क्लास ऑफ़िस में भुगतान करें।',
    contactLine: 'इस संदेश का जवाब दें',
  },
});

const feesButton = { kind: 'fees', path: '/f/', text: { en: 'View fees', hi: 'फ़ीस देखें' } };
const reportButton = { kind: 'report', path: '/r/', text: { en: 'View report', hi: 'रिपोर्ट देखें' } };

export const WA_TEMPLATES = Object.freeze({
  fee_due: {
    version: 2,
    label: 'Fee due soon',
    finance: true,
    button: feesButton,
    en: {
      body: 'Hello {{1}}, this is a fee reminder from {{2}}. ₹{{3}} for {{4}} ({{5}}) is due on {{6}}.\n\nHow to pay: {{7}}\nContact: {{8}}\n\nThank you.',
      variables: ['guardianName', 'senderName', 'amount', 'studentName', 'itemLabel', 'dueDate', 'paymentInstructions', 'contactLine'],
    },
    hi: {
      body: 'नमस्ते {{1}}, {{2}} की ओर से फ़ीस रिमाइंडर: {{3}} ({{4}}) के ₹{{5}} के भुगतान की अंतिम तिथि {{6}} है।\n\nभुगतान कैसे करें: {{7}}\nसंपर्क: {{8}}\n\nधन्यवाद।',
      variables: ['guardianName', 'senderName', 'studentName', 'itemLabel', 'amount', 'dueDate', 'paymentInstructions', 'contactLine'],
    },
  },
  fee_overdue: {
    version: 2,
    label: 'Fee overdue',
    finance: true,
    button: feesButton,
    en: {
      body: 'Hello {{1}}, this is a gentle reminder from {{2}}. The fee of ₹{{3}} for {{4}} is now overdue ({{5}}). Please clear it at the earliest.\n\nHow to pay: {{6}}\nFor any questions, contact: {{7}}\n\nThank you.',
      variables: ['guardianName', 'senderName', 'amount', 'studentName', 'overdueDetail', 'paymentInstructions', 'contactLine'],
    },
    hi: {
      body: 'नमस्ते {{1}}, {{2}} की ओर से सूचना: {{3}} के ₹{{4}} का भुगतान बाकी है ({{5}})।\n\nभुगतान कैसे करें: {{6}}\nसंपर्क: {{7}}\n\nधन्यवाद।',
      variables: ['guardianName', 'senderName', 'studentName', 'amount', 'overdueDetail', 'paymentInstructions', 'contactLine'],
    },
  },
  receipt: {
    version: 2,
    label: 'Payment receipt',
    finance: true,
    header: 'document',
    button: feesButton,
    en: {
      body: 'Hello {{1}}, thank you for your payment. {{2}} has received ₹{{3}} towards the fees for {{4}} on {{5}}. Your receipt number is {{6}}, and a copy of the receipt is attached to this message.\n\nBalance still due: ₹{{7}}. Thank you.',
      variables: ['guardianName', 'senderName', 'amount', 'studentName', 'paymentDate', 'receiptNumber', 'balanceDue'],
    },
    hi: {
      body: 'नमस्ते {{1}}, {{2}} को {{3}} के लिए {{4}} को ₹{{5}} प्राप्त हुए। रसीद संख्या {{6}} संलग्न है।\n\nशेष देय राशि: ₹{{7}}। धन्यवाद।',
      variables: ['guardianName', 'senderName', 'studentName', 'paymentDate', 'amount', 'receiptNumber', 'balanceDue'],
    },
  },
  report_ready: {
    version: 1,
    label: 'Report ready',
    button: reportButton,
    en: {
      body: 'Hello {{1}}, {{2}}’s report for {{3}} from {{4}} is ready. Tap View report below to see it.',
      variables: ['guardianName', 'studentName', 'assessmentTitle', 'senderName'],
    },
    hi: {
      body: 'नमस्ते {{1}}, {{2}} की {{3}} की रिपोर्ट {{4}} ने तैयार कर दी है। देखने के लिए नीचे रिपोर्ट देखें दबाएँ।',
      variables: ['guardianName', 'studentName', 'assessmentTitle', 'senderName'],
    },
  },
  absent: {
    version: 2,
    label: 'Absent today',
    en: {
      body: 'Hello {{1}}, this is a message from {{2}}. {{3}} was marked absent from {{4}} on {{5}}. If this is not correct, or if you would like to tell us the reason, please get in touch.\n\nContact: {{6}}\n\nThank you.',
      variables: ['guardianName', 'senderName', 'studentName', 'className', 'dates', 'contactLine'],
    },
    hi: {
      body: 'नमस्ते {{1}}, {{2}} की ओर से सूचना: {{3}} को {{4}} की {{5}} की कक्षा में अनुपस्थित दर्ज किया गया।\n\nसंपर्क: {{6}}\n\nधन्यवाद।',
      variables: ['guardianName', 'senderName', 'studentName', 'dates', 'className', 'contactLine'],
    },
  },
  notice_cancelled: {
    version: 1,
    label: 'Class cancelled',
    notice: true,
    fields: ['className', 'when'],
    en: {
      body: 'Hello {{1}}, this is {{2}}. The {{3}} class on {{4}} is cancelled.\n\nContact: {{5}}\n\nThank you.',
      variables: ['guardianName', 'senderName', 'className', 'when', 'contactLine'],
    },
    hi: {
      body: 'नमस्ते {{1}}, {{2}} की ओर से सूचना: {{3}} की {{4}} वाली कक्षा रद्द कर दी गई है।\n\nसंपर्क: {{5}}\n\nधन्यवाद।',
      variables: ['guardianName', 'senderName', 'className', 'when', 'contactLine'],
    },
  },
  notice_rescheduled: {
    version: 2,
    label: 'Class rescheduled',
    notice: true,
    fields: ['className', 'when', 'newWhen'],
    en: {
      body: 'Hello {{1}}, this is a message from {{2}}. Please note that the {{3}} class on {{4}} has been moved to {{5}}. We are sorry for any inconvenience this may cause.\n\nContact: {{6}}\n\nThank you.',
      variables: ['guardianName', 'senderName', 'className', 'when', 'newWhen', 'contactLine'],
    },
    hi: {
      body: 'नमस्ते {{1}}, {{2}} की ओर से सूचना: {{3}} की {{4}} वाली कक्षा अब {{5}} को होगी।\n\nसंपर्क: {{6}}\n\nधन्यवाद।',
      variables: ['guardianName', 'senderName', 'className', 'when', 'newWhen', 'contactLine'],
    },
  },
  notice_holiday: {
    version: 1,
    label: 'Holiday',
    notice: true,
    fields: ['dates', 'occasion'],
    en: {
      body: 'Hello {{1}}, this is {{2}}. Classes are closed on {{3}} for {{4}}.\n\nContact: {{5}}\n\nThank you.',
      variables: ['guardianName', 'senderName', 'dates', 'occasion', 'contactLine'],
    },
    hi: {
      body: 'नमस्ते {{1}}, {{2}} की ओर से सूचना: {{3}} के कारण {{4}} को कक्षाएँ बंद रहेंगी।\n\nसंपर्क: {{5}}\n\nधन्यवाद।',
      variables: ['guardianName', 'senderName', 'occasion', 'dates', 'contactLine'],
    },
  },
  notice_bring: {
    version: 2,
    label: 'Reminder to bring something',
    notice: true,
    fields: ['item', 'className', 'when'],
    en: {
      body: 'Hello {{1}}, this is a message from {{2}}. Please remind {{3}} to bring {{4}} to the {{5}} class on {{6}}. It will be needed during the class.\n\nContact: {{7}}\n\nThank you.',
      variables: ['guardianName', 'senderName', 'studentName', 'item', 'className', 'when', 'contactLine'],
    },
    hi: {
      body: 'नमस्ते {{1}}, {{2}} की ओर से सूचना: कृपया {{3}} को याद दिलाएँ कि {{4}} की {{5}} वाली कक्षा में {{6}} साथ लाएँ।\n\nसंपर्क: {{7}}\n\nधन्यवाद।',
      variables: ['guardianName', 'senderName', 'studentName', 'className', 'when', 'item', 'contactLine'],
    },
  },
});

export const WA_TEMPLATE_KEYS = Object.freeze(Object.keys(WA_TEMPLATES));
export const WA_NOTICE_KEYS = Object.freeze(WA_TEMPLATE_KEYS.filter((key) => WA_TEMPLATES[key].notice));

/** Meta's template name: `skyll_<key>_v<version>` (lowercase, underscores). */
export function metaTemplateName(key, version = WA_TEMPLATES[key]?.version) {
  return `skyll_${key}_v${version}`;
}

function clean(value, maxLength) {
  // WhatsApp rejects newlines, tabs and runs of 4+ spaces inside a parameter.
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * The ordered blank values for one template and language. Unknown keys are
 * ignored; empty class details fall back to WA_DEFAULTS; anything else that's
 * missing throws, so a message is never sent with an empty blank.
 */
export function templateValues(key, language, values = {}) {
  const definition = WA_TEMPLATES[key];
  const text = definition?.[language];
  if (!text) throw new Error(`Unknown template ${key}/${language}`);
  return text.variables.map((name) => {
    const rule = WA_VARIABLES[name];
    const value = clean(values[name], rule.maxLength) || WA_DEFAULTS[language][name] || '';
    if (!value) throw new Error(`Template ${key} needs ${name}`);
    return value;
  });
}

/** The message as the parent sees it (stored on the outbox row and shown on timelines). */
export function renderTemplate(key, language, values = {}) {
  const ordered = templateValues(key, language, values);
  return WA_TEMPLATES[key][language].body.replace(/\{\{(\d+)\}\}/g, (_, n) => ordered[Number(n) - 1]);
}

/** Meta's message_templates payload for submitting a template for approval. */
export function metaTemplatePayload(key, language, { baseUrl, headerHandle = null }) {
  const definition = WA_TEMPLATES[key];
  const text = definition[language];
  const components = [];
  if (definition.header === 'document') {
    components.push({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [headerHandle] } });
  }
  components.push({ type: 'BODY', text: text.body, example: { body_text: [text.variables.map((name) => WA_VARIABLES[name].example)] } });
  if (definition.button) {
    const url = `${baseUrl.replace(/\/$/, '')}${definition.button.path}`;
    components.push({ type: 'BUTTONS', buttons: [{ type: 'URL', text: definition.button.text[language], url: `${url}{{1}}`, example: [`${url}Xy7_example`] }] });
  }
  return { name: metaTemplateName(key, definition.version), language, category: 'UTILITY', components };
}

/** The `template` object of a send request. */
export function metaTemplateMessage(key, language, values, { linkToken = null, documentId = null, documentName = null } = {}) {
  const definition = WA_TEMPLATES[key];
  const components = [];
  if (definition.header === 'document') {
    if (!documentId) throw new Error(`Template ${key} needs its document`);
    components.push({ type: 'header', parameters: [{ type: 'document', document: { id: documentId, filename: documentName || 'document.pdf' } }] });
  }
  components.push({ type: 'body', parameters: templateValues(key, language, values).map((text) => ({ type: 'text', text })) });
  if (definition.button) {
    if (!linkToken) throw new Error(`Template ${key} needs its link`);
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: linkToken }] });
  }
  return { name: metaTemplateName(key, definition.version), language: { code: language }, components };
}

/**
 * Meta's formatting rules for template bodies, checked in tests: blanks are
 * numbered 1..n in order, never start or end the body, never sit side by
 * side, and there is enough fixed text around them.
 */
export function templateRuleProblems(body, variableCount) {
  const problems = [];
  const numbers = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  if (numbers.join(',') !== Array.from({ length: variableCount }, (_, i) => i + 1).join(',')) problems.push('blanks must be {{1}}..{{n}} in order, once each');
  if (/^\s*\{\{/.test(body)) problems.push('starts with a blank');
  if (/\}\}[\s.!?।]*$/.test(body)) problems.push('ends with a blank');
  if (/\}\}\s*\{\{/.test(body)) problems.push('two blanks side by side');
  // Meta refuses "too many variables for its length": every English template
  // with two or fewer words per blank was refused on 2026-10-28. Symbols like ₹ aren't words.
  const fixedWords = body.replace(/\{\{\d+\}\}/g, ' ').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  if (fixedWords <= variableCount * 2) problems.push('too little fixed text for the number of blanks');
  return problems;
}
