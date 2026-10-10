import React, { createContext, useContext, useMemo } from 'react';
import { localeFor } from '../i18n/I18nContext';
import { usePublicSettings } from './SettingsContext';

const FormatContext = createContext(null);

export const useFormat = () => useContext(FormatContext);

export const DEFAULTS = {
  language: 'en',
  currency: 'KES',
  currency_symbol: 'KSh',
  symbol_position: 'before',
  decimal_separator: '.',
  thousand_separator: ',',
  // The brand shown until an operator sets a name in Settings. Also the
  // fallback if the saved name is blank.
  chama_name: 'THE TEAM'
};

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'sw', label: 'Kiswahili' },
  { code: 'fr', label: 'Français' },
  { code: 'ar', label: 'العربية' }
];

export const CURRENCIES = [
  { code: 'KES', label: 'Kenyan Shilling (KES)' },
  { code: 'TZS', label: 'Tanzanian Shilling (TZS)' },
  { code: 'UGX', label: 'Ugandan Shilling (UGX)' },
  { code: 'USD', label: 'US Dollar (USD)' },
  { code: 'EUR', label: 'Euro (EUR)' },
  { code: 'GBP', label: 'British Pound (GBP)' },
  { code: 'ZAR', label: 'South African Rand (ZAR)' },
  { code: 'RWF', label: 'Rwandan Franc (RWF)' }
];

/**
 * Builds formatting functions from the admin's preferences.
 *
 * Done by hand rather than with toLocaleString because browsers disagree about
 * space separators and about where a currency symbol belongs, and a chama needs
 * the printed amount to look exactly like the books.
 */
const buildFormatter = (opts) => {
  const decimal = opts.decimal_separator || DEFAULTS.decimal_separator;
  // 'none' is the sentinel stored in settings for "no thousands separator".
  const thousand =
    opts.thousand_separator === 'none'
      ? ''
      : (opts.thousand_separator ?? DEFAULTS.thousand_separator);
  const symbol = opts.currency_symbol || DEFAULTS.currency_symbol;
  const before = opts.symbol_position !== 'after';

  const group = (intPart) => {
    if (!thousand) return intPart;
    const escaped = thousand === '.' ? '\\.' : thousand === ',' ? ',' : '\\ ';
    return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousand);
  };

  const number = (value, decimals) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '0';

    let fixed;
    if (decimals === 0 || Number.isInteger(num)) {
      fixed = String(Math.round(num));
    } else {
      fixed = num.toFixed(decimals === undefined ? 2 : decimals);
    }

    const negative = fixed.startsWith('-');
    if (negative) fixed = fixed.slice(1);

    const [int, frac] = fixed.split('.');
    const out = group(int) + (frac ? decimal + frac : '');
    return negative ? `-${out}` : out;
  };

  const money = (value, decimals) => {
    const body = number(value, decimals);
    const plain = Number(value);
    if (before) return `${symbol} ${body}`.trim();
    return `${body} ${symbol}`.trim();
  };

  /** Percentage with up to one decimal, e.g. 12.5% */
  const percent = (value) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return '0%';
    const body = Number.isInteger(num) ? String(num) : num.toFixed(1);
    return `${body.replace('.', decimal)}%`;
  };

  const date = (value, options) => {
    if (!value) return '—';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    // Locale comes from the chosen language, but is pinned to a fixed variant so
    // two members of the same chama see identical printed dates regardless of
    // their own device settings.
    return d.toLocaleDateString(localeFor(), options || { day: 'numeric', month: 'short', year: 'numeric' });
  };

  return { money, number, percent, date, opts };
};

/**
 * Supplies money()/number()/date() helpers built from system settings and
 * exposes them so the Settings screen can preview changes live.
 *
 * The settings themselves now come from SettingsProvider, which fetches them once
 * per page load. This provider used to fetch them itself, which meant a second
 * request and a second re-render on every page.
 */
export const FormatProvider = ({ children }) => {
  const { opts: shared, ready, revision, reload } = usePublicSettings();

  // Merged over the defaults so a setting that has not loaded, or was cleared,
  // still renders with a sane value.
  const opts = useMemo(() => ({ ...DEFAULTS, ...shared }), [shared]);

  const helpers = useMemo(() => buildFormatter(opts), [opts]);

  // The name always has a value, so no screen can render a blank brand.
  const chamaName = (opts.chama_name || '').trim() || DEFAULTS.chama_name;

  return (
    <FormatContext.Provider value={{ ...helpers, opts, chamaName, revision, reload }}>
      {children}
    </FormatContext.Provider>
  );
};

/**
 * Standalone formatter for callers outside React (or before settings load).
 * Returns the whole helper set so callers can pick money/number/percent.
 */
export const formatWith = (opts) => buildFormatter({ ...DEFAULTS, ...opts });