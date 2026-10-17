import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFormat } from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';
import ChamaLogo from '../components/ChamaLogo';
import { withBase } from '../baseUrl';
import toast from 'react-hot-toast';
import { Users, User, ShieldCheck, UserPlus, ArrowLeft, CheckCircle } from 'lucide-react';

const Login = () => {
  const [mode, setMode] = useState('login'); // login | register
  const [activeTab, setActiveTab] = useState('admin');
  // Holds either the admin's username or their email address.
  const [identifier, setIdentifier] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    full_name: '',
    phone: '',
    email: '',
    id_number: '',
    password: '',
    confirm_password: '',
    emergency_contact_name: '',
    emergency_contact_phone: ''
  });

  const [done, setDone] = useState(false);
  const { login, memberLogin } = useAuth();
  const { chamaName } = useFormat();
  const { t } = useI18n();
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (activeTab === 'admin') {
        await login(identifier, password);
        toast.success(t('login.welcomeAdmin'));
      } else {
        await memberLogin(phone, password);
        toast.success(t('auth.welcome'));
      }
      navigate('/');
    } catch (error) {
      toast.error(error.response?.data?.error || t('login.failed'), { duration: 5000 });
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirm_password) {
      toast.error(t('err.passwordMismatch'));
      return;
    }
    setLoading(true);
    try {
      /*
       * withBase rather than a bare '/api/...'.
       *
       * This is the one request in the app that does not go through axios, and
       * that is exactly why registration was the screen that broke in a sub-path
       * install: '/api/auth/register' resolves against the domain root, not the
       * folder the app is served from.
       */
      const res = await fetch(withBase('/api/auth/register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('login.regFailed'));
      setDone(true);
      toast.success(t('login.applicationSubmitted'));
    } catch (error) {
      toast.error(error.message || t('login.regFailed'), { duration: 5000 });
    } finally {
      setLoading(false);
    }
  };

  const backToLogin = () => {
    setMode('login');
    setDone(false);
    setActiveTab('member');
  };

  /* ------------------------------------------------- success state --- */
  if (mode === 'register' && done) {
    return (
      <div className="login-container">
        <div className="login-box">
          <div className="login-logo">
            <CheckCircle size={30} />
          </div>
          <h1>{t('login.received')}</h1>
          <p className="subtitle">
            {t('login.thanksName', { name: form.full_name.split(' ')[0] })}
          </p>

          <div className="register-success">
            <p style={{ fontWeight: 600, marginBottom: 10, color: '#0f172a' }}>
              {t('login.waitingApproval')}
            </p>
            <p style={{ fontSize: 14, lineHeight: 1.7 }}>
              {t('login.reviewNote')}{' '}
              <strong>{form.phone}</strong>.
            </p>
          </div>

          <button className="btn btn-primary btn-block" onClick={backToLogin} style={{ marginTop: 20 }}>
            <ArrowLeft size={17} /> {t('login.backToSignIn')}
          </button>
        </div>
      </div>
    );
  }

  /* ----------------------------------------------------- registration --- */
  if (mode === 'register') {
    return (
      <div className="login-container">
        <div className="login-box" style={{ maxWidth: 520 }}>
          <div className="login-logo">
            <UserPlus size={30} />
          </div>
          <h1>{t('login.joinChama', { chama: chamaName })}</h1>
          <p className="subtitle">{t('login.applyToBecome')}</p>

          <div className="notice-strip">
            <ShieldCheck size={16} />
            <span>{t('login.approvalNotice')}</span>
          </div>

          <form onSubmit={handleRegister}>
            <div className="form-group">
              <label>{t('members.fullName')} *</label>
              <input
                type="text"
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                placeholder="e.g. Achieng Odhiambo"
                required
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>{t('auth.phone')} *</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="0712345678"
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('members.idNumber')}</label>
                <input
                  type="text"
                  value={form.id_number}
                  onChange={(e) => setForm({ ...form, id_number: e.target.value })}
                  placeholder={t('common.optional')}
                />
              </div>
            </div>

            <div className="form-group">
              <label>{t('common.email')}</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder={t('login.emailPlaceholder')}
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>{t('common.password')} *</label>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder={t('login.passwordPlaceholder')}
                  minLength={6}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('auth.confirmPassword')} *</label>
                <input
                  type="password"
                  value={form.confirm_password}
                  onChange={(e) => setForm({ ...form, confirm_password: e.target.value })}
                  placeholder={t('login.repeatPassword')}
                  minLength={6}
                  required
                />
              </div>
            </div>

            <details className="optional-section">
              <summary>{t('login.emergencyOptional')}</summary>
              <div className="form-row" style={{ marginTop: 12 }}>
                <div className="form-group">
                  <label>{t('common.name')}</label>
                  <input
                    type="text"
                    value={form.emergency_contact_name}
                    onChange={(e) =>
                      setForm({ ...form, emergency_contact_name: e.target.value })
                    }
                  />
                </div>
                <div className="form-group">
                  <label>{t('common.phone')}</label>
                  <input
                    type="tel"
                    value={form.emergency_contact_phone}
                    onChange={(e) =>
                      setForm({ ...form, emergency_contact_phone: e.target.value })
                    }
                  />
                </div>
              </div>
            </details>

            <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
              {loading ? t('login.submitting') : t('login.submitApplication')}
            </button>

            <button
              type="button"
              className="btn btn-secondary btn-block"
              onClick={backToLogin}
              style={{ marginTop: 10 }}
            >
              <ArrowLeft size={16} /> {t('login.alreadyMember')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------- login --- */
  return (
    <div className="login-container">
      <div className="login-box">
        <div className="login-logo login-logo-brand">
          <ChamaLogo size={58} />
        </div>
        <h1>{chamaName}</h1>
        <p className="subtitle">{t('login.systemName')}</p>

        <div className="login-tabs">
          <div
            className={`login-tab${activeTab === 'admin' ? ' active' : ''}`}
            onClick={() => setActiveTab('admin')}
          >
            <Users size={16} />
            {t('login.tabAdmin')}
          </div>
          <div
            className={`login-tab${activeTab === 'member' ? ' active' : ''}`}
            onClick={() => setActiveTab('member')}
          >
            <User size={16} />
            {t('login.tabMember')}
          </div>
        </div>

        <form onSubmit={handleLogin}>
          {activeTab === 'admin' ? (
            <div className="form-group">
              <label>{t('auth.usernameOrEmail')}</label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="admin"
                autoComplete="username"
                required
              />
            </div>
          ) : (
            <div className="form-group">
              <label>{t('auth.phone')}</label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0712345678"
                required
              />
            </div>
          )}

          <div className="form-group">
            <label>{t('common.password')}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('login.passwordEntry')}
              required
            />
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? t('auth.signingIn') : t('auth.signIn')}
          </button>
        </form>

        <div className="register-cta">
          <div>
            <strong>{t('login.newToChama')}</strong>
            <span>{t('login.applyToBecome')}</span>
          </div>
          <button className="btn btn-secondary" onClick={() => setMode('register')}>
            <UserPlus size={16} /> {t('auth.register')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Login;