// Role defaults and grant presets (CRM-002). Effective capabilities are the
// role's defaults plus active per-user grants. Sessions report `school_admin`
// as the legacy `admin`, so both spellings map to the same defaults.
import { CAPABILITIES, SENSITIVE_CAPABILITIES, isCapability } from './capabilities.js';

const ALL = CAPABILITIES;

const TEACHER = Object.freeze([
  'crm.access',
  'crm.students.read',
  'crm.progress.read',
  'crm.classes.read',
  'crm.attendance.read',
  'crm.attendance.write',
  'crm.tasks.read',
  'crm.tasks.write',
]);

export const ROLE_DEFAULTS = Object.freeze({
  skyll_admin: ALL,
  school_admin: ALL,
  admin: ALL,
  teacher: TEACHER,
  // Office staff start with nothing; everything comes from grants.
  staff: Object.freeze([]),
  student: Object.freeze([]),
  scanner: Object.freeze([]),
});

// Capabilities a role holds only for records it owns (enforced by handlers).
// Teachers mark attendance only for classes they teach or batches they're
// assigned to, unless granted school-wide `crm.attendance.write` (FLKRM-327 D3).
export const OWN_RECORDS_ONLY = Object.freeze({
  teacher: Object.freeze(['crm.tasks.read', 'crm.tasks.write', 'crm.attendance.write']),
});

// Roles that may receive CRM grants. Students and scanner devices never can.
export const GRANTABLE_ROLES = Object.freeze(['teacher', 'staff']);

// Roles that may use only the CRM (every non-CRM page and API refuses them).
export const CRM_ONLY_ROLES = Object.freeze(['staff']);

export function isCrmOnlyRole(role) {
  return CRM_ONLY_ROLES.includes(role);
}

export function canReceiveGrants(role) {
  return GRANTABLE_ROLES.includes(role);
}

export const GRANT_PRESETS = Object.freeze({
  admissions: Object.freeze({
    label: 'Admissions',
    capabilities: Object.freeze([
      'crm.access', 'crm.leads.read', 'crm.leads.write', 'crm.leads.convert',
      'crm.contacts.read', 'crm.contacts.write', 'crm.students.read',
      'crm.tasks.read', 'crm.tasks.write',
    ]),
  }),
  finance: Object.freeze({
    label: 'Finance',
    capabilities: Object.freeze([
      'crm.access', 'crm.finance.read', 'crm.finance.write',
      'crm.students.read', 'crm.contacts.read',
    ]),
  }),
  front_desk: Object.freeze({
    label: 'Front desk',
    capabilities: Object.freeze([
      'crm.access', 'crm.leads.read', 'crm.leads.write', 'crm.contacts.read',
      'crm.students.read', 'crm.attendance.read', 'crm.tasks.read', 'crm.tasks.write',
      // CRM M2 phase 1 (D7): the front desk collects fees.
      'crm.finance.read', 'crm.finance.write',
      // CRM M2 phase 2 (D11): and messages parents on WhatsApp.
      'crm.comms.read', 'crm.comms.send',
    ]),
  }),
});

// Presets must never carry sensitive capabilities (checked in tests too).
for (const preset of Object.values(GRANT_PRESETS)) {
  const leaked = preset.capabilities.filter((capability) => SENSITIVE_CAPABILITIES.includes(capability));
  if (leaked.length) throw new Error(`Preset ${preset.label} includes sensitive capabilities: ${leaked.join(', ')}`);
}

/**
 * Role defaults plus active grants. Grants are ignored for roles that cannot
 * receive them, and unknown capability strings are dropped.
 */
export function effectiveCapabilities(role, grants = []) {
  const result = new Set(ROLE_DEFAULTS[role] || []);
  if (canReceiveGrants(role)) {
    for (const grant of grants) {
      const capability = typeof grant === 'string' ? grant : grant?.capability;
      if (isCapability(capability)) result.add(capability);
    }
  }
  return result;
}

export function hasCapability(role, grants, capability) {
  return effectiveCapabilities(role, grants).has(capability);
}
