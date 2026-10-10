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
import './index.css';

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
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
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
