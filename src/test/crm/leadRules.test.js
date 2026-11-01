// Shared lead schema (FLKRM-326): the form and the server use the same rules.
import { describe, expect, it } from 'vitest';
import { createLeadBody, fieldErrors, phoneField } from '../../../shared/crm/leads.js';
import { normalizePhone } from '../../../shared/phone.js';

describe('shared lead rules', () => {
  it('accepts exactly the phones the server can store', () => {
    for (const phone of ['98200 11122', '+91 98200-11122', '09820011122', '+44 20 7946 0958']) {
      expect(phoneField.safeParse(phone).success).toBe(true);
      expect(normalizePhone(phone)).not.toBeNull();
    }
    for (const phone of ['', '12345', '12345678', 'call me']) {
      expect(phoneField.safeParse(phone).success).toBe(false);
    }
  });

  it('reports errors by field path for the form', () => {
    const errors = fieldErrors(createLeadBody.safeParse({ learnerName: ' ', contact: { phone: '123' } }));
    expect(errors).toEqual(expect.objectContaining({
      learnerName: 'Enter the student name',
      'contact.phone': expect.stringMatching(/valid mobile number/),
    }));
    expect(fieldErrors(createLeadBody.safeParse({ learnerName: 'Tara', note: 'Call back' }))).toEqual({});
  });

  it('never accepts a school from the body', () => {
    expect(createLeadBody.safeParse({ learnerName: 'Tara', note: 'x', schoolId: 'sch_b' }).success).toBe(false);
  });
});
