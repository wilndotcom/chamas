import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';

/**
 * The one place public settings are fetched.
 *
 * This existed three times over: FormatContext, ThemeContext and I18nContext each
 * called `/api/settings/public` on mount, so every page load made four requests
 * (eight under StrictMode) and the interface re-rendered once per response. The
 * pages settled in visible stages, which read as flickering.
 *
 * Fetching once and sharing it removes the duplicate work and makes every
 * consumer update in the same paint, so branding, skin, formatting and language
 * all arrive together.
 *
 * `revision` increments on every load. Components that need to re-read derived
 * values depend on it, which is cheaper and less error-prone than each of them
 * polling the API.
 */

const SettingsContext = createContext(null);

export const usePublicSettings = () => useContext(SettingsContext);

/** Unauthenticated and cheap: only what the sign-in screen and shell need. */
export const SettingsProvider = ({ children }) => {
  const [opts, setOpts] = useState({});
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    try {
      const [{ data }, profile] = await Promise.all([
        axios.get('/api/settings/public'),
        // The logo is optional: a missing logo must not stop the settings loading.
        axios.get('/api/chama/profile').catch(() => ({ data: {} }))
      ]);

      const next = {};
      (data.settings || []).forEach((s) => {
        if (s.setting_value !== null && s.setting_value !== '') {
          next[s.setting_key] = s.setting_value;
        }
      });

      next.chama_logo_updated_at = profile.data?.updated_at || null;
      next.chama_has_logo = !!profile.data?.has_logo;

      setOpts(next);
      setRevision((n) => n + 1);

      const name = (next.chama_name || '').trim();
      if (name) document.title = `${name} - Chama Management`;
    } catch (error) {
      // Every consumer has a usable default, so a failure here degrades quietly
      // rather than blocking the app.
      console.warn('Could not load public settings:', error.message);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const value = useMemo(
    () => ({ opts, ready, revision, reload: load }),
    [opts, ready, revision, load]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
};

export default SettingsProvider;