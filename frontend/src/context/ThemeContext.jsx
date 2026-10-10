import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { usePublicSettings } from './SettingsContext';

const ThemeContext = createContext(null);

export const useTheme = () => useContext(ThemeContext);

export const THEMES = [
  { id: 'emerald', name: 'Emerald', brand: '#16a34a', accent: '#0d9488', sidebar: '#0f3d22' },
  { id: 'ocean', name: 'Ocean', brand: '#2563eb', accent: '#0891b2', sidebar: '#12233f' },
  { id: 'sunset', name: 'Sunset', brand: '#ea580c', accent: '#db2777', sidebar: '#3f1d0f' },
  { id: 'forest', name: 'Forest', brand: '#0d9488', accent: '#4d7c0f', sidebar: '#0c2f2b' },
  { id: 'plum', name: 'Plum', brand: '#7c3aed', accent: '#db2777', sidebar: '#2c1a47' },
  { id: 'slate', name: 'Slate', brand: '#475569', accent: '#0891b2', sidebar: '#1e293b' }
];

export const MODES = [
  { id: 'light', name: 'Light', icon: 'sun' },
  { id: 'dark', name: 'Dark', icon: 'moon' }
];

const DEFAULTS = { theme: 'emerald', color_mode: 'light' };

const VALID_THEME = (id) => (THEMES.some((t) => t.id === id) ? id : DEFAULTS.theme);
const VALID_MODE = (id) => (['light', 'dark'].includes(id) ? id : DEFAULTS.color_mode);

/** Writes the attributes the stylesheet keys off. */
const applyToDom = (theme, mode) => {
  const root = document.documentElement;
  root.setAttribute('data-theme', VALID_THEME(theme));
  root.setAttribute('data-mode', VALID_MODE(mode));

  /*
   * Keep the browser chrome in step with the skin.
   *
   * On Android the address bar is tinted with theme-color, so a fixed value would
   * leave a green bar above a plum app the moment an admin changed the skin. Read
   * from the computed custom property rather than hardcoding a second palette, so
   * the two can never disagree.
   */
  const brand = getComputedStyle(root).getPropertyValue('--brand').trim();
  if (brand) {
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', brand);
  }
};

/**
 * Applies the shared skin chosen in Settings.
 *
 * The server value is the default so everyone in the chama sees the same look.
 * A per-browser override in localStorage wins, which lets one admin work in
 * dark mode without changing the whole group.
 */
export const ThemeProvider = ({ children }) => {
  const [theme, setThemeState] = useState(DEFAULTS.theme);
  const [mode, setModeState] = useState(DEFAULTS.color_mode);
  const { opts: sharedOpts, ready: sharedReady, reload: reloadSettings } = usePublicSettings();

  const apply = useCallback((nextTheme, nextMode) => {
    const t = VALID_THEME(nextTheme);
    const m = VALID_MODE(nextMode);
    setThemeState(t);
    setModeState(m);
    applyToDom(t, m);
    try {
      localStorage.setItem('uiTheme', t);
      localStorage.setItem('uiMode', m);
    } catch {
      /* storage unavailable: theme just won't persist */
    }
  }, []);

  /** This browser's own override, or null when it follows the shared look. */
  const readLocal = useCallback(() => {
    try {
      return {
        theme: localStorage.getItem('uiTheme'),
        mode: localStorage.getItem('uiMode')
      };
    } catch {
      return { theme: null, mode: null };
    }
  }, []);

  /**
   * Reconciles the shared skin with any local override.
   *
   * Reads from SettingsProvider instead of fetching, because this used to be the
   * third independent request for the same settings and it resolved on a
   * different tick to the formatting and language providers. That is what made
   * the page visibly settle in stages rather than appearing at once.
   *
   * Runs whenever the shared settings arrive and again after a save, and does
   * nothing until they have, so the skin never jumps after the page has settled.
   */
  useEffect(() => {
    if (!sharedReady) return;

    const local = readLocal();
    const t = VALID_THEME(local.theme || sharedOpts.theme);
    const m = VALID_MODE(local.mode || sharedOpts.color_mode);
    setThemeState(t);
    setModeState(m);
    applyToDom(t, m);
  }, [sharedOpts, sharedReady, readLocal]);

  // Apply a local override before the network answers, so a returning user never
  // sees the shared skin appear and then get replaced.
  useEffect(() => {
    const local = readLocal();
    if (local.theme || local.mode) {
      apply(local.theme || DEFAULTS.theme, local.mode || DEFAULTS.color_mode);
    }
  }, [apply, readLocal]);

  /** Change only this browser, leaving the shared setting alone. */
  const setTheme = useCallback((next) => apply(next, mode), [apply, mode]);
  const setMode = useCallback((next) => apply(theme, next), [apply, theme]);

  /** Change the shared setting for everyone, and this browser with it. */
  const setShared = useCallback(
    async (key, value) => {
      try {
        await axios.put(`/api/settings/${key}`, { value });
        if (key === 'theme') apply(value, mode);
        else apply(theme, value);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.response?.data?.error || 'Failed to save' };
      }
    },
    [apply, theme, mode]
  );

  /** Drop the local override and go back to the shared setting. */
  const useShared = useCallback(async () => {
    try {
      localStorage.removeItem('uiTheme');
      localStorage.removeItem('uiMode');
    } catch {
      /* ignore */
    }
    // Dropping the override hands control back to the shared settings, so pick
    // those up rather than asking the server for them a second time.
    reloadSettings();
    apply(VALID_THEME(sharedOpts.theme), VALID_MODE(sharedOpts.color_mode));
  }, [apply, reloadSettings, sharedOpts]);

  const isOverridden = useCallback(() => {
    try {
      return Boolean(localStorage.getItem('uiTheme') || localStorage.getItem('uiMode'));
    } catch {
      return false;
    }
  }, []);

  return (
    <ThemeContext.Provider
      value={{ theme, mode, setTheme, setMode, setShared, useShared, isOverridden, themes: THEMES, modes: MODES }}
    >
      {children}
    </ThemeContext.Provider>
  );
};