// CRM capabilities (CRM-002). The server checks capabilities, never role names.
// Contact, finance, and progress data are deliberately separate capabilities.
// Human-readable matrix: docs/CRM_CONTRACTS.md.

export const CAPABILITIES = Object.freeze([
  'crm.access',
  'crm.leads.read',
  'crm.leads.write',
  'crm.leads.convert',
  'crm.students.read',
  'crm.students.write',
  'crm.contacts.read',
  'crm.contacts.write',
  'crm.progress.read',
  'crm.classes.read',
  'crm.classes.write',
  'crm.attendance.read',
  'crm.attendance.write',
  'crm.finance.read',
  'crm.finance.write',
  'crm.finance.refund',
  'crm.comms.read',
  'crm.comms.send',
  'crm.tasks.read',
  'crm.tasks.write',
  'crm.reports.read',
  'crm.export',
  'crm.settings.manage',
  'crm.permissions.manage',
  'crm.audit.read',
]);

const KNOWN = new Set(CAPABILITIES);

export function isCapability(value) {
  return KNOWN.has(value);
}

// Never handed out through a preset; an admin must grant them one at a time.
export const SENSITIVE_CAPABILITIES = Object.freeze([
  'crm.finance.refund',
  'crm.export',
  'crm.settings.manage',
  'crm.permissions.manage',
  'crm.audit.read',
]);

// Shell sections and the capability that makes each one visible.
export const CRM_SECTIONS = Object.freeze([
  { key: 'overview', label: 'Overview', capability: 'crm.access' },
  { key: 'leads', label: 'Leads', capability: 'crm.leads.read' },
  { key: 'tasks', label: 'Tasks', capability: 'crm.tasks.read' },
  { key: 'students', label: 'Students', capability: 'crm.students.read' },
  { key: 'classes', label: 'Classes', capability: 'crm.classes.read' },
  { key: 'attendance', label: 'Attendance', capability: 'crm.attendance.read' },
  { key: 'fees', label: 'Fees', capability: 'crm.finance.read' },
  { key: 'communications', label: 'Communications', capability: 'crm.comms.read' },
  { key: 'reports', label: 'Reports', capability: 'crm.reports.read' },
  { key: 'settings', label: 'Settings', capability: 'crm.settings.manage' },
]);
