import { describe, expect, it } from 'vitest';
import { CAPABILITIES, CRM_SECTIONS, SENSITIVE_CAPABILITIES, isCapability } from '../../../shared/crm/capabilities.js';
import {
  GRANT_PRESETS,
  ROLE_DEFAULTS,
  canReceiveGrants,
  effectiveCapabilities,
  hasCapability,
} from '../../../shared/crm/roleDefaults.js';

const CONTACT = ['crm.contacts.read', 'crm.contacts.write'];
const FINANCE = ['crm.finance.read', 'crm.finance.write', 'crm.finance.refund'];
const LEADS = ['crm.leads.read', 'crm.leads.write', 'crm.leads.convert'];

describe('CRM permission matrix', () => {
  it('gives platform and school admins every capability', () => {
    for (const role of ['skyll_admin', 'school_admin', 'admin']) {
      expect([...effectiveCapabilities(role)].sort()).toEqual([...CAPABILITIES].sort());
    }
  });

  it('limits teachers to roster, progress, classes, attendance, and tasks', () => {
    const teacher = effectiveCapabilities('teacher');
    for (const capability of [...CONTACT, ...FINANCE, ...LEADS, 'crm.export', 'crm.audit.read', 'crm.permissions.manage']) {
      expect(teacher.has(capability), capability).toBe(false);
    }
    expect(teacher.has('crm.students.read')).toBe(true);
    expect(teacher.has('crm.progress.read')).toBe(true);
    expect(teacher.has('crm.attendance.write')).toBe(true);
    expect(teacher.has('crm.classes.write')).toBe(false);
  });

  it('gives staff, students, and scanners nothing by default', () => {
    for (const role of ['staff', 'student', 'scanner', 'unknown_role']) {
      expect(effectiveCapabilities(role).size, role).toBe(0);
    }
  });

  it('never lets students or scanners receive grants', () => {
    expect(canReceiveGrants('student')).toBe(false);
    expect(canReceiveGrants('scanner')).toBe(false);
    expect(hasCapability('student', ['crm.access', 'crm.finance.read'], 'crm.finance.read')).toBe(false);
    expect(hasCapability('scanner', [{ capability: 'crm.access' }], 'crm.access')).toBe(false);
  });

  it('adds grants to staff and teachers and drops unknown capabilities', () => {
    const staff = effectiveCapabilities('staff', [{ capability: 'crm.finance.read' }, 'crm.bogus']);
    expect([...staff]).toEqual(['crm.finance.read']);
    expect(hasCapability('teacher', ['crm.leads.read'], 'crm.leads.read')).toBe(true);
  });

  it('keeps sensitive capabilities out of every preset', () => {
    for (const preset of Object.values(GRANT_PRESETS)) {
      for (const capability of preset.capabilities) {
        expect(isCapability(capability), capability).toBe(true);
        expect(SENSITIVE_CAPABILITIES, `${preset.label} ${capability}`).not.toContain(capability);
      }
      expect(preset.capabilities).toContain('crm.access');
    }
  });

  it('lets the front desk collect fees but never refund (CRM M2 D7)', () => {
    expect(GRANT_PRESETS.front_desk.capabilities).toEqual(expect.arrayContaining(['crm.finance.read', 'crm.finance.write', 'crm.comms.read', 'crm.comms.send']));
    expect(GRANT_PRESETS.front_desk.capabilities).not.toContain('crm.finance.refund');
  });

  it('keeps finance separate from contact data in the finance preset', () => {
    const finance = GRANT_PRESETS.finance.capabilities;
    expect(finance).toContain('crm.finance.read');
    expect(finance).not.toContain('crm.contacts.write');
    expect(finance).not.toContain('crm.progress.read');
    expect(GRANT_PRESETS.admissions.capabilities.some((capability) => FINANCE.includes(capability))).toBe(false);
  });

  it('references only known capabilities in role defaults and shell sections', () => {
    for (const capabilities of Object.values(ROLE_DEFAULTS)) {
      for (const capability of capabilities) expect(isCapability(capability), capability).toBe(true);
    }
    expect(CRM_SECTIONS.map((section) => section.key)).toEqual([
      'overview', 'leads', 'tasks', 'students', 'classes', 'attendance', 'fees', 'communications', 'reports', 'settings',
    ]);
    for (const section of CRM_SECTIONS) expect(isCapability(section.capability), section.key).toBe(true);
  });
});
