// Default admissions pipeline (CRM-001 §1.2). Schools rename and reorder
// stages; `key` and `category` are fixed so the system keeps understanding them.
export const DEFAULT_PIPELINE_NAME = 'Admissions';

export const DEFAULT_STAGES = Object.freeze([
  { key: 'new_inquiry', name: 'New inquiry', category: 'open' },
  { key: 'contacted', name: 'Contacted', category: 'open' },
  { key: 'qualified', name: 'Qualified', category: 'open' },
  { key: 'trial_scheduled', name: 'Trial scheduled', category: 'open' },
  { key: 'application', name: 'Application', category: 'applicant' },
  { key: 'payment_pending', name: 'Payment pending', category: 'applicant' },
  { key: 'enrolled', name: 'Enrolled', category: 'won' },
  { key: 'lost', name: 'Lost', category: 'lost' },
].map((stage) => Object.freeze(stage)));

export const STAGE_NAME_MAX = 60;

export const DEFAULT_LEAD_SOURCES = Object.freeze([
  { key: 'walk_in', label: 'Walk-in' },
  { key: 'phone', label: 'Phone call' },
  { key: 'referral', label: 'Referral' },
  { key: 'website', label: 'Website' },
  { key: 'social', label: 'Social media' },
  { key: 'other', label: 'Other' },
].map((source) => Object.freeze(source)));
