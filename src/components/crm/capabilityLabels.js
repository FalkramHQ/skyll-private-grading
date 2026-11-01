// Human-readable names for CRM capabilities and audit actions.
const AREA = {
  access: 'Open CRM',
  leads: 'Leads',
  students: 'Students',
  contacts: 'Contact details',
  progress: 'Progress & reports',
  classes: 'Classes',
  attendance: 'Attendance',
  finance: 'Fees',
  comms: 'Messages',
  tasks: 'Tasks',
  reports: 'Reports',
  export: 'Export data',
  settings: 'Settings',
  permissions: 'Team access',
  audit: 'Audit log',
};

const VERB = { read: 'view', write: 'edit', convert: 'convert', refund: 'refund', send: 'send', manage: 'manage' };

export function capabilityLabel(capability) {
  const [, area, verb] = String(capability).split('.');
  const name = AREA[area] || area;
  if (!verb || area === 'settings' || area === 'permissions') return name;
  return `${name} · ${VERB[verb] || verb}`;
}

const ACTIONS = {
  'permission.granted': 'Access granted',
  'permission.revoked': 'Access removed',
  'support.session': 'Skyll support opened CRM',
  'pipeline.changed': 'Pipeline changed',
  'inquiry_form.changed': 'Inquiry form settings changed',
  'lead.stage_changed': 'Lead stage changed',
  'lead.converted': 'Lead converted',
  'lead.owner_changed': 'Lead owner changed',
  'lead.created': 'Lead created',
  'lead.updated': 'Lead details edited',
  'task.changed': 'Task changed',
  'note.changed': 'Note changed',
  'record.tagged': 'Tag applied or removed',
  'tag.changed': 'Tag settings changed',
  'guardian.changed': 'Guardian changed',
  'contact.updated': 'Contact edited',
  'student.owner_changed': 'Student owner changed',
  'enrollment.changed': 'Enrollment changed',
  'attendance.corrected': 'Attendance corrected',
  'attendance.marked': 'Attendance taken',
  'invoice.changed': 'Invoice changed',
  'payment.changed': 'Payment changed',
  'refund.changed': 'Refund changed',
  'data.exported': 'Data exported',
  'record.merged': 'Records merged',
  'contact.anonymised': 'Contact anonymised',
  'course.changed': 'Course changed',
  'batch.changed': 'Batch changed',
  'room.changed': 'Room changed',
  'membership.changed': 'Batch membership changed',
  'instructor.changed': 'Instructor changed',
  'availability.changed': 'Availability changed',
  'timetable.changed': 'Timetable changed',
  'session.changed': 'Class session changed',
  'holiday.changed': 'Holiday changed',
  'fee_plan.changed': 'Fee plan changed',
  'fee_settings.changed': 'Fee settings changed',
  'wa_connection.changed': 'WhatsApp connection changed',
  'wa_settings.changed': 'WhatsApp settings changed',
  'contact.consent_changed': 'WhatsApp consent changed',
  'message.group_sent': 'Group message sent',
  'reminder.paused': 'Fee reminders paused or resumed',
  'access_link.revoked': 'Parent link revoked',
};

export function auditActionLabel(action) {
  return ACTIONS[action] || action;
}
