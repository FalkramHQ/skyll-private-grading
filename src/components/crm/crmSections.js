// Presentation details for the CRM shell sections. Which sections a user sees
// comes from the server (`GET /crm/me` → `sections`).
import {
  BarChart3, CalendarCheck, GraduationCap, IndianRupee, LayoutDashboard, ListTodo,
  MessageSquare, Settings, UserPlus, Users,
} from 'lucide-react';
import { CRM_SECTIONS } from '../../../shared/crm/capabilities.js';

const DETAILS = {
  overview: { icon: LayoutDashboard, path: '', blurb: 'Admissions, fees, and attendance at a glance.' },
  leads: { icon: UserPlus, path: 'leads', blurb: 'Enquiries and the admissions pipeline.' },
  tasks: { icon: ListTodo, path: 'tasks', blurb: 'Follow-ups and reminders.' },
  students: { icon: GraduationCap, path: 'students', blurb: 'Enrolled students, guardians, and lifecycle.' },
  classes: { icon: Users, path: 'classes', blurb: 'Batches, courses, and schedules.' },
  attendance: { icon: CalendarCheck, path: 'attendance', blurb: 'Daily attendance and corrections.' },
  fees: { icon: IndianRupee, path: 'fees', blurb: 'Invoices, payments, and refunds.' },
  communications: { icon: MessageSquare, path: 'communications', blurb: 'Messages to parents and students.' },
  reports: { icon: BarChart3, path: 'reports', blurb: 'Admissions and collection reports.' },
  settings: { icon: Settings, path: 'settings', blurb: 'Pipeline, sources, and team access.' },
};

export const SHELL_SECTIONS = CRM_SECTIONS.map((section) => ({ ...section, ...DETAILS[section.key] }));

export function visibleSections(sectionKeys = []) {
  const allowed = new Set(sectionKeys);
  return SHELL_SECTIONS.filter((section) => allowed.has(section.key));
}
