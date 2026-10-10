/**
 * M-Pesa configuration resolution.
 *
 * The Settings screen writes M-Pesa credentials into the `settings` table, but
 * the Daraja calls used to read `process.env` only. Saving a consumer key in the
 * UI therefore changed nothing, which looked exactly like the save failing.
 *
 * Resolution order for each value:
 *
 *   1. the settings table, when it holds something usable
 *   2. the environment, as a fallback for existing deployments
 *
 * A value counts as unusable when it is empty or still looks like a placeholder
 * (`your_...`, containing `xxx`), matching the rule the notifier already uses.
 * That way a fresh install falls back to `.env` instead of sending "your_key"
 * to Safaricom and getting an opaque rejection.
 */

const pool = require('../config/database');

// Credentials change rarely, but not never, so the lookup is cached briefly.
// Without a cache every STK push would add a database round trip; with no expiry
 // an admin's new key would not take effect until the process restarted.
const TTL_MS = 30 * 1000;

let cache = null;
let cachedAt = 0;

const PLACEHOLDER = /^(your[_-]|xxx|change_?me|todo|placeholder)/i;

const usable = (value) => {
  if (value === null || value === undefined) return false;
  const v = String(value).trim();
  if (v === '') return false;
  if (PLACEHOLDER.test(v)) return false;
  return true;
};

const fromEnv = (name) => (process.env[name] ? String(process.env[name]).trim() : '');

/** Reads one key from the settings table. */
const readSetting = async (key) => {
  const [rows] = await pool.execute(
    'SELECT setting_value FROM settings WHERE setting_key = ?',
    [key]
  );
  return rows.length ? rows[0].setting_value : null;
};

/**
 * Returns the effective M-Pesa configuration and where each value came from,
 * so Settings can show an operator whether a field is actually in use.
 */
const getMpesaConfig = async ({ fresh = false } = {}) => {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;

  const keys = [
    'mpesa_consumer_key',
    'mpesa_consumer_secret',
    'mpesa_shortcode',
    'mpesa_passkey',
    'mpesa_paybill',
    'mpesa_callback_url',
    'mpesa_environment'
  ];

  const fromDb = {};
  for (const key of keys) {
    fromDb[key] = await readSetting(key);
  }

  // The environment fallback gets the same placeholder check. Otherwise a
  // sample .env full of "your_consumer_key" would be treated as configured and
  // sent to Safaricom, which fails with an opaque rejection.
  const pick = (key, envName) => {
    const savedValue = String(fromDb[key] ?? '').trim();
    if (usable(savedValue)) return { value: savedValue, from: 'settings' };
    const envValue = fromEnv(envName);
    if (usable(envValue)) return { value: envValue, from: 'env' };
    return { value: '', from: 'unset' };
  };

  const k = pick('mpesa_consumer_key', 'MPESA_CONSUMER_KEY');
  const s = pick('mpesa_consumer_secret', 'MPESA_CONSUMER_SECRET');
  const sc = pick('mpesa_shortcode', 'MPESA_SHORTCODE');
  const pk = pick('mpesa_passkey', 'MPESA_PASSKEY');
  const pb = pick('mpesa_paybill', 'MPESA_SHORTCODE');
  // The callback is settable in Settings so nobody has to edit a file on the
  // server and restart. The placeholder is NOT filtered out here on purpose:
  // the caller needs to see it in order to warn that confirmations will not
  // arrive. The production/sandbox decision belongs to the caller, not here.
  const cb = String(fromDb.mpesa_callback_url ?? '').trim();

  /*
   * Which Daraja deployment to talk to.
   *
   * Settable in Settings because moving from sandbox testing to taking real money
   * is the one M-Pesa change an operator makes repeatedly, and it used to require
   * editing a file on the server and restarting it.
   *
   * Strictly "production" or not, rather than trusting whatever is stored.
   * Anything else is treated as sandbox: guessing wrong in that direction costs a
   * failed test rather than real money moving, and a stray value in the settings
   * table or .env must not resolve to the live endpoint by accident.
   */
  const envSaved = String(fromDb.mpesa_environment ?? '').trim().toLowerCase();
  const envIsLive = envSaved === 'production' || (!envSaved && fromEnv('MPESA_ENV') === 'production');

  cache = {
    env: envIsLive ? 'production' : 'sandbox',
    consumerKey: k.value,
    consumerSecret: s.value,
    shortcode: sc.value,
    passkey: pk.value,
    paybill: pb.value,
    callbackUrl: usable(cb) ? cb : fromEnv('MPESA_CALLBACK_URL'),
    source: {
      consumerKey: k.from,
      consumerSecret: s.from,
      shortcode: sc.from,
      passkey: pk.from,
      paybill: pb.from,
      callbackUrl: usable(cb) ? 'settings' : 'env',
      environment: envSaved ? 'settings' : fromEnv('MPESA_ENV') ? 'env' : 'default'
    },
    // The endpoint the environment resolves to, so Settings can show it and the
    // operator can confirm at a glance which Daraja they are pointed at.
    base_url: envIsLive
      ? 'https://api.safaricom.co.ke'
      : 'https://sandbox.safaricom.co.ke'
  };

  cachedAt = Date.now();
  return cache;
};

/** True when enough is present to attempt a Daraja call. */
const isConfigured = (cfg) =>
  Boolean(cfg.consumerKey && cfg.consumerSecret && cfg.shortcode && cfg.passkey);

/**
 * The base URL for the configured environment.
 *
 * Reads the value resolved in getMpesaConfig rather than re-deriving it, so the
 * URL Settings displays and the URL actually called cannot drift apart.
 */
const baseUrl = (cfg) =>
  cfg.base_url ||
  (cfg.env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke');

/** Drops the cache so a newly saved value is picked up at once. */
const invalidate = () => {
  cache = null;
  cachedAt = 0;
};

module.exports = { getMpesaConfig, isConfigured, baseUrl, invalidate, usable };