// Skyll's WhatsApp templates follow Meta's formatting rules and fill only
// allowlisted variables (CRM M2 phase 2, D6; CRM-020).
import { describe, expect, it } from 'vitest';
import {
  WA_LANGUAGES, WA_TEMPLATES, WA_TEMPLATE_KEYS, WA_VARIABLES, metaTemplateMessage, metaTemplateName, metaTemplatePayload, renderTemplate,
  templateRuleProblems, templateValues,
} from '../../../shared/crm/waTemplates.js';

const sample = Object.fromEntries(Object.entries(WA_VARIABLES).map(([key, rule]) => [key, rule.example]));

describe('WhatsApp templates', () => {
  it('follow Meta’s formatting rules in every language', () => {
    for (const key of WA_TEMPLATE_KEYS) {
      for (const language of WA_LANGUAGES) {
        const text = WA_TEMPLATES[key][language];
        expect(templateRuleProblems(text.body, text.variables.length), `${key}/${language}`).toEqual([]);
        expect(text.variables.every((name) => WA_VARIABLES[name]), `${key}/${language} uses only allowlisted variables`).toBe(true);
      }
      // Both languages fill the same blanks, maybe in a different order.
      expect([...WA_TEMPLATES[key].en.variables].sort()).toEqual([...WA_TEMPLATES[key].hi.variables].sort());
      expect(metaTemplateName(key)).toMatch(/^skyll_[a-z_]+_v\d+$/);
    }
  });

  it('catches the rule breaks Meta rejects', () => {
    expect(templateRuleProblems('{{1}} is due', 1)).toContain('starts with a blank');
    expect(templateRuleProblems('Hello, the amount is {{1}}.', 1)).toContain('ends with a blank');
    expect(templateRuleProblems('Hello there {{1}} {{2}} and thank you very much', 2)).toContain('two blanks side by side');
    expect(templateRuleProblems('Hello there {{2}} and {{1}} thanks a lot today', 2)).toContain('blanks must be {{1}}..{{n}} in order, once each');
    // Meta refused these on 2026-10-28: two words per blank is too few, and ₹ isn't a word.
    expect(templateRuleProblems('Hello {{1}}, this is {{2}}. ₹{{3}} for {{4}} is now overdue.', 4)).toContain('too little fixed text for the number of blanks');
    expect(templateRuleProblems('Hello {{1}}, a reminder from {{2}}: ₹{{3}} is now overdue, thank you.', 3)).toEqual([]);
  });

  it('renders with class details, defaults and cleaned values', () => {
    const text = renderTemplate('fee_due', 'en', { ...sample, paymentInstructions: '', contactLine: undefined, guardianName: 'Kavita\nSharma' });
    expect(text).toBe('Hello Kavita Sharma, this is a fee reminder from Sharma Classes, Andheri. ₹12,000 for Arjun (Instalment 2) is due on 17 Jan 2027.\n\n'
      + 'How to pay: Please pay at the class office.\nContact: reply to this message\n\nThank you.');
    expect(renderTemplate('fee_due', 'hi', sample)).toContain('Arjun (Instalment 2) के ₹12,000 के भुगतान की अंतिम तिथि 17 Jan 2027 है।');
    expect(renderTemplate('absent', 'hi', { ...sample, guardianName: '' })).toMatch(/^नमस्ते अभिभावक,/);
  });

  it('never fills a blank from anything outside the allowlist, and refuses an empty required blank', () => {
    const values = templateValues('notice_cancelled', 'en', { ...sample, note: 'Internal: parent was rude', reason: 'secret' });
    expect(values.join(' ')).not.toMatch(/Internal|secret/);
    expect(() => templateValues('fee_due', 'en', { ...sample, amount: '' })).toThrow(/needs amount/);
    expect(templateValues('fee_due', 'en', { ...sample, itemLabel: 'x'.repeat(200) })[4]).toHaveLength(80);
  });

  it('builds Meta payloads with examples, link buttons and document headers', () => {
    const payload = metaTemplatePayload('receipt', 'en', { baseUrl: 'https://www.skyllai.com/', headerHandle: 'h:1' });
    expect(payload).toMatchObject({ name: 'skyll_receipt_v2', language: 'en', category: 'UTILITY' });
    expect(payload.components[0]).toEqual({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: ['h:1'] } });
    expect(payload.components[1].example.body_text[0]).toHaveLength(7);
    expect(payload.components[2].buttons[0]).toMatchObject({ type: 'URL', text: 'View fees', url: 'https://www.skyllai.com/f/{{1}}' });

    const message = metaTemplateMessage('receipt', 'hi', sample, { linkToken: 'tok', documentId: 'media1', documentName: 'R.pdf' });
    expect(message.language).toEqual({ code: 'hi' });
    expect(message.components.map((component) => component.type)).toEqual(['header', 'body', 'button']);
    expect(message.components[2].parameters[0].text).toBe('tok');
    expect(() => metaTemplateMessage('receipt', 'en', sample, { linkToken: 'tok' })).toThrow(/document/);
    expect(() => metaTemplateMessage('fee_due', 'en', sample)).toThrow(/link/);
  });
});
