/**
 * Extra translations, split by area so several parts of the codebase can be
 * translated in parallel without editing one shared file.
 *
 * English is still the source of truth and the fallback, so a key missing here
 * simply shows English rather than breaking.
 *
 * Each part exports { en: {...}, sw: {...} }.
 */
import dashboards from './dashboards';
import money from './money';
import admin from './admin';

export const parts = { dashboards, money, admin };

/** Flattens the parts into the two lookup tables I18nContext uses. */
export const mergeParts = () => {
  const out = { en: {}, sw: {} };
  for (const group of Object.values(parts)) {
    for (const lang of ['en', 'sw']) {
      out[lang] = { ...out[lang], ...(group[lang] || {}) };
    }
  }
  return out;
};