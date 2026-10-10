import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Download, X, Smartphone, Share, PlusSquare } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { onInstallRequested } from '../pwa';

/**
 * Install prompt.
 *
 * Behaviour the brief asked for:
 *   - opening the app on a phone offers to install it, without hunting for a menu
 *   - once installed, it never asks again
 *
 * Chrome and Edge only fire `beforeinstallprompt` when the page is installable,
 * so that event is treated as the permission to ask. iOS Safari never fires it
 * and cannot be scripted, so there the sheet explains how to add the app by hand.
 *
 * "Never asks again" is enforced by two independent signals: the `appinstalled`
 * event, and detecting that the page is already running standalone. Either one is
 * enough, so a missed event still cannot lead to a second request.
 */

const INSTALLED_KEY = 'pwa.installed';
const DISMISSED_KEY = 'pwa.dismissedAt';

// A dismissal is respected for this long before it is considered stale. Someone
// who said no may well change their mind; someone who installed never reaches it.
const DISMISS_COOLDOWN_DAYS = 30;

const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.matchMedia?.('(display-mode: fullscreen)').matches ||
  window.navigator.standalone === true;

const readFlag = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeFlag = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: the prompt may reappear, which is not harmful */
  }
};

/** iOS Safari is the only platform with no programmatic install. */
const isIos = () => {
  const ua = window.navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
};

/** iPadOS reports as a Mac, so the touch-point check is needed as well. */
const isIpadOs = () =>
  navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

const isHandheld = () =>
  /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(window.navigator.userAgent || '') ||
  isIpadOs();

/**
 * Lets the sheet be opened deliberately with ?install=1 on any device.
 *
 * Two reasons this is not test-only scaffolding: it lets someone check the flow
 * from a desktop browser before putting it in front of the group, and it gives
 * support a way to reproduce the sheet without a second phone. It can only ever
 * show the sheet - it cannot install anything by itself, since the real prompt is
 * still the browser's.
 */
const isForced = () => {
  try {
    return new URLSearchParams(window.location.search).get('install') === '1';
  } catch {
    return false;
  }
};

const InstallPrompt = () => {
  const { t } = useI18n();

  // The deferred event. Must be held onto: it can only be used once, and if it is
  // dropped the prompt silently never appears.
  const deferredRef = useRef(null);
  const [showSheet, setShowSheet] = useState(false);
  const [installed, setInstalled] = useState(() => readFlag(INSTALLED_KEY) === '1');
  const [canPrompt, setCanPrompt] = useState(false);
  const [needsManualSteps, setNeedsManualSteps] = useState(false);

  const shouldOffer = useCallback(() => {
    if (readFlag(INSTALLED_KEY) === '1') return false;
    if (isStandalone()) return false;
    // Not a phone, so there is nothing to install onto. A desktop user who wants
    // it can still reach it deliberately, with ?install=1 or from Settings.
    if (!isHandheld() && !isForced()) return false;

    const dismissedAt = Number(readFlag(DISMISSED_KEY));
    if (dismissedAt) {
      const days = (Date.now() - dismissedAt) / 86400000;
      if (days < DISMISS_COOLDOWN_DAYS) return false;
    }
    return true;
  }, []);

  useEffect(() => {
    // Already running from the home screen: record it and never ask again.
    if (isStandalone()) {
      writeFlag(INSTALLED_KEY, '1');
      setInstalled(true);
      return undefined;
    }

    if (!shouldOffer()) return undefined;

    // iOS gets the manual instructions; there is no event to wait for.
    if (isIos() || isIpadOs()) {
      setNeedsManualSteps(true);
      setShowSheet(true);
      return undefined;
    }

    if (isForced()) {
      // Shown straight away rather than waiting on an event that may never come.
      // The button enables itself if the browser does offer the prompt.
      setShowSheet(true);
    }

    const onBeforeInstall = (event) => {
      // Suppress the browser's own mini-infobar so the app can ask properly.
      event.preventDefault();
      deferredRef.current = event;
      setCanPrompt(true);
      setShowSheet(true);
    };

    const onInstalled = () => {
      deferredRef.current = null;
      setCanPrompt(false);
      setInstalled(true);
      setShowSheet(false);
      writeFlag(INSTALLED_KEY, '1');
      writeFlag(DISMISSED_KEY, null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [shouldOffer]);

  // Another tab installed it, or the flag was set by the Settings toggle.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === INSTALLED_KEY && event.newValue === '1') setInstalled(true);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  /*
   * Opened deliberately from the sidebar's "Install App" entry.
   *
   * Bypasses the handheld test that stops the sheet appearing on a desktop, because
   * this time someone asked for it - the same reason ?install=1 is honoured. It
   * still respects the installed flag, since there is nothing left to install once
   * the app is on the home screen and the button should not lead to a dead sheet.
   */
  useEffect(() => {
    return onInstallRequested(() => {
      if (readFlag(INSTALLED_KEY) === '1' || isStandalone()) return;
      // iOS gets the manual instructions: there is no event to wait for.
      setNeedsManualSteps(isIos() || isIpadOs());
      setShowSheet(true);
    });
  }, []);

  const dismiss = () => {
    writeFlag(DISMISSED_KEY, String(Date.now()));
    setShowSheet(false);
  };

  const install = async () => {
    const event = deferredRef.current;
    if (!event) {
      // The event can only be used once; if it is gone the browser has already
      // shown its own prompt or the app is installed.
      dismiss();
      return;
    }
    deferredRef.current = null;
    setShowSheet(false);
    try {
      await event.prompt();
      // `prompt()` resolves with the choice. The appinstalled event does the
      // recording, but resolving "dismissed" must still respect the cooldown.
      const { outcome } = await event.userChoice;
      if (outcome === 'accepted') {
        writeFlag(INSTALLED_KEY, '1');
        setInstalled(true);
      } else {
        dismiss();
      }
    } catch {
      dismiss();
    }
  };

  if (installed || !showSheet) return null;

  return (
    <>
      {/*
        The backdrop is deliberately non-dismissing: tapping outside should not
        silently record a dismissal the user never chose. Cancel does that
        explicitly, and stays available.
      */}
      <div className="install-overlay" role="dialog" aria-modal="true" aria-label={t('install.title')}>
        <div className="install-sheet">
          <button className="install-close" onClick={dismiss} aria-label={t('install.later')}>
            <X size={18} />
          </button>

          <div className="install-icon" aria-hidden="true">
            <img src="/icon-192.png" alt="" width="56" height="56" />
          </div>

          <h2 className="install-title">{t('install.title')}</h2>
          <p className="install-body">{t('install.body')}</p>

          <ul className="install-points">
            <li><Smartphone size={15} /> {t('install.pointFull')}</li>
            <li><Download size={15} /> {t('install.pointOffline')}</li>
            <li><PlusSquare size={15} /> {t('install.pointHome')}</li>
          </ul>

          {needsManualSteps ? (
            <div className="install-manual">
              <p>{t('install.iosShare')}</p>
              <ol>
                <li>{t('install.iosStep1')}</li>
                <li>{t('install.iosStep2')}</li>
                <li>{t('install.iosStep3')}</li>
              </ol>
              <button className="btn btn-secondary" onClick={dismiss}>
                {t('install.done')}
              </button>
            </div>
          ) : (
            <div className="install-actions">
              <button className="btn btn-primary" onClick={install} disabled={!canPrompt}>
                <Download size={16} /> {t('install.action')}
              </button>
              <button className="btn btn-secondary" onClick={dismiss}>
                {t('install.later')}
              </button>
            </div>
          )}

          {/*
            Honest about why the button is dead. Saying nothing and showing a
            disabled control looks like a bug rather than a browser decision.
          */}
          {!needsManualSteps && !canPrompt && (
            <p className="install-waiting">{t('install.waiting')}</p>
          )}

          <p className="install-footnote">
            <Share size={12} /> {t('install.onceOnly')}
          </p>
        </div>
      </div>
    </>
  );
};

export default InstallPrompt;