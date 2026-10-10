const pool = require('../config/database');

/**
 * Keys an operator may change from the Settings screen.
 *
 * Deliberately an allowlist rather than "anything with a matching row":
 *  - `install_id` is excluded so it cannot be reset from the UI. Changing it
 *    would break the link between a support report and this installation.
 *  - `allow_impersonation` is a security toggle, changed deliberately rather
 *    than as a side effect of saving a card.
 *  Roles and permissions live in their own tables and are not settings at all.
 *
 * `theme` and `color_mode` are the shared look behind Appearance. They were
 * missing here while the screen offered to save them, which made "save for
 * everyone" fail with "theme cannot be changed from here".
 */
const EDITABLE = new Set([
  'chama_name',
  'monthly_contribution',
  'welfare_contribution',
  'loan_interest_rate',
  'loan_duration_months',
  'max_loan_multiplier',
  'language',
  'currency',
  'currency_symbol',
  'symbol_position',
  'decimal_separator',
  'thousand_separator',
  'theme',
  'color_mode',
  'mpesa_paybill',
  'mpesa_shortcode',
  'mpesa_consumer_key',
  'mpesa_consumer_secret',
  'mpesa_passkey',
  'mpesa_callback_url',
  'mpesa_environment',
  'airtel_environment',
  'airtel_api_key',
  'airtel_api_password',
  'airtel_api_username',
  'airtel_merchant_id',
  'airtel_service_provider_id',
  'email_from',

  // ---- Notification channels (migration 014) ----
  // `sms_api_key` was already listed here and still did nothing, because
  // utils/notifier.js read process.env exclusively. Everything below is what the
  // dispatcher actually consults now.
  'sms_provider',
  'whatsapp_provider',
  'sms_username',
  'sms_api_key',
  'sms_sender_id',
  'twilio_account_sid',
  'twilio_auth_token',
  'twilio_sms_from',
  'twilio_whatsapp_number',
  'email_host',
  'email_port',
  'email_user',
  'email_pass',

  // On/off switches, separate from having credentials. An operator can hold a
  // working key and still want SMS switched off, and conflating the two makes
  // "saved the key but nothing sends" impossible to diagnose.
  'channel_sms_enabled',
  'channel_whatsapp_enabled',
  'channel_email_enabled',

  // Custom HTTP provider (migration 015). Generated because the twenty keys follow
  // one pattern across two channels; listing them by hand is how one gets missed
  // and saves as a rejected field with no obvious cause.
  ...['sms', 'whatsapp'].flatMap((ch) =>
    ['endpoint', 'method', 'auth_type', 'auth_header', 'auth_value', 'username',
     'password', 'body', 'phone_format', 'sender'].map((s) => `custom_${ch}_${s}`)
  )
]);

/** Keys for one channel's custom HTTP provider. Shared with the frontend shape. */
const customKeys = (channel) =>
  ['endpoint', 'method', 'auth_type', 'auth_header', 'auth_value', 'username',
   'password', 'body', 'phone_format', 'sender'].map((s) => `custom_${channel}_${s}`);

// Friendly names, so a validation error reads as "Loan interest rate must be
// between 0 and 100." rather than repeating the raw column name.
const LABELS = {
  loan_interest_rate: 'Loan interest rate',
  loan_duration_months: 'Loan duration',
  max_loan_multiplier: 'Max loan multiplier',
  monthly_contribution: 'Monthly contribution',
  welfare_contribution: 'Welfare contribution',
  theme: 'Colour skin',
  color_mode: 'Colour mode',
  mpesa_environment: 'M-Pesa environment',
  airtel_environment: 'Airtel Money environment',
  sms_provider: 'SMS provider',
  whatsapp_provider: 'WhatsApp provider',
  sms_username: "Africa's Talking username",
  sms_api_key: "Africa's Talking API key",
  sms_sender_id: "Africa's Talking sender id",
  twilio_account_sid: 'Twilio Account SID',
  twilio_auth_token: 'Twilio Auth Token',
  twilio_sms_from: 'Twilio SMS sender',
  twilio_whatsapp_number: 'Twilio WhatsApp sender',
  email_host: 'SMTP host',
  email_port: 'SMTP port',
  email_user: 'SMTP username',
  email_pass: 'SMTP password',
  channel_sms_enabled: 'SMS channel',
  channel_whatsapp_enabled: 'WhatsApp channel',
  channel_email_enabled: 'Email channel',
  airtel_api_key: 'Airtel Money API key',
  airtel_api_password: 'Airtel Money API password',
  airtel_api_username: 'Airtel Money API username',
  airtel_merchant_id: 'Airtel Money merchant id',
  airtel_service_provider_id: 'Airtel Money service provider id'
};

/**
 * Closed sets, for values the interface offers as a fixed list.
 *
 * The skin list mirrors the `[data-theme='...']` blocks in index.css and the
 * THEMES array in ThemeContext.jsx. The frontend already falls back to a default
 * for anything unrecognised, but storing the bad value would report a successful
 * save while quietly showing something else, so it is rejected here instead.
 */
const ALLOWED_VALUES = {
  theme: ['emerald', 'ocean', 'sunset', 'forest', 'plum', 'slate'],
  color_mode: ['light', 'dark'],
  // A closed set on purpose. Anything else here would be passed to Safaricom as
  // the base URL, and a typo must not resolve to the live endpoint by accident.
  mpesa_environment: ['sandbox', 'production'],
  airtel_environment: ['sandbox', 'production'],


  // The channel switches. Stored as 0/1 so the column stays a single character,
  // and closed so nothing else can arrive in it and be read as truthy.
  channel_sms_enabled: ['0', '1'],
  channel_whatsapp_enabled: ['0', '1'],
  channel_email_enabled: ['0', '1'],

  // The custom provider's fixed choices. Closed so a typo cannot be stored and
  // then silently treated as the default at send time.
  sms_provider: ['africas_talking', 'twilio', 'custom'],
  whatsapp_provider: ['twilio', 'custom'],

  // Object.fromEntries, not a spread of pairs: `[k, v].flat()` splits each pair
  // into two separate array elements rather than making one entry, so the keys
  // were silently absent from this object and every custom value skipped
  // validation - a stored "DELETE" method that only failed at send time.
  ...Object.fromEntries(
    ['sms', 'whatsapp'].flatMap((ch) => [
      [`custom_${ch}_method`, ['POST', 'PUT']],
      [`custom_${ch}_auth_type`, ['none', 'bearer', 'header', 'basic']],
      [`custom_${ch}_phone_format`, ['254', '+254']]
    ])
  )
};

/**
 * Sentinels for values that must never be sent to a browser.
 *
 * Two, doing different jobs:
 *
 *   SECRET_MASK  what a read returns in place of a stored secret. The screen
 *                shows it as "already saved" rather than as characters.
 *   KEEP_SENTINEL what a write may send to mean "leave this alone".
 *
 * The second exists because Settings saves a whole card at once. If a read
 * returned a masked value and the screen sent it back untouched, the stored
 * secret would be overwritten with the mask and M-Pesa would break for every
 * operator who touched an unrelated field on the same card. Empty is NOT used for
 * this, because empty already means "clear this", which an operator must remain
 * able to do.
 */
const SECRET_MASK = '__saved__';
const KEEP_SENTINEL = '__keep__';

/**
 * Settings holding a live third-party credential.
 *
 * Read with `system_settings` and returned in full by getAllSettings, which made
 * the Daraja consumer secret and STK passkey readable over one GET. The intent not
 * to leak them already existed in mpesaStatus, which masks; this is the same rule
 * applied to the endpoint that was actually being used.
 *
 * The consumer key is included even though Safaricom treats it as an identifier:
 * it is half of the pair that authorises money movement, and there is no reason
 * for the browser to hold it.
 */
const SECRET_KEYS = new Set([
  'mpesa_consumer_key',
  'mpesa_consumer_secret',
  'mpesa_passkey',
  'airtel_api_key',
  'airtel_api_password',
  // Notification channel credentials. Same reasoning: each one authorises sending
  // to real phone numbers at the operator's expense, and a read of the settings
  // screen would otherwise hand over a working API key.
  'sms_api_key',
  'twilio_auth_token',
  'twilio_account_sid',
  'email_pass',
  // Custom HTTP credentials. A bearer token or an API key pasted into a header is
  // exactly as sensitive as the provider credentials above it.
  ...['sms', 'whatsapp'].flatMap((ch) => [
    `custom_${ch}_auth_value`,
    `custom_${ch}_password`
  ])
]);

/** True when a value is one of the sentinels rather than real input. */
const isSentinel = (value) => value === KEEP_SENTINEL || value === SECRET_MASK;

/**
 * Rejects a custom endpoint that points at this machine or a private network.
 *
 * Checked on save rather than only at send, so the Settings screen refuses it
 * while the operator is looking at the field. Sending from a treasurer's
 * screen to the server's own internal endpoints is not something to leave open.
 */
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?|::1$|metadata\.|.*\.internal$)/i;

const validateCustomEndpoint = (key, raw) => {
  if (!raw) return null; // Unset is handled by the "configured" check, not here.
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return `${key} is not a valid URL.`;
  }
  if (!/^https?:$/.test(url.protocol)) {
    return `${key} must start with http:// or https://.`;
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    return (
      `${key} points at this machine or a private network address (${url.hostname}), ` +
      'which cannot be a payment gateway. Use the public https address your provider gave you.'
    );
  }
  return null;
};

const NUMERIC_RULES = {
  // Interest is a flat percentage charged on the principal.
  loan_interest_rate: { min: 0, max: 100 },
  loan_duration_months: { min: 1, max: 60, integer: true },
  max_loan_multiplier: { min: 1, max: 100 },
  monthly_contribution: { min: 0, max: 100000000, allowDecimal: true },
  welfare_contribution: { min: 0, max: 100000000, allowDecimal: true }
};

/**
 * Validates one value. Returns { ok, value } or { ok: false, error }.
 *
 * Empty is allowed for the credential fields: an operator may legitimately clear
 * one, and the notifier already treats empty or placeholder values as
 * "not configured" rather than attempting a call.
 */
const validate = (key, raw) => {
  if (raw === null || raw === undefined) return { ok: true, value: '' };
  const value = String(raw);

  // A card save carries every field on it, so an untouched secret arrives as the
  // mask. Recognised here and reported separately, because writing it would
  // replace a working credential with eight characters.
  if (isSentinel(value)) return { ok: true, value: null, keep: true };

  // The custom endpoint, checked here so a bad address is refused on save with a
  // message naming the field, instead of being stored and failing on the next send.
  if (/_endpoint$/.test(key)) {
    const problem = validateCustomEndpoint(key, value);
    if (problem) return { ok: false, error: problem };
  }

  // A body that cannot be parsed as JSON, even with placeholders substituted,
  // would be rejected by the endpoint at send time.
  if (/_body$/.test(key) && value) {
    try {
      JSON.parse(
        String(value)
          .replace(/\{\{phone\}\}/g, '254712345678')
          .replace(/\{\{message\}\}/g, 'x')
          .replace(/\{\{from\}\}/g, 'THE_TEAM')
      );
    } catch (error) {
      return {
        ok: false,
        error:
          `${key} is not valid JSON: ${error.message}. ` +
          'It must be a JSON object such as {"to":"{{phone}}","message":"{{message}}"}.'
      };
    }
  }

  const choices = ALLOWED_VALUES[key];
  if (choices && !choices.includes(value)) {
    return {
      ok: false,
      error: `${LABELS[key] || key} must be one of: ${choices.join(', ')}.`
    };
  }

  const rule = NUMERIC_RULES[key];
  if (!rule) return { ok: true, value: value.slice(0, 255) };

  const n = Number(value);
  if (value === '' || !Number.isFinite(n)) {
    return { ok: false, error: `${LABELS[key] || key} must be a number.` };
  }
  if (rule.integer && !Number.isInteger(n)) {
    return { ok: false, error: `${LABELS[key] || key} must be a whole number.` };
  }
  if (!rule.integer && !rule.allowDecimal && !Number.isInteger(n * 100)) {
    return { ok: false, error: `${LABELS[key] || key} may have at most two decimal places.` };
  }
  if (n < rule.min || n > rule.max) {
    return {
      ok: false,
      error: `${LABELS[key] || key} must be between ${rule.min} and ${rule.max}.`
    };
  }
  return { ok: true, value };
};

// Get all settings
const getAllSettings = async (req, res) => {
  try {
    const [settings] = await pool.execute('SELECT * FROM settings ORDER BY setting_key');

    // Credentials are replaced with a sentinel rather than returned. An unset
    // secret stays unset, so the screen can still tell "not configured yet" from
    // "configured and hidden".
    res.json({
      settings: settings.map((row) =>
        SECRET_KEYS.has(row.setting_key) && String(row.setting_value || '').trim()
          ? { ...row, setting_value: SECRET_MASK }
          : row
      ),
      // Told to the client rather than left for it to infer from the mask, so a
      // screen cannot accidentally render the sentinel as a real value.
      secret_keys: [...SECRET_KEYS]
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
};

/**
 * Saves several settings in one transaction.
 *
 * One request per card rather than one per field: a partially-applied save is
 * worse than a failed one, because the operator cannot tell which half stuck.
 * Either every key is written or none is.
 */
const updateSettings = async (req, res) => {
  const values = req.body?.values;

  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return res.status(400).json({ error: 'Send { values: { key: value } }.' });
  }

  const keys = Object.keys(values);
  if (keys.length === 0) {
    return res.status(400).json({ error: 'Nothing to save.' });
  }

  const rejected = keys.filter((k) => !EDITABLE.has(k));
  if (rejected.length) {
    return res
      .status(400)
      .json({ error: `These settings cannot be changed here: ${rejected.join(', ')}` });
  }

  // Validate every key before opening the transaction, so a bad value cannot
  // leave half a card applied.
  for (const key of keys) {
    const result = validate(key, values[key]);
    if (!result.ok) return res.status(400).json({ error: result.error });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let written = 0;
    let kept = 0;

    for (const key of keys) {
      const result = validate(key, values[key]);

      // An untouched secret is left alone rather than written, so saving an
      // unrelated field on the same card cannot destroy a working credential.
      if (result.keep) {
        kept += 1;
        continue;
      }

      await conn.execute(
        `INSERT INTO settings (setting_key, setting_value, updated_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           setting_value = VALUES(setting_value),
           updated_by = VALUES(updated_by)`,
        [key, result.value, req.user.id]
      );
      written += 1;
    }

    await conn.commit();

    // M-Pesa credentials are cached briefly. Dropping the cache here means a
    // key saved in Settings is in use on the next request rather than up to
    // 30 seconds later, which previously made a successful save look inert.
    if (keys.some((k) => k.startsWith('mpesa_'))) {
      require('../utils/mpesaConfig').invalidate();
    }

    // Same trap for the notification channels. Without this, switching a channel
    // on and immediately pressing Test reports "switched off", because the
    // dispatcher is still holding a config cached up to 30 seconds earlier. A
    // save that appears to do nothing is the exact failure this file keeps
    // having to be corrected for.
    if (keys.some((k) => k.startsWith('sms_') || k.startsWith('twilio_') ||
      k.startsWith('channel_') || k.startsWith('whatsapp_') ||
      k.startsWith('email_'))) {
      require('../utils/notificationConfig').invalidate();
    }

    res.json({ success: true, saved: keys.length, keys });
  } catch (error) {
    await conn.rollback();
    console.error('Bulk settings save failed:', error);
    res.status(500).json({ error: 'Could not save settings. Nothing was changed.' });
  } finally {
    conn.release();
  }
};

// Update a single setting
const updateSetting = async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (!EDITABLE.has(key)) {
      return res.status(400).json({ error: `${key} cannot be changed from here.` });
    }

    const result = validate(key, value);
    if (!result.ok) return res.status(400).json({ error: result.error });

    // An untouched secret is a no-op, not a write. Without this, reading a
    // credential (which returns the mask) and saving it straight back would
    // replace a working API key with the mask itself.
    if (result.keep) {
      return res.json({ success: true, key, unchanged: true });
    }

    const [written] = await pool.execute(
      'UPDATE settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?',
      [result.value, req.user.id, key]
    );

    if (written.affectedRows === 0) {
      // This used to report success while writing nothing, which is how a field
      // could look saved and never persist.
      return res.status(404).json({ error: `No setting called ${key} exists.` });
    }

    // Both caches, for the same reason as the bulk save: a credential saved here
    // must be the one the next request uses, not one cached up to 30 seconds ago.
    if (key.startsWith('mpesa_')) require('../utils/mpesaConfig').invalidate();
    if (key.startsWith('sms_') || key.startsWith('twilio_') || key.startsWith('channel_') ||
      key.startsWith('whatsapp_') || key.startsWith('email_')) {
      require('../utils/notificationConfig').invalidate();
    }

    res.json({ success: true, key, value: result.value });
  } catch (error) {
    console.error('Update setting error:', error);
    res.status(500).json({ error: 'Failed to update setting.' });
  }
};

// Get public settings (for member portal)
/**
 * Public settings.
 *
 * Readable without authentication because the client needs them to format every
 * amount on screen. Nothing sensitive is exposed here.
 */
const getPublicSettings = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT setting_key, setting_value FROM settings
       WHERE setting_key IN (
         'chama_name', 'monthly_contribution', 'welfare_contribution',
         'language', 'currency', 'currency_symbol',
         'symbol_position', 'decimal_separator', 'thousand_separator',
         'theme', 'color_mode'
       )`
    );
    res.json({ settings: rows });
  } catch (error) {
    console.error('Get public settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
};

/**
 * Build and licence identity, for the Settings "About" panel.
 *
 * Lets an operator confirm which build they are running, and gives the
 * developer a reference when triaging a report. The install id is generated
 * locally on first boot; nothing is sent anywhere.
 */
const getAbout = async (req, res) => {
  try {
    const { getBuildInfo } = require('../utils/identity');
    const [members] = await pool.execute('SELECT COUNT(*) AS total FROM members');
    const build = await getBuildInfo(members[0].total);

    res.json({
      ...build,
      booted_at: new Date().toISOString(),
      // Reporting stays off unless the operator supplies their own endpoint.
      reporting_configured: !!process.env.WILNCOM_REPORT_URL,
      reporting_disclosure:
        'No data is sent anywhere unless WILNCOM_REPORT_URL is set on this server. ' +
        'Even then it carries only version, build id, install id and a member count — ' +
        'never member names, phone numbers or money.'
    });
  } catch (error) {
    console.error('Get about error:', error);
    res.status(500).json({ error: 'Failed to load build information.' });
  }
};

module.exports = {
  getAllSettings,
  updateSettings,
  updateSetting,
  getPublicSettings,
  getAbout
};
