import React, { useState } from 'react';
import { useI18n } from '../i18n/I18nContext';
import { useAuth } from '../context/AuthContext';
import { translateError } from '../utils/translateError';
import toast from 'react-hot-toast';
import { KeyRound } from 'lucide-react';

/**
 * Changing the signed-in administrator's own password.
 *
 * One component, used in two places, because the two situations are the same
 * action seen from different sides:
 *
 *   - The first sign-in, where it is the only thing the account may do
 *     (see pages/FirstLoginPassword.jsx).
 *   - Any time afterwards, from the account menu, where it is a precaution
 *     somebody takes because a password may have been seen over their shoulder.
 *
 * There was previously no way to do this at all. The endpoint has existed on both
 * backends since they were written, and nothing in the interface called it - so
 * the only way an administrator could change their own password was for somebody
 * else to reset it, or to run a seed script that rewrote every account. That is
 * worse than it sounds: it is the reason the four administrator accounts ended up
 * sharing one password in the first place.
 *
 * The current password is always asked for, including on the first sign-in where
 * it was just typed. Passwords are not cached in state, and asking again is the
 * only thing that distinguishes the person the account was handed to from whoever
 * found an unattended laptop.
 */
const ChangePasswordForm = ({ onChanged, onCancel, submitLabel }) => {
  const { t } = useI18n();
  const { changePassword } = useAuth();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();

    /*
     * Checked here as well as at the API, and the wording is deliberate: this is
     * the message somebody sees while they are still able to fix it without
     * losing what they typed.
     */
    if (next.length < 8) {
      toast.error(t('err.passwordShort'));
      return;
    }

    if (next !== confirm) {
      toast.error(t('err.passwordMismatch'));
      return;
    }

    if (next === current) {
      toast.error(t('password.mustDiffer'));
      return;
    }

    setBusy(true);
    try {
      await changePassword(current, next);

      // Cleared so a second change in the same session does not offer the
      // previous password back to the browser's autofill.
      setCurrent('');
      setNext('');
      setConfirm('');

      toast.success(t('password.changed'));
      onChanged?.();
    } catch (error) {
      toast.error(translateError(error, t, t('err.passwordChangeFailed')), { duration: 6000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="form-group">
        <label>{t('password.current')}</label>
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          autoFocus
          required
        />
      </div>

      <div className="form-group">
        <label>{t('password.new')}</label>
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
        />
        <small className="field-note">{t('password.rule')}</small>
      </div>

      <div className="form-group">
        <label>{t('password.confirm')}</label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
        />
      </div>

      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        <KeyRound size={16} />
        {busy ? t('password.saving') : (submitLabel || t('password.save'))}
      </button>

      {onCancel && (
        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={onCancel}
          style={{ marginTop: 10 }}
          disabled={busy}
        >
          {t('common.cancel')}
        </button>
      )}
    </form>
  );
};

export default ChangePasswordForm;
