import login from '../../server/auth/login.js';
import session from '../../server/auth/session.js';
import exam from '../../server/exam.js';
import operations from '../../server/admin/operations.js';
import operationsDetail from '../../server/admin/operationsDetail.js';
import operationsActions from '../../server/admin/operationsActions.js';
import adminAccess from '../../server/admin/access.js';
import features from '../../server/auth/features.js';
import teacherProfile from '../../server/auth/teacherProfile.js';
import teacherRoster from '../../server/auth/teacherRoster.js';
import health from '../../server/admin/health.js';
import profile from '../../server/auth/profile.js';
import changePassword from '../../server/auth/changePassword.js';
import events from '../../server/auth/events.js';
import schoolsPublic from '../../server/schools/public.js';
import schoolsProvision from '../../server/schools/provision.js';
import schoolsRoster from '../../server/schools/roster.js';
import parentReport from '../../server/parent/report.js';
import billingProfiles from '../../server/billing/profiles.js';
import invoices from '../../server/billing/invoices.js';
import { handleCrmRequest } from '../../server/crm/router.js';
import { handleCors } from '../_lib/cors.js';

const handlers = {
  login,
  session,
  exam,
  operations,
  operationsDetail,
  features,
  health,
  profile,
  events,
  'teacher-profile': teacherProfile,
  'teacher-roster': teacherRoster,
  'change-password': changePassword,
  schools: schoolsPublic,
  parent: parentReport,
  'billing-profiles': billingProfiles,
  invoices,
};

export default async function handler(req, res) {
  if (handleCors(req, res)) return;
  // Vercel's build compiles this catch-all to a single-segment pattern, so a
  // vercel.json rewrite forwards nested paths (schools/:slug, parent/receipts)
  // with the full sub-path in `route` as a slash-delimited string rather than
  // an array. Accept both, and fall back to every segment after /api/auth.
  const rawRoute = req.query?.route;
  const routeSegments = Array.isArray(rawRoute)
    ? rawRoute.filter(Boolean).map(String)
    : (typeof rawRoute === 'string' && rawRoute.trim()
        ? rawRoute.split('/').filter(Boolean)
        : new URL(req.url, 'https://skyllai.local').pathname.replace(/^\/api\/auth\/?/, '').split('/').filter(Boolean));
  const route = String(routeSegments[0] || '');
  
  // Route schools sub-paths to the correct handler
  if (route === 'schools' && routeSegments[1]) {
    const subRoute = routeSegments[1];
    if (subRoute === 'provision') return schoolsProvision(req, res);
    if (subRoute === 'roster') return schoolsRoster(req, res);
    req.query = { ...req.query, slug: subRoute };
  }

  // Access administration: /api/auth/admin/{users,flags,teachers}
  if (route === 'admin') return adminAccess(req, res, routeSegments.slice(1));

  // Operations recovery actions: /api/auth/operations/jobs
  if (route === 'operations' && routeSegments[1] === 'jobs') return operationsActions(req, res);

  // The parent report has no sub-paths: the old Skyll-number sender
  // (parent/notify, parent/receipts) was retired in CRM M2 phase 2 (D13).
  if (route === 'parent' && routeSegments[1]) return res.status(404).json({ error: 'Not found' });
  
  // CRM API: /api/auth/crm/<resource>. Folded into this function to stay
  // within the Vercel Hobby 12-function cap.
  if (route === 'crm') return handleCrmRequest(req, res, routeSegments.slice(1));

  const selected = handlers[route];
  if (!selected) return res.status(404).json({ error: 'Authentication endpoint not found' });
  return selected(req, res);
}
