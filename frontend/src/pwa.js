/**
 * Service worker registration.
 *
 * Kept out of main.jsx because it is entirely optional: a failure here must
 * never stop the app from loading. It is also what makes the app installable, so
 * it is worth doing properly.
 *
 * Not registered in development. A worker caching hashed dev modules produces
 * stale-code bugs that are extremely hard to trace, and Vite handles its own
 * module loading. The install prompt still works in dev because Chrome only
 * needs the worker to be present, which it can be from the preview build.
 */
export const registerServiceWorker = () => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  // In dev, skip entirely. See the note above.
  if (import.meta.env.DEV) return;

  const register = () => {
    /*
     * Both the script and its scope come from the deployment base.
     *
     * A worker can only control paths at or below its own location, so a worker
     * registered at /sw.js cannot serve a sub-path install - and asking for a
     * scope it is not allowed to have throws, which was silently downgrading
     * every sub-path install to "cannot be installed".
     */
    const base = import.meta.env.BASE_URL || '/';

    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .then((registration) => {
        // An update that finished installing while the tab was open is applied
        // straight away rather than on the next cold start, so a fix reaches
        // someone who left the tab open overnight.
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              installing.postMessage('skip-waiting');
            }
          });
        });
      })
      .catch((error) => {
        // Deliberately non-fatal. The app runs fine without a worker; it simply
        // cannot be installed.
        console.warn('Service worker registration failed:', error.message);
      });
  };

  /*
   * Registering on `load` alone is a race: if the module happens to execute
   * after the load event has already fired, the listener never runs and the app
   * silently never becomes installable. Checking readyState covers both orders.
   */
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
};

/** Removes the worker and its caches. Used by Settings and by support. */
export const unregisterServiceWorker = async () => {
  if (!('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));
  if (window.caches) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('chama-')).map((k) => caches.delete(k)));
  }
};

export const isAppInstalled = () =>
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

/**
 * Marks the app as installed in this browser.
 *
 * The install sheet records this itself, but the Settings screen offers a manual
 * "already installed" path for people who installed from the browser menu rather
 * than the sheet, and it also lets anyone permanently stop being asked.
 */
export const markInstalled = () => {
  try {
    localStorage.setItem('pwa.installed', '1');
    localStorage.removeItem('pwa.dismissedAt');
  } catch {
    /* storage unavailable */
  }
};

/** Lets someone ask again, for the case where they dismissed it by accident. */
export const resetInstallPrompt = () => {
  try {
    localStorage.removeItem('pwa.installed');
    localStorage.removeItem('pwa.dismissedAt');
  } catch {
    /* storage unavailable */
  }
};

/*
 * Lets the sidebar's "Install App" entry open the install sheet that already
 * exists.
 *
 * A CustomEvent rather than shared React state, because the sheet is mounted once
 * at the root of main.jsx while the button sits in the sidebar, and there is no
 * provider they already share.
 *
 * Namespaced, since this is broadcast on `window` alongside every other event the
 * page listens to.
 */
const INSTALL_REQUEST_EVENT = 'chama:install-requested';

export const requestInstallPrompt = () => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(INSTALL_REQUEST_EVENT));
};

export const onInstallRequested = (handler) => {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(INSTALL_REQUEST_EVENT, handler);
  return () => window.removeEventListener(INSTALL_REQUEST_EVENT, handler);
};

/**
 * True when there is still something to install.
 *
 * Decides whether the sidebar shows the entry at all. Deliberately not a test for
 * browser support: iOS Safari never fires `beforeinstallprompt` but can still be
 * installed by hand, so treating that as "cannot install" would hide the only
 * instructions those phones ever get.
 */
export const canOfferInstall = () =>
  !isAppInstalled() && localStorage.getItem('pwa.installed') !== '1';