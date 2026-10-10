import React, { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { useI18n } from './i18n/I18nContext';
import { Inbox } from 'lucide-react';
import Login from './pages/Login';
import Layout from './components/Layout';
import Footer from './components/Footer';

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

function App() {
  const { user, loading } = useAuth();
  const { t } = useI18n();

  if (loading) {
    return (
      <div className="empty-state" style={{ minHeight: '100vh' }}>
        <Inbox size={40} />
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  // The login screen has no app shell, so it carries the footer itself.
  // All three Login states (login, register, submitted) sit inside this, which
  // is why it is wrapped here rather than inside the Login component.
  if (!user) {
    return (
      <div className="login-page">
        <Login />
        <Footer variant="onDark" />
      </div>
    );
  }

  const isMember = user?.type === 'member';

  if (isMember) {
    return (
      <Layout>
        <Routes>
          <Route path="/" element={<Page><MemberDashboard /></Page>} />
          <Route path="/contributions" element={<Page><Contributions /></Page>} />
          <Route path="/loans" element={<Page><Loans /></Page>} />
          <Route path="/welfare" element={<Page><Welfare /></Page>} />
          <Route path="/notifications" element={<Page><Notifications /></Page>} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Layout>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Page><AdminDashboard /></Page>} />
        <Route path="/members" element={<Page><Members /></Page>} />
        <Route path="/registrations" element={<Page><Registrations /></Page>} />
        {/* Roles & Rights moved into Settings. Old links and bookmarks still work. */}
        <Route path="/roles" element={<Navigate to="/settings" replace />} />
        <Route path="/contributions" element={<Page><Contributions /></Page>} />
        <Route path="/loans" element={<Page><Loans /></Page>} />
        <Route path="/welfare" element={<Page><Welfare /></Page>} />
        <Route path="/cashbook" element={<Page><CashBook /></Page>} />
        <Route path="/reports" element={<Page><Reports /></Page>} />
        <Route path="/notifications" element={<Page><Notifications /></Page>} />
        <Route path="/settings" element={<Page><Settings /></Page>} />
        <Route path="/admins" element={<Page><AdminManagement /></Page>} />
        <Route path="/portal-switch" element={<Page><Impersonate /></Page>} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
}

export default App;
