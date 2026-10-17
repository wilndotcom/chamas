import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { FormatProvider } from './context/FormatContext';
import { ThemeProvider } from './context/ThemeContext';
import { SettingsProvider } from './context/SettingsContext';
import { I18nProvider } from './i18n/I18nContext';
import ErrorBoundary from './components/ErrorBoundary';
import InstallPrompt from './components/InstallPrompt';
import { registerServiceWorker } from './pwa';
import { recoverFromRemovedChunks } from './preloadRecovery';
import axios from 'axios';
import './index.css';

/*
 * Registered before anything renders, because it has to be listening before the
 * first lazy route is imported. A deploy that removed this build's chunks makes
 * that import fail, and this turns the dead screen that follows into a reload
 * onto the current build. See preloadRecovery.js.
 */
recoverFromRemovedChunks();

/*
 * Where the API lives, derived from the same base as the router.
 *
 * Every request in the app is written as '/api/...'. Axios prepends baseURL to any
 * URL that is not protocol-absolute, and a single leading slash is not, so this
 * one line retargets all of them at '/the-team/api/...' when the app is served
 * from a folder - without touching a single call site, and without them being
 * able to disagree about it.
 */
axios.defaults.baseURL = import.meta.env.BASE_URL || '/';

// Order matters here.
//
// SettingsProvider is outermost of the stateful ones because formatting, theme and
// language all read the same settings from it, and letting each fetch separately
// meant four identical requests per page load and the interface settling in
// visible stages.
//
// AuthProvider sits above I18nProvider because I18n reads the signed-in account's
// own language. When it ran first, AuthProvider had not yet put the token on
// axios's default headers, so that request went out unauthenticated, came back 401,
// and every signed-in user silently got English.
//
// FormatProvider is innermost because it reads the active locale from the
// language provider.
/*
 * The prefix this build is served from, without a trailing slash.
 *
 * '/' at the root of a domain; '/the-team' when the app lives in a folder
 * alongside other apps. React Router's basename must not keep the trailing
 * slash or it matches nothing, which is why this is stripped.
 */
const routerBase = import.meta.env.BASE_URL.replace(/\/+$/, '');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/*
       * basename strips the deployment prefix from the routing.
       *
       * Without it a sub-path install sees the whole prefixed path as the route,
       * so nothing matched and every page came back blank. BASE_URL comes from
       * vite's ase, so the two can never disagree.
       */}
      <BrowserRouter basename={routerBase}>
        <SettingsProvider>
          <AuthProvider>
            <I18nProvider>
              <ThemeProvider>
                <FormatProvider>
                  <App />
                  {/* Outside the app shell so the sheet sits above the drawer and
                      account menu rather than behind them. */}
                  <InstallPrompt />
                  <Toaster position="top-right" />
                </FormatProvider>
              </ThemeProvider>
            </I18nProvider>
          </AuthProvider>
        </SettingsProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);

// Makes the app installable. Skipped in development, where a caching worker
// fights Vite's module loading.
registerServiceWorker();
