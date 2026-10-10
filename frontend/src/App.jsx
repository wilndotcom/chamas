import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { useI18n } from './i18n/I18nContext';
import { Inbox } from 'lucide-react';
import Login from './pages/Login';
import AdminDashboard from './pages/AdminDashboard';
import MemberDashboard from './pages/MemberDashboard';
import Members from './pages/Members';
import Contributions from './pages/Contributions';
import Loans from './pages/Loans';
import Welfare from './pages/Welfare';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import AdminManagement from './pages/AdminManagement';
import Notifications from './pages/Notifications';
import Impersonate from './pages/Impersonate';
import CashBook from './pages/CashBook';
import Registrations from './pages/Registrations';
import Layout from './components/Layout';
import Footer from './components/Footer';

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
          <Route path="/" element={<MemberDashboard />} />
          <Route path="/contributions" element={<Contributions />} />
          <Route path="/loans" element={<Loans />} />
          <Route path="/welfare" element={<Welfare />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Layout>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<AdminDashboard />} />
        <Route path="/members" element={<Members />} />
        <Route path="/registrations" element={<Registrations />} />
        {/* Roles & Rights moved into Settings. Old links and bookmarks still work. */}
        <Route path="/roles" element={<Navigate to="/settings" replace />} />
        <Route path="/contributions" element={<Contributions />} />
        <Route path="/loans" element={<Loans />} />
        <Route path="/welfare" element={<Welfare />} />
        <Route path="/cashbook" element={<CashBook />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/admins" element={<AdminManagement />} />
        <Route path="/portal-switch" element={<Impersonate />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
}

export default App;
