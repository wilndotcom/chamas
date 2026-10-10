/**
 * Notification channel configuration.
 *
 * The dispatcher used to read every credential from process.env and nothing else.
 * Settings offered an "SMS API key" field that saved successfully and was then
 * never consulted, so an operator could type a working key, be told it saved, and
 * send no messages at all. This module is the fix: the same settings-then-
 * environment resolution that M-Pesa uses, applied to every channel.
 *
 * Why the same shape as mpesaConfig rather than something new: the failure mode
 * to avoid is a credential living in one place while the code reads another, and
 * the only reliable defence is to resolve both sources in one place and report
 * which one won.
 */

const pool = require('../config/database');

// Credentials are cached briefly. Every reminder that fans out to N members would
// otherwise be N identical queries, but without an expiry a key saved in Settings
// would not take effect until the process restarted - which is exactly what made
// the old behaviour look broken.
const TTL_MS = 30 * 1000;

let cache = null;
let cachedAt = 0;

/**
 * Values still holding their sample value are treated as unset.
 *
 * Without this a .env full of `your_africas_talking_api_key` looks configured and
 * the dispatcher fires real API calls with junk credentials, producing provider
 * errors that name the credential rather than the mistake.
 */
const PLACEHOLDER = /^(your[_-]|xxx|change_?me|todo|placeholder)/i;

const usable = (value) => {
  if (value === null || value === undefined) return false;
  const v = String(value).trim();
  if (!v) return false;
  return !PLACEHOLDER.test(v.toLowerCase());
};

/**
 * Channels that accept a custom HTTP provider, and the settings each one owns.
 *
 * Declared above KEYS because KEYS builds its own list from them, and a `const`
 * cannot be read before its own declaration. Getting that order wrong is a
 * ReferenceError at require time, which takes the whole API down rather than
 * failing one channel.
 *
 * Email is deliberately absent: it is SMTP by definition, and a "custom HTTP"
 * email sender is not something any provider offers, so the field would be one
 * nobody could fill correctly.
 */
/**
 * Channels that accept a custom HTTP provider, and the settings each one owns.
 *
 * Declared above KEYS because KEYS builds its own list from them, and a `const`
 * cannot be read before its own declaration. Getting that order wrong is a
 * ReferenceError at require time, which takes the whole API down rather than
 * failing one channel.
 *
 * Email is deliberately absent: it is SMTP by definition, and a "custom HTTP"
 * email sender is not something any provider offers, so the field would be one
 * nobody could fill correctly.
 */
const CUSTOM_CHANNELS = ['sms', 'whatsapp'];

const CUSTOM_SUFFIXES = [
  'endpoint', 'method', 'auth_type', 'auth_header', 'auth_value',
  'username', 'password', 'body', 'phone_format', 'sender'
];

const KEYS = [
  'sms_provider',
  // Was missing from this list while the resolver already read it, so the channel
  // silently reported the hardcoded default no matter what was saved. A key read
  // below but absent here is a setting that saves and does nothing.
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
  'email_from',
  'channel_sms_enabled',
  'channel_whatsapp_enabled',
  'channel_email_enabled',
  ...CUSTOM_CHANNELS.flatMap((ch) => CUSTOM_SUFFIXES.map((s) => `custom_${ch}_${s}`))
];

/** Which .env variable backs each setting, for the fallback and for reporting. */
const ENV_BACKING = {
  sms_username: 'SMS_USERNAME',
  sms_api_key: 'SMS_API_KEY',
  sms_sender_id: 'SMS_SENDER_ID',
  twilio_account_sid: 'TWILIO_ACCOUNT_SID',
  twilio_auth_token: 'TWILIO_AUTH_TOKEN',
  twilio_sms_from: 'TWILIO_SMS_FROM',
  twilio_whatsapp_number: 'TWILIO_WHATSAPP_NUMBER',
  email_host: 'EMAIL_HOST',
  email_port: 'EMAIL_PORT',
  email_user: 'EMAIL_USER',
  email_pass: 'EMAIL_PASS',
  email_from: 'EMAIL_FROM',
  // Only the identifying values have environment fallbacks. The request body and
  // auth mode are app-specific, so there is nothing sensible to name for them.
  custom_sms_endpoint: 'CUSTOM_SMS_ENDPOINT',
  custom_sms_auth_value: 'CUSTOM_SMS_AUTH_VALUE',
  custom_sms_username: 'CUSTOM_SMS_USERNAME',
  custom_sms_password: 'CUSTOM_SMS_PASSWORD',
  custom_sms_sender: 'CUSTOM_SMS_SENDER',
  custom_whatsapp_endpoint: 'CUSTOM_WHATSAPP_ENDPOINT',
  custom_whatsapp_auth_value: 'CUSTOM_WHATSAPP_AUTH_VALUE',
  custom_whatsapp_username: 'CUSTOM_WHATSAPP_USERNAME',
  custom_whatsapp_password: 'CUSTOM_WHATSAPP_PASSWORD',
  custom_whatsapp_sender: 'CUSTOM_WHATSAPP_SENDER'
};



const fromEnv = (name) => (process.env[name] ? String(process.env[name]).trim() : '');

/** True for "1", "true", "yes", "on". Anything else means off. */
const flagOn = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

const readSettings = async () => {
  const placeholders = KEYS.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT setting_key, setting_value FROM settings WHERE setting_key IN (${placeholders})`,
    KEYS
  );
  const map = {};
  for (const row of rows) map[row.setting_key] = row.setting_value;
  return map;
};

/**
 * Everything the dispatcher and the Settings screen need to know about messaging.
 *
 * `configured` is per channel and means "credentials are present and usable".
 * `enabled` is a separate switch, so a channel can hold a working key and still
 * be switched off. Conflating the two is what makes "I saved the key but nothing
 * sends" impossible to diagnose from the screen.
 */
const getNotificationConfig = async ({ fresh = false } = {}) => {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;

  const stored = await readSettings();

  const pick = (key, fallbackDefault = '') => {
    const saved = String(stored[key] ?? '').trim();
    if (usable(saved)) return { value: saved, from: 'settings' };
    const env = fromEnv(ENV_BACKING[key] || '');
    if (usable(env)) return { value: env, from: 'env' };
    return { value: fallbackDefault, from: fallbackDefault ? 'default' : 'unset' };
  };

  // The enabled flags never fall back to the environment: switching a channel on
  // must be a deliberate act in Settings, not a side effect of a .env that
  // happens to hold a credential.
  const enabled = {
    sms: flagOn(stored.channel_sms_enabled ?? '1'),
    whatsapp: flagOn(stored.channel_whatsapp_enabled),
    email: flagOn(stored.channel_email_enabled)
  };

  const at = {
    username: pick('sms_username'),
    apiKey: pick('sms_api_key'),
    senderId: pick('sms_sender_id', 'THE_TEAM')
  };
  const tw = {
    sid: pick('twilio_account_sid'),
    token: pick('twilio_auth_token'),
    smsFrom: pick('twilio_sms_from'),
    whatsappFrom: pick('twilio_whatsapp_number')
  };
  const mail = {
    host: pick('email_host'),
    port: pick('email_port', '587'),
    user: pick('email_user'),
    pass: pick('email_pass'),
    from: pick('email_from')
  };

  const smsProviderRaw = String(stored.sms_provider || '').trim();
  const whatsappProviderRaw = String(stored.whatsapp_provider || '').trim();

  /*
   * The custom HTTP provider, resolved per channel.
   *
   * A request body template and an auth mode have no sensible environment
   * variable behind them, so those are read straight from the stored value. The
   * identifying fields still go through `pick` so they keep the same
   * settings-then-environment order as everything else.
   */
  const custom = {};
  for (const ch of CUSTOM_CHANNELS) {
    const c = {};
    for (const suffix of CUSTOM_SUFFIXES) {
      const key = 'custom_' + ch + '_' + suffix;
      if (suffix === 'method') {
        c[suffix] = usable(stored[key]) ? String(stored[key]).trim().toUpperCase() : 'POST';
      } else if (suffix === 'auth_type') {
        const mode = String(stored[key] || '').trim();
        c[suffix] = ['none', 'bearer', 'header', 'basic'].includes(mode) ? mode : 'none';
      } else if (suffix === 'phone_format') {
        // WhatsApp APIs want +254... while Daraja wants 254... with no plus.
        // Asked for rather than guessed, because guessing silently sends nowhere.
        c[suffix] = String(stored[key] || '').trim().startsWith('+') ? '+254' : '254';
      } else {
        c[suffix] = pick(key).value;
      }
    }

    c.missing = [];
    if (!usable(c.endpoint)) c.missing.push(ch + '_endpoint');
    if (!usable(c.body)) c.missing.push(ch + '_body');
    if (c.auth_type === 'header') {
      if (!usable(c.auth_header)) c.missing.push(ch + '_auth_header');
      if (!usable(c.auth_value)) c.missing.push(ch + '_auth_value');
    }
    if (c.auth_type === 'bearer' && !usable(c.auth_value)) c.missing.push(ch + '_auth_value');
    if (c.auth_type === 'basic') {
      if (!usable(c.username)) c.missing.push(ch + '_username');
      if (!usable(c.password)) c.missing.push(ch + '_password');
    }

    // A body that is not valid JSON would be rejected by the server at send time,
    // after the operator believed the channel was configured.
    c.bodyValid = false;
    if (usable(c.body)) {
      const rendered = c.body.replace(/\{\{phone\}\}/g, '254712345678')
        .replace(/\{\{message\}\}/g, 'x')
        .replace(/\{\{from\}\}/g, 'THE_TEAM');
      try {
        JSON.parse(rendered);
        c.bodyValid = true;
      } catch {
        c.bodyValid = false;
        c.missing.push(ch + '_body (not valid JSON)');
      }
    }

    c.ready = c.missing.length === 0;
    custom[ch] = c;
  }

  const smsProvider = smsProviderRaw === 'twilio' || smsProviderRaw === 'custom'
    ? smsProviderRaw
    : 'africas_talking';
  const whatsappProvider = whatsappProviderRaw === 'custom' ? 'custom' : 'twilio';

  const atReady = Boolean(usable(at.username.value) && usable(at.apiKey.value));
  const twReady = Boolean(usable(tw.sid.value) && usable(tw.token.value));
  const mailReady = Boolean(usable(mail.host.value) && usable(mail.user.value) && usable(mail.pass.value));

  // Which provider actually gets used, decided once here so the dispatcher and
  // the status screen cannot disagree.
  const smsUsesTwilio = smsProvider === 'twilio' ? twReady : false;
  const smsUsable = smsProvider === 'twilio'
    ? twReady
    : smsProvider === 'custom'
      ? custom.sms.ready
      : atReady;
  const whatsappUsable = whatsappProvider === 'custom'
    ? custom.whatsapp.ready
    : twReady && Boolean(usable(tw.whatsappFrom.value));

  cache = {
    enabled,
    smsProvider,
    whatsappProvider,
    custom,
    at: { username: at.username.value, apiKey: at.apiKey.value, senderId: at.senderId.value },
    twilio: {
      sid: tw.sid.value,
      token: tw.token.value,
      smsFrom: tw.smsFrom.value,
      whatsappFrom: tw.whatsappFrom.value
    },
    email: {
      host: mail.host.value,
      port: Number(mail.port.value) || 587,
      user: mail.user.value,
      pass: mail.pass.value,
      from: mail.from.value
    },
    source: {
      sms_username: at.username.from,
      sms_api_key: at.apiKey.from,
      sms_sender_id: at.senderId.from,
      twilio_account_sid: tw.sid.from,
      twilio_auth_token: tw.token.from,
      twilio_sms_from: tw.smsFrom.from,
      twilio_whatsapp_number: tw.whatsappFrom.from,
      email_host: mail.host.from,
      email_port: mail.port.from,
      email_user: mail.user.from,
      email_pass: mail.pass.from,
      email_from: mail.from.from
    },
    /**
     * Per channel, so the screen can say which single thing is missing rather
     * than "not configured" with no clue.
     */
    channels: {
      sms: {
        enabled: enabled.sms,
        provider: smsProvider,
        configured: smsUsable,
        sends: smsUsesTwilio,
        // Named for the provider actually selected, not for whichever one happens
        // to be complete. Listing Africa's Talking fields while Twilio is chosen
        // sends the operator off to fill in credentials that will never be read.
        missing:
          smsProvider === 'custom'
            ? custom.sms.missing
            : smsProvider === 'twilio'
              ? twReady ? [] : ['twilio_account_sid', 'twilio_auth_token']
              : atReady ? [] : ['sms_username', 'sms_api_key']
      },
      whatsapp: {
        enabled: enabled.whatsapp,
        provider: whatsappProvider,
        configured: whatsappUsable,
        missing:
          whatsappProvider === 'custom'
            ? custom.whatsapp.missing
            : !twReady
              ? ['twilio_account_sid', 'twilio_auth_token']
              : ['twilio_whatsapp_number']
      },
      email: {
        enabled: enabled.email,
        provider: 'smtp',
        configured: mailReady,
        missing: ['email_host', 'email_user', 'email_pass']
      }
    }
  };

  cachedAt = Date.now();
  return cache;
};

/** Drops the cache so a key saved in Settings is in use on the next send. */
const invalidate = () => {
  cache = null;
  cachedAt = 0;
};

module.exports = {
  getNotificationConfig,
  invalidate,
  usable,
  flagOn,
  KEYS,
  ENV_BACKING
};