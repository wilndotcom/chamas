import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { dictionaries as coreDictionaries, LANGUAGES, SUPPORTED_CODES, LOCALES } from './dictionaries';
import { mergeParts } from './parts';
import { usePublicSettings } from '../context/SettingsContext';

// Area-specific keys live in parts/ so they can be filled in independently. Core
// vocabulary wins on a collision, because that is what the rest of the app already
// assumes is translated.
const parts = mergeParts();
export const dictionaries = {
  en: { ...parts.en, ...coreDictionaries.en },
  sw: { ...parts.sw, ...coreDictionaries.sw }
};

/**
 * Interface language.
 *
 * Resolution order, most specific first:
 *   1. this account's saved preference  (PUT /api/me/language)
 *   2. localStorage, so the correct language paints before the network answers
 *   3. the group default in Settings    (the `language` setting)
 *   4. English
 *
 * localStorage is only a cache for the first paint. The saved account preference
 * always wins once it arrives, so clearing it on one device does not strand that
 * device on a stale language.
 *
 * Every lookup falls back to English, so a missing translation shows readable
 * text instead of a raw key.
 */

const I18nContext = createContext(null);

export const useI18n = () => useContext(I18nContext);

const STORAGE_KEY = 'uiLanguage';

// Where t() prefers English. Kept outside React so the static formatters can use
// it before anything has mounted.
let activeCode = 'en';
export const currentLanguage = () => activeCode;
export const localeFor = (code = activeCode) => LOCALES[code] || LOCALES.en;

const normalise = (code) => (SUPPORTED_CODES.includes(code) ? code : null);

const readCache = () => {
  try {
    return normalise(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
};

const writeCache = (code) => {
  try {
    if (code) localStorage.setItem(STORAGE_KEY, code);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private browsing or storage disabled; the language still applies this session */
  }
};

/** Substitutes {name} placeholders. Missing values are left visible on purpose. */
const interpolate = (template, params) => {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
};

export const I18nProvider = ({ children }) => {
  const { opts: sharedOpts, ready: sharedReady } = usePublicSettings();
  // Start from the cache so a returning user gets the right language on the very
  // first paint, with no request needed.
  const [lang, setLang] = useState(() => readCache() || 'en');
  // True once the account preference and the group default have both been checked.
  const [settled, setSettled] = useState(false);
  // The account's saved choice, or null when it follows the group. Exposed so
  // Settings can show the current value without fetching it a second time.
  const [accountLanguage, setAccountLanguage] = useState(null);

  activeCode = lang;

  const apply = useCallback((code) => {
    const next = normalise(code) || 'en';
    activeCode = next;
    setLang(next);
    writeCache(next);

    // Keep the document honest: assistive technology and the browser's own
    // translation prompt both read these, and wrong values mislead both.
    const root = document.documentElement;
    root.setAttribute('lang', next);
    root.setAttribute('dir', 'ltr');
  }, []);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      // The group default comes from SettingsProvider, which already fetched it.
      // Only the signed-in account's own choice needs a request.
      const group = normalise(sharedOpts.language);

      let mine = null;
      const token = localStorage.getItem('token');
      if (token) {
        try {
          // The header is sent explicitly rather than relying on
          // axios.defaults, which AuthProvider sets in its own effect. Depending
          // on that is what made this 401 and silently fall back to English:
          // provider order decided whether the saved language was honoured.
          const { data } = await axios.get('/api/me/language', {
            headers: { Authorization: `Bearer ${token}` }
          });
          mine = normalise(data.language);
        } catch {
          /* not signed in, or endpoint unavailable */
        }
      }

      if (cancelled) return;
      setAccountLanguage(mine);
      apply(mine || group || readCache() || 'en');
      setSettled(true);
    };

    // Wait for the shared settings, otherwise the group default is missed and the
    // language settles twice: once from the cache, then again when settings land.
    if (sharedReady) boot();
    return () => {
      cancelled = true;
    };
  }, [apply, sharedOpts, sharedReady]);

  // Safety net. The boot path always settles, but if a request were to hang the
  // app would sit behind a blank screen, which is a worse failure than showing
  // English for a moment. Bounded so it can never get stuck.
  useEffect(() => {
    if (settled) return undefined;
    const timer = setTimeout(() => {
      apply(readCache() || 'en');
      setSettled(true);
    }, 2500);
    return () => clearTimeout(timer);
  }, [settled, apply]);

  /** Lookup for the active language, falling back to English then the key. */
  const t = useCallback(
    (key, params) => {
      const table = dictionaries[lang] || dictionaries.en;
      const template = table[key] ?? dictionaries.en[key];
      if (template === undefined) {
        // Loud in development, silent in production: a visible [key] in the UI
        // would look like a bug to whoever is using the app.
        if (import.meta.env.DEV) {
          console.warn(`[i18n] missing translation for "${key}"`);
        }
        return key;
      }
      return interpolate(template, params);
    },
    [lang]
  );

  /**
   * Switches this account's language and remembers it.
   *
   * Keeps `accountLanguage` in step so a screen showing the saved value (Settings)
   * reflects the change without refetching.
   */
  const setLanguage = useCallback(
    async (code) => {
      const next = normalise(code);
      apply(next || 'en');
      if (!next) return { success: false };

      if (!localStorage.getItem('token')) {
        setAccountLanguage(null);
        return { success: true };
      }

      try {
        const token = localStorage.getItem('token');
        const { data } = await axios.put(
          '/api/me/language',
          { language: next },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        setAccountLanguage(next);
        return { success: true, message: data.message };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || 'Could not save your language.'
        };
      }
    },
    [apply]
  );

  const value = useMemo(
    () => ({ lang, t, setLanguage, languages: LANGUAGES, settled, accountLanguage }),
    [lang, t, setLanguage, settled, accountLanguage]
  );

  /**
   * Hold the app back until the language is known.
   *
   * Rendering children first and correcting afterwards meant a Kiswahili user saw
   * the whole interface in English for a moment and then watched it switch, which
   * is exactly the flash this was meant to avoid. A cache hit paints immediately
   * with no waiting at all.
   *
   * `settled` can also fail to flip if the request errors, so it is bounded by a
   * short timer: the app must never be stuck behind a spinner.
   */
  if (!settled) return null;

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

/**
 * Standalone lookup for code outside React, such as toast helpers in callbacks.
 * Reads whatever the provider last applied.
 */
export const translate = (key, params) => {
  const table = dictionaries[activeCode] || dictionaries.en;
  const template = table[key] ?? dictionaries.en[key];
  return template === undefined ? key : interpolate(template, params);
};

export default I18nProvider;