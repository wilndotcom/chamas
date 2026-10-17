import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useFormat } from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';
import ChamaLogo from '../components/ChamaLogo';
import ChangePasswordForm from '../components/ChangePasswordForm';
import { ShieldCheck, LogOut } from 'lucide-react';

/**
 * The screen an administrator gets instead of the app, once, on first sign-in.
 *
 * Administrator accounts are created on one shared password that is written into
 * the published source, so that getting in for the first time needs no generated
 * string read off a screen and typed correctly. This is the other half of that
 * bargain: the account is unusable until the password has been replaced.
 *
 * It replaces the whole application rather than sitting over it as a dialog.
 * A dismissible dialog is a suggestion, and anything reachable behind it would
 * still be reachable - the point is that there is nowhere else to go. The backend
 * enforces the same rule independently, so this is not the only thing standing in
 * the way; it is what makes the rule understandable instead of an unexplained
 * refusal from every request.
 *
 * Signing out is the only alternative offered, and it is offered deliberately:
 * the person may be on the wrong account, or may not be the person the account
 * was created for. Trapping them with no exit would turn a shared starter
 * password into a locked door.
 */
const FirstLoginPassword = () => {
  const { user, logout } = useAuth();
  const { chamaName } = useFormat();
  const { t } = useI18n();

  // Only the first name, because a full name in a sentence reads like a form
  // letter. Falls back to a plain greeting when there is no name to use.
  const firstName = (user?.full_name || '').trim().split(/\s+/)[0];

  return (
    <div className="login-container">
      <div className="login-box">
        <div className="login-logo login-logo-brand">
          <ChamaLogo size={58} />
        </div>

        <h1>{t('password.firstTitle')}</h1>
        <p className="subtitle">
          {firstName ? t('password.firstGreeting', { name: firstName }) : chamaName}
        </p>

        <div className="notice-strip">
          <ShieldCheck size={16} />
          <span>{t('password.firstBody')}</span>
        </div>

        <ChangePasswordForm submitLabel={t('password.setAndContinue')} />

        <button className="btn btn-secondary btn-block" onClick={logout} style={{ marginTop: 10 }}>
          <LogOut size={16} /> {t('password.signOutInstead')}
        </button>
      </div>
    </div>
  );
};

export default FirstLoginPassword;
