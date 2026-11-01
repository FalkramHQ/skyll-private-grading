// CRM shell (FLKRM-325). The server is the security boundary: every section's
// data call re-checks the session, school flag, and capability. This guard only
// keeps people from landing on screens that would refuse them.
import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/Card';
import { Skeleton } from '../../components/ui/Skeleton';
import CrmLayout from '../../components/crm/CrmLayout';
import CrmSchoolPicker from '../../components/crm/CrmSchoolPicker';
import { SHELL_SECTIONS, visibleSections } from '../../components/crm/crmSections';
import { getSupportSchoolId, setSupportSchoolId, useCrmMe } from '../../lib/crm/api';
import { clearSession, invalidateSessionCache, useSession } from '../../lib/auth';
import { signOut } from '../../lib/session';

// Each section is its own chunk; most people only ever open two or three.
const CrmSettings = lazy(() => import('./CrmSettings'));
const AttendancePage = lazy(() => import('../../components/crm/attendance/AttendancePage'));
const AttendanceSheet = lazy(() => import('../../components/crm/attendance/AttendanceSheet'));
const BatchPage = lazy(() => import('../../components/crm/classes/BatchPage'));
const ClassesPage = lazy(() => import('../../components/crm/classes/ClassesPage'));
const FeesPage = lazy(() => import('../../components/crm/fees/FeesPage'));
const CommunicationsPage = lazy(() => import('../../components/crm/comms/CommunicationsPage'));
const LeadProfile = lazy(() => import('../../components/crm/leads/LeadProfile'));
const LeadsPage = lazy(() => import('../../components/crm/leads/LeadsPage'));
const OverviewPage = lazy(() => import('../../components/crm/OverviewPage'));
const ReportsPage = lazy(() => import('../../components/crm/reports/ReportsPage'));
const TasksPage = lazy(() => import('../../components/crm/tasks/TasksPage'));
const StudentProfile = lazy(() => import('../../components/crm/students/StudentProfile'));
const StudentsPage = lazy(() => import('../../components/crm/students/StudentsPage'));

const NO_CRM_ROLES = new Set(['student', 'scanner']);

function ShellLoading() {
  return (
    <div className="min-h-screen bg-background p-8" aria-busy="true">
      <Skeleton className="mb-4 h-8 w-48" />
      <Skeleton className="h-40 w-full max-w-2xl" />
    </div>
  );
}

function ChooseSchool({ onChoose }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Open a school&apos;s CRM</CardTitle>
          <CardDescription>
            Support access is recorded in that school&apos;s audit log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CrmSchoolPicker value="" onChange={onChoose} />
        </CardContent>
      </Card>
    </div>
  );
}

// Section chunk still loading: the shell stays put, only the page area waits.
function SectionLoading() {
  return <Skeleton className="h-96 w-full" aria-busy="true" />;
}

function lazyPage(element) {
  return <Suspense fallback={<SectionLoading />}>{element}</Suspense>;
}

// GET /crm/me said 401: the session is gone. Drop the cached one, or the route
// guards would keep treating this person as signed in.
function SignedOut() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    clearSession();
    invalidateSessionCache();
    navigate(`/review-login?from=${encodeURIComponent(location.pathname)}`, { replace: true });
  }, [location.pathname, navigate]);
  return <ShellLoading />;
}

// Office staff have nowhere else to go: every other route sends them back to
// /crm, so redirecting them away would loop.
function CrmUnavailable() {
  const navigate = useNavigate();
  const leave = async () => {
    await signOut().catch(() => {});
    navigate('/review-login', { replace: true });
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md" role="alert">
        <CardHeader>
          <CardTitle>CRM isn&apos;t available for your account</CardTitle>
          <CardDescription>
            Your school has not turned on the CRM for you. Ask your school admin for access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={leave}>Sign out</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function CrmLoadFailed({ onRetry }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md" role="alert">
        <CardHeader>
          <CardTitle>Couldn&apos;t load the CRM</CardTitle>
          <CardDescription>
            The server didn&apos;t respond. Check your connection and try again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={onRetry}>Try again</Button>
        </CardContent>
      </Card>
    </div>
  );
}

function SectionPlaceholder({ section }) {
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Coming soon</CardTitle>
        <CardDescription>{section.blurb}</CardDescription>
      </CardHeader>
    </Card>
  );
}

const SECTION_PAGES = {
  overview: (me) => lazyPage(<OverviewPage me={me} />),
  reports: (me) => lazyPage(<ReportsPage me={me} />),
  leads: (me) => lazyPage(<LeadsPage me={me} />),
  tasks: (me) => lazyPage(<TasksPage me={me} />),
  students: (me) => lazyPage(<StudentsPage me={me} />),
  classes: (me) => lazyPage(<ClassesPage me={me} />),
  attendance: (me) => lazyPage(<AttendancePage me={me} />),
  fees: (me) => lazyPage(<FeesPage me={me} />),
  communications: (me) => lazyPage(<CommunicationsPage me={me} />),
  settings: (me) => lazyPage(<CrmSettings me={me} />),
};

function CrmShell({ role, supportSchoolId, onSupportSchoolChange }) {
  const { status, me, error, reload } = useCrmMe(supportSchoolId);

  if (status === 'loading') return <ShellLoading />;
  if (status === 'error') {
    if (error.status === 401) return <SignedOut />;
    // Server or network failure (5xx, 503 from a DB blip, offline): retry here.
    if (!error.status || error.status >= 500) return <CrmLoadFailed onRetry={reload} />;
    // Platform staff whose chosen school vanished pick again.
    if (supportSchoolId && (error.status === 400 || error.status === 404)) {
      return <ChooseSchool onChoose={onSupportSchoolChange} />;
    }
    // CRM off for this school (404) or no CRM access (403). Staff are CRM-only,
    // so the dashboard would bounce them straight back here.
    if (role === 'staff') return <CrmUnavailable />;
    return <Navigate to="/dashboard" replace />;
  }

  const allowed = new Set(visibleSections(me.sections).map((section) => section.key));
  return (
    <Routes>
      <Route element={<CrmLayout me={me} supportSchoolId={supportSchoolId} onSupportSchoolChange={onSupportSchoolChange} />}>
        {SHELL_SECTIONS.map((section) => {
          const page = SECTION_PAGES[section.key]?.(me) || <SectionPlaceholder section={section} />;
          const element = allowed.has(section.key) ? page : <Navigate to="/crm" replace />;
          return section.path
            ? <Route key={section.key} path={section.path} element={element} />
            : <Route key={section.key} index element={element} />;
        })}
        <Route path="leads/:leadId" element={allowed.has('leads') ? lazyPage(<LeadProfile me={me} />) : <Navigate to="/crm" replace />} />
        <Route path="students/:studentId" element={allowed.has('students') ? lazyPage(<StudentProfile me={me} />) : <Navigate to="/crm" replace />} />
        <Route path="classes/batches/:batchId" element={allowed.has('classes') ? lazyPage(<BatchPage me={me} />) : <Navigate to="/crm" replace />} />
        <Route path="attendance/:sessionId" element={allowed.has('attendance') ? lazyPage(<AttendanceSheet me={me} />) : <Navigate to="/crm" replace />} />
        <Route path="*" element={<Navigate to="/crm" replace />} />
      </Route>
    </Routes>
  );
}

export default function CrmApp() {
  const { user, loading, isAuthenticated } = useSession();
  const location = useLocation();
  const [supportSchoolId, setSupportSchool] = useState(getSupportSchoolId);

  const chooseSchool = (schoolId) => {
    setSupportSchoolId(schoolId);
    setSupportSchool(schoolId);
  };

  if (loading) return <ShellLoading />;
  if (!isAuthenticated) return <Navigate to={`/review-login?from=${encodeURIComponent(location.pathname)}`} replace />;
  if (NO_CRM_ROLES.has(user.role)) return <Navigate to="/dashboard" replace />;
  if (user.role === 'skyll_admin' && !supportSchoolId) return <ChooseSchool onChoose={chooseSchool} />;

  return <CrmShell key={supportSchoolId || 'own'} role={user.role} supportSchoolId={supportSchoolId} onSupportSchoolChange={chooseSchool} />;
}
