import React, { useState, useEffect } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { useFormat } from '../context/FormatContext';
import Footer from './Footer';

/**
 * Shown when the stored session is still valid but the server cannot be reached.
 *
 * This exists because the alternative was worse. The app used to treat any failed
 * profile check as "signed out" and delete the token, so a server restart under
 * nodemon, a dropped connection or a slow response threw a valid session away and
 * put the user back on the login screen. Nothing had actually been wrong with
 * their credentials.
 *
 * It retries by itself and gets out of the way the moment the server answers, so
 * the normal case is that nobody ever sees this.
 */
const ConnectionLostNotice = () => {
  const { t } = useI18n();
  const { opts: fmt } = useFormat();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    // Counts up so the wait is visible rather than looking frozen.
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);

    // Poll until the server answers again. A full reload is the honest test: it
    // re-runs the whole startup path, including the profile check that failed.
    const retry = setInterval(() => {
      fetch('/api/health')
        .then((res) => {
          if (res.ok) window.location.reload();
        })
        .catch(() => {
          // Still down. Keep waiting.
        });
    }, 5000);

    return () => {
      clearInterval(timer);
      clearInterval(retry);
    };
  }, []);

  return (
    <div className="login-page">
      <div className="login-card" style={{ textAlign: 'center' }}>
        <div style={{ color: 'var(--brand)', marginBottom: 16 }}>
          <CloudOff size={44} />
        </div>

        <h2 style={{ marginTop: 0 }}>{t('auth.connectionLostTitle')}</h2>
        <p style={{ color: 'var(--text-muted)' }}>{t('auth.connectionLostBody')}</p>

        {/*
          Stated plainly so nobody retypes a password that was never the problem.
          This is the whole point of the screen.
        */}
        <p
          style={{
            fontSize: 13,
            background: 'var(--surface-2, rgba(255,255,255,0.06))',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 12px'
          }}
        >
          {t('auth.stillSignedIn')}
        </p>

        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {t('auth.retryingIn', { seconds })}
        </p>

        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          <RefreshCw size={16} /> {t('auth.tryAgain')}
        </button>
      </div>
      <Footer variant="onDark" />
    </div>
  );
};

export default ConnectionLostNotice;