// Guardian rules shared by the CRM server and UI (FLKRM-326 S4, D15).
import { z } from 'zod';
import { phoneField } from './leads.js';

export const RELATIONSHIPS = Object.freeze([
  { key: 'mother', label: 'Mother' },
  { key: 'father', label: 'Father' },
  { key: 'guardian', label: 'Guardian' },
  { key: 'grandparent', label: 'Grandparent' },
  { key: 'sibling', label: 'Sibling' },
  { key: 'other', label: 'Other' },
].map((item) => Object.freeze(item)));
export const RELATIONSHIP_KEYS = Object.freeze(RELATIONSHIPS.map((item) => item.key));

export const CHANNELS = Object.freeze([
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'sms', label: 'SMS' },
  { key: 'call', label: 'Call' },
  { key: 'email', label: 'Email' },
].map((item) => Object.freeze(item)));
export const CHANNEL_KEYS = Object.freeze(CHANNELS.map((item) => item.key));

export const CONSENT_SOURCES = Object.freeze({ staff: 'Recorded by staff', roster_import: 'Roster import', public_form: 'Inquiry form', whatsapp_stop: 'Replied STOP on WhatsApp' });

export function relationshipLabel(key) {
  return RELATIONSHIPS.find((item) => item.key === key)?.label || 'Guardian';
}

const email = z.string().trim().max(160).email('Enter a valid email address');

export const addGuardianBody = z.object({
  studentId: z.string().min(1).max(128),
  contact: z.object({
    phone: phoneField,
    name: z.string().trim().max(120).optional(),
    email: email.optional(),
    whatsappOptIn: z.boolean().optional(),
  }).strict(),
  relationship: z.enum(RELATIONSHIP_KEYS).default('guardian'),
  isEmergency: z.boolean().optional(),
  isFeePayer: z.boolean().optional(),
}).strict();

export const updateContactFields = {
  name: z.string().trim().max(120).nullable().optional(),
  email: email.nullable().optional(),
  phone: phoneField.optional(),
  preferredChannel: z.enum(CHANNEL_KEYS).optional(),
  whatsappOptIn: z.boolean().optional(),
};
