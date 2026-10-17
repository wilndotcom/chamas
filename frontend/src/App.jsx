import React, { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { useI18n } from './i18n/I18nContext';
import { Inbox } from 'lucide-react';
import Login from './pages/Login';
import FirstLoginPassword from './pages/FirstLoginPassword';
import Layout from './components/Layout';
import Footer from './components/Footer';
import ConnectionLostNotice from './components/ConnectionLostNotice';

// Route-level code splitting: every page loads on demand rather than all at
// once. The bundle was 970 kB in a single chunk, so a member opening their
// dashboard paid for the admin pages too. These load when first navigated to.
const MemberDashboard = lazy(() => import('./pages/MemberDashboard'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const Members = lazy(() => import('./pages/Members'));
const Contributions = lazy(() => import('./pages/Contributions'));
const Loans = lazy(() => import('./pages/Loans'));
const Welfare = lazy(() => import('./pages/Welfare'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));
const AdminManagement = lazy(() => import('./pages/AdminManagement'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Impersonate = lazy(() => import('./pages/Impersonate'));
const CashBook = lazy(() => import('./pages/CashBook'));
const Registrations = lazy(() => import('./pages/Registrations'));

/** Wraps a lazy page with the shared loading fallback. */
const Page = ({ children }) => (
  <Suspense
    fallback={
      <div className="empty-state" style={{ minHeight: '50vh' }}>
        <Inbox size={32} />
        <p>…</p>
      </div>
    }
  >
    {children}
  </Suspense>
);

/*
 * Where each portal lives.
 *
 * Both portals share one origin and are told apart by the first path segment:
 *
 *     /admin          the management side
 *     /admin/members  a page inside it
 *     /member         the member side
 *     /login          signing in
 *
 * Without the prefixes every screen shared one flat set of paths, which made the
 * two portals impossible to bookmark separately and gave no way to tell an admin
 * link from a member link. It also meant there was no obvious path a reverse
 * proxy could hand the whole app off on.
 */
const ADMIN = '/admin';
const MEMBER = '/member';

/*
 * Old flat paths, kept working.
 *
 * These were live for long enough that people have them in bookmarks, on a
 * printed agenda, or pasted into a WhatsApp group. Redirecting rather than
 * removing means an old link lands on the right page instead of a 404.
 */
const LEGACY_REDIRECTS = [
  ['/dashboard', `${ADMIN}/`],
  ['/members', `${ADMIN}/members`],
  ['/registrations', `${ADMIN}/registrations`],
  ['/cashbook', `${ADMIN}/cashbook`],
  ['/reports', `${ADMIN}/reports`],
  ['/settings', `${ADMIN}/settings`],
  ['/admins', `${ADMIN}/admins`],
  ['/portal-switch', `${ADMIN}/portal-switch`],
  // Roles & Rights moved into Settings; both spellings keep working.
  ['/roles', `${ADMIN}/settings`]
];

function App() {
  const { user, loading, connectionLost } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();

  const isMember = user?.type === 'member';
  const signedIn = Boolean(user);

  /*
   * Sends each person to their own portal.
   *
   * A member who follows an admin link is moved to the member side rather than
   * shown an admin screen they have no rights to, and vice versa. Without this,
   * sharing the wrong link produced a page of empty tiles.
   *
   * Done with navigate() rather than history.replaceState(). The raw history API
   * changes the address bar without telling the router, so the two disagree: the
   * URL says /admin while the member's screen is still on screen. It also ignores
   * the router's basename, which on a sub-path install quietly wrote "/member" at
   * the domain root and dropped the /the-team prefix altogether.
   */
  useEffect(() => {
    if (!signedIn) return;
    const onMemberSide = location.pathname.startsWith(MEMBER);
    const onAdminSide = location.pathname.startsWith(ADMIN);

    if (isMember && onAdminSide) {
      navigate(MEMBER, { replace: true });
    } else if (!isMember && onMemberSide) {
      navigate(ADMIN, { replace: true });
    }
  }, [signedIn, isMember, location.pathname, navigate]);

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: '100vh' }}>
        <Inbox size={40} />
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  /*
   * Still signed in, server unreachable.
   *
   * Shown instead of the login screen, because the session is intact and the
   * alternative - bouncing to login - is what made people believe they had been
   * signed out by a blip they never caused. Retries on its own.
   */
  if (connectionLost && !user) {
    return <ConnectionLostNotice />;
  }

  // Signed out: the login screen carries its own footer, since there is no shell.
  // It is reachable at /login and at either portal's root, so every entry point
  // lands somewhere sensible.
  if (!user) {
    const wantsPortal = location.pathname.startsWith(ADMIN) || location.pathname.startsWith(MEMBER);
    if (!wantsPortal && location.pathname !== '/login') {
      return <Navigate to="/login" replace />;
    }
    return (
      <div className="login-page">
        <Login />
        <Footer variant="onDark" />
      </div>
    );
  }

  /*
   * Still on the password the account was created with.
   *
   * Checked before the routes rather than inside a route guard, so there is no
   * path, link or back button that reaches the application while the flag is set.
   * A guard on each page would have to be remembered on every page added later,
   * and the first one that forgot would be the hole.
   *
   * The backend refuses the same requests independently - see refuseUntilPassword
   * Changed in app/Auth.php - so an account in this state cannot be used by
   * talking to the API directly either.
   */
  if (user.type === 'admin' && user.must_change_password) {
    return (
      <div className="login-page">
        <FirstLoginPassword />
        <Footer variant="onDark" />
      </div>
    );
  }

  return (
    <Routes>
      {/* The root sends each person to their own side. */}
      <Route path="/" element={<Navigate to={isMember ? MEMBER : ADMIN} replace />} />

      {/* ---------------------------------------------------------- member --- */}
      <Route path="/member" element={<Layout><MemberRoutes isMember /></Layout>} />
      <Route path="/member/*" element={<Layout><MemberRoutes isMember /></Layout>} />

      {/* ----------------------------------------------------------- admin --- */}
      <Route path="/admin" element={<Layout><AdminRoutes /></Layout>} />
      <Route path="/admin/*" element={<Layout><AdminRoutes /></Layout>} />

      {/* Signing out, or landing on a link meant for the other portal. */}
      <Route path="/login" element={<Navigate to={isMember ? MEMBER : ADMIN} replace />} />

      {/* Old flat links, so nothing a member was already given stops working. */}
      {LEGACY_REDIRECTS.map(([from, to]) => (
        <Route key={from} path={from} element={<Navigate to={to} replace />} />
      ))}

      {/* Anything unrecognised goes to the right portal rather than a dead end. */}
      <Route path="*" element={<Navigate to={isMember ? MEMBER : ADMIN} replace />} />
    </Routes>
  );
}

/** The member portal's own routes. */
const MemberRoutes = () => (
  <Routes>
    <Route path="/" element={<Page><MemberDashboard /></Page>} />
    <Route path="contributions" element={<Page><Contributions /></Page>} />
    <Route path="loans" element={<Page><Loans /></Page>} />
    <Route path="welfare" element={<Page><Welfare /></Page>} />
    <Route path="notifications" element={<Page><Notifications /></Page>} />
    <Route path="*" element={<Navigate to="/member" replace />} />
  </Routes>
);

/** The admin portal's own routes. */
const AdminRoutes = () => (
  <Routes>
    <Route path="/" element={<Page><AdminDashboard /></Page>} />
    <Route path="members" element={<Page><Members /></Page>} />
    <Route path="registrations" element={<Page><Registrations /></Page>} />
    <Route path="contributions" element={<Page><Contributions /></Page>} />
    <Route path="loans" element={<Page><Loans /></Page>} />
    <Route path="welfare" element={<Page><Welfare /></Page>} />
    <Route path="cashbook" element={<Page><CashBook /></Page>} />
    <Route path="reports" element={<Page><Reports /></Page>} />
    <Route path="notifications" element={<Page><Notifications /></Page>} />
    <Route path="settings" element={<Page><Settings /></Page>} />
    <Route path="admins" element={<Page><AdminManagement /></Page>} />
    <Route path="portal-switch" element={<Page><Impersonate /></Page>} />
    <Route path="*" element={<Navigate to="/admin" replace />} />
  </Routes>
);

export default App;