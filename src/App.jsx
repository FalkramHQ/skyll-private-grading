import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { loadStudentData, loadTeacherData } from './data/studentData';
import { loginPathForSchool, useSession } from './lib/auth';
import { needsRequestedStudentContext } from './lib/studentContextRoute';
import ErrorBoundary, { RouteErrorBoundary } from './components/ErrorBoundary';
import Loader from './components/Loader';
import { trackLinkClick, trackPageView } from './lib/siteTracking';

const DemoDashboard = lazy(() => import('./pages/DemoDashboard'));
const DemoStudentReport = lazy(() => import('./pages/DemoStudentReport'));
const PartnerBLogin = lazy(() => import('./pages/PartnerBLogin'));
const SchoolLogin = lazy(() => import('./pages/SchoolLogin'));
const DynamicSchoolLogin = lazy(() => import('./pages/DynamicSchoolLogin'));
const IndividualLogin = lazy(() => import('./pages/IndividualLogin'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const StudentProfile = lazy(() => import('./pages/StudentProfile'));
const Hive = lazy(() => import('./pages/Hive'));
const StudentTutor = lazy(() => import('./pages/StudentTutor'));
const PracticeTest = lazy(() => import('./pages/PracticeTest'));
const TeacherDashboard = lazy(() => import('./pages/TeacherDashboard'));
const TeacherProfile = lazy(() => import('./pages/TeacherProfile'));
const SubjectDetail = lazy(() => import('./pages/SubjectDetail'));
const Landing = lazy(() => import('./pages/Landing'));
const Report = lazy(() => import('./pages/Report'));
const DPDPCompliance = lazy(() => import('./pages/DPDPCompliance'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const AccountDeletion = lazy(() => import('./pages/AccountDeletion'));
const TermsOfService = lazy(() => import('./pages/TermsOfService'));
const GrievanceOfficer = lazy(() => import('./pages/GrievanceOfficer'));
const Partner = lazy(() => import('./pages/Partner'));
const AILabs = lazy(() => import('./pages/AILabs'));
const Expeditions = lazy(() => import('./pages/Expeditions'));
const VlReviewDashboard = lazy(() => import('./pages/VlReviewDashboard'));
const SkyllAdminLogin = lazy(() => import('./pages/SkyllAdminLogin'));
const ReviewLogin = lazy(() => import('./pages/ReviewLogin'));
const LearnerDna = lazy(() => import('./pages/LearnerDna'));
const ExamBuilder = lazy(() => import('./pages/ExamBuilder'));
const Admin = lazy(() => import('./pages/Admin'));
const AdminProvisioning = lazy(() => import('./pages/AdminProvisioning'));
const AdminAccess = lazy(() => import('./pages/AdminAccess'));
const AdminInvoices = lazy(() => import('./pages/AdminInvoices'));
const ParentReport = lazy(() => import('./pages/ParentReport'));
const ParentFees = lazy(() => import('./pages/ParentFees'));
const CrmApp = lazy(() => import('./pages/crm/CrmApp'));
const PublicInquiry = lazy(() => import('./pages/PublicInquiry'));

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <Loader size="hero" />
        <p className="text-foreground-secondary text-sm font-medium">Loading...</p>
      </div>
    </div>
  );
}

function DataLoader({ children }) {
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const { user, loading: sessionLoading } = useSession();
  const username = user?.username;
  const role = user?.role;

  useEffect(() => {
    if (sessionLoading) return;
    async function init() {
      try {
        if (username) {
          if (role === 'teacher' || role === 'admin') {
            await loadTeacherData(username);
          } else {
            await loadStudentData(username);
          }
        }
        setIsLoading(false);
      } catch (e) {
        console.error('DataLoader error:', e);
        setLoadError(e);
        setIsLoading(false);
      }
    }
    init();
  }, [username, role, sessionLoading]);

  if (sessionLoading || isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center" role="status" aria-busy="true">
        <div className="flex flex-col items-center gap-4">
          <Loader size="hero" />
          <p className="text-foreground-secondary text-sm font-medium">Loading your profile...</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background" role="alert" aria-live="assertive">
        <div className="text-center space-y-4 max-w-md px-4">
          <div className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center bg-destructive-soft">
            <svg className="h-8 w-8 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-primary">Failed to load data</h2>
            <p className="text-sm text-muted-foreground">
              We couldn't load your profile. Please check your connection and try again.
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg px-4 py-2 text-sm font-medium transition bg-accent text-accent-foreground hover:bg-accent/90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return children;
}

export function ProtectedRoute({ children, adminOnly = false, studentOnly = false, teacherOnly = false, roles = null }) {
  const { user, loading, isAuthenticated } = useSession();
  const userRole = user?.role;
  const location = useLocation();

  if (loading) return <PageLoader />;

  if (!isAuthenticated) {
    if (adminOnly || roles) return <Navigate to={`/review-login?from=${encodeURIComponent(location.pathname)}`} replace />;
    return <Navigate to={loginPathForSchool()} replace />;
  }
  // Office staff are CRM-only; every other screen sends them to the CRM.
  if (userRole === 'staff') return <Navigate to="/crm" replace />;
  if (adminOnly && userRole !== 'admin' && userRole !== 'skyll_admin') {
    return <Navigate to="/review-login" replace />;
  }
  // Explicit role allowlist (e.g. the review queue, which teachers may use).
  // Signed-in users with the wrong role go to their own home, not back to a
  // login page they are already past.
  if (roles && !roles.includes(userRole)) {
    return <Navigate to={userRole === 'teacher' || userRole === 'student' ? '/dashboard' : '/review-login'} replace />;
  }
  if (teacherOnly && userRole !== 'teacher' && userRole !== 'admin') return <Navigate to="/dashboard" replace />;
  if (studentOnly && userRole !== 'student') return <Navigate to="/dashboard" replace />;
  // Platform admins have no student or teacher profile; their home is operations.
  if (userRole === 'skyll_admin' && location.pathname === '/dashboard') return <Navigate to="/admin-dashboard" replace />;

  // Admin and role-listed routes don't need student/teacher data loading
  if (adminOnly || roles) return children;

  // These routes load the requested student's context themselves. Avoid first
  // loading the teacher profile, then immediately replacing it with the student.
  const requestedStudentRoute = needsRequestedStudentContext(location.pathname, location.search);
  if (requestedStudentRoute || ['/profile', '/teacher-profile', '/hive', '/tutor', '/practice'].includes(location.pathname)) return children;

  return <DataLoader>{children}</DataLoader>;
}

function DashboardRouter() {
  const { user } = useSession();
  const role = user?.role;
  if (role === 'teacher' || role === 'admin') {
    return <TeacherDashboard />;
  }
  return <Dashboard />;
}

function SiteTracking() {
  const { pathname } = useLocation();

  useEffect(() => {
    trackPageView(pathname);
  }, [pathname]);

  useEffect(() => {
    document.addEventListener('click', trackLinkClick);
    return () => document.removeEventListener('click', trackLinkClick);
  }, []);

  return null;
}

function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}

export function StudentReportPage() {
  const { username } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const backParams = new URLSearchParams();
  const tab = searchParams.get('tab');
  const subject = searchParams.get('subject');
  const cls = searchParams.get('cls');
  if (tab) backParams.set('tab', tab);
  if (subject) backParams.set('subject', subject);
  if (cls) backParams.set('cls', cls);
  const backUrl = `/dashboard${backParams.toString() ? `?${backParams.toString()}` : ''}`;

  useEffect(() => {
    async function init() {
      try {
        await loadStudentData(username);
        setIsLoading(false);
      // eslint-disable-next-line no-unused-vars
      } catch (_e) {
        setError('Student not found');
        setIsLoading(false);
      }
    }
    init();
  }, [username]);

  if (isLoading) {
    return <PageLoader />;
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <p className="text-sm text-muted-foreground">{error}</p>
          <button
            onClick={() => navigate(backUrl)}
            className="text-sm font-medium hover:underline text-accent"
          >
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  // A teacher opening a student should see the same complete learning view as
  // the student: learner DNA, subjects, and question analysis. The printable
  // report remains a separate action inside that dashboard.
  return <Dashboard teacherView backUrl={backUrl} />;
}

function App() {
  const showArchived = false;
  return (
    <BrowserRouter>
      <ScrollToTop />
      <SiteTracking />
      <RouteErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/learner-dna" element={<LearnerDna />} />
        <Route path="/parent/report" element={<ParentReport />} />
        <Route path="/f/:token" element={<ParentFees />} />
        <Route path="/r/:token" element={<ParentReport />} />
        {/* CRM shell guards itself: school flag + CRM capability, not admin-only. */}
        <Route path="/crm/*" element={<CrmApp />} />
        {/* Public admissions form (no login); the server checks the school's form is on. */}
        <Route path="/inquire/:schoolSlug" element={<PublicInquiry />} />
        <Route path="/answer-sheet" element={<Navigate to="/report" replace />} />
        <Route path="/dpdp-compliance" element={<DPDPCompliance />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/account-deletion" element={<AccountDeletion />} />
        <Route path="/terms-of-service" element={<TermsOfService />} />
        <Route path="/grievance-officer" element={<GrievanceOfficer />} />
        <Route path="/partner" element={<Partner />} />
        <Route path="/labs" element={<AILabs />} />
        {showArchived && <Route path="/expeditions" element={<Expeditions />} />}
        <Route path="/admin" element={<SkyllAdminLogin />} />
        <Route path="/review-login" element={<ReviewLogin />} />
        <Route
          path="/review"
          element={
            <ProtectedRoute roles={['teacher', 'admin', 'skyll_admin']}>
              <VlReviewDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/exam"
          element={
            <ProtectedRoute adminOnly>
              <ExamBuilder />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin-dashboard"
          element={
            <ProtectedRoute adminOnly>
              <Admin />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/provision"
          element={
            <ProtectedRoute adminOnly>
              <AdminProvisioning />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/access"
          element={
            <ProtectedRoute adminOnly>
              <AdminAccess />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin/invoices"
          element={
            <ProtectedRoute adminOnly>
              <AdminInvoices />
            </ProtectedRoute>
          }
        />
        <Route path="/demo" element={<DemoDashboard />} />
        <Route path="/demo/report/:username" element={<DemoStudentReport />} />
        <Route path="/partnerb" element={<PartnerBLogin />} />
        <Route path="/:schoolSlug" element={<DynamicSchoolLogin />} />
        <Route path="/individual" element={<IndividualLogin />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardRouter />
            </ProtectedRoute>
          }
        />
        <Route path="/profile" element={<ProtectedRoute studentOnly><StudentProfile /></ProtectedRoute>} />
        <Route path="/teacher-profile" element={<ProtectedRoute teacherOnly><TeacherProfile /></ProtectedRoute>} />
        <Route path="/hive" element={<ProtectedRoute><Hive /></ProtectedRoute>} />
        <Route path="/tutor" element={<ProtectedRoute><StudentTutor /></ProtectedRoute>} />
        <Route path="/practice" element={<ProtectedRoute><PracticeTest /></ProtectedRoute>} />
        <Route
          path="/subject/:subjectId"
          element={
            <ProtectedRoute>
              <SubjectDetail />
            </ProtectedRoute>
          }
        />
        <Route
          path="/student/:username"
          element={
            <ProtectedRoute>
              <StudentReportPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/report"
          element={
            <ProtectedRoute>
              <Report />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </RouteErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
