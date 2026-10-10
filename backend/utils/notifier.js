/**
 * Notification dispatcher.
 *
 * Credentials come from utils/notificationConfig, which resolves the settings table
 * first and the environment second. Reading process.env directly here is what made
 * the "SMS API key" field in Settings a no-op: it saved to the database while this
 * file kept using .env, so a correct key appeared to do nothing.
 *
 * Each channel reports honestly when it is not usable, so a chama can run with
 * only SMS enabled and still see that WhatsApp or email was skipped rather than
 * silently marked as sent.
 *
 * Supported providers (choose per channel in Settings, or fall back to .env):
 *   SMS       Africa's Talking (sms_username + sms_api_key)
 *             or Twilio       (twilio_account_sid + twilio_auth_token)
 *   WhatsApp  Twilio         (twilio_account_sid + twilio_auth_token + whatsapp sender)
 *   Email     SMTP via Nodemailer (email_host / email_user / email_pass)
 */

const axios = require('axios');
const { getNotificationConfig } = require('./notificationConfig');

/**
 * Kenyan numbers to the international form an API expects.
 *
 * Returns null rather than a best guess for anything unrecognised: sending to a
 * malformed number costs money and delivers nothing, so an unrecognised input is
 * reported to the operator instead.
 */
const normalisePhone = (phone) => {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return null;
};

const isPlaceholder = (value) => {
  if (value === undefined || value === null) return true;
  const s = String(value).trim().toLowerCase();
  if (!s) return true;
  return (
    s.startsWith('your') ||
    s.includes('xxx') ||
    s.includes('change_this') ||
    s.includes('placeholder') ||
    s.includes('your_') ||
    s.endsWith('_here')
  );
};

/* ---------------------------------------------------------------- SMS --- */

const sendViaAfricasTalking = async (phone, message, cfg) => {
  const body = new URLSearchParams({
    username: cfg.at.username,
    to: phone,
    message,
    from: cfg.at.senderId || 'THE_TEAM'
  });

  const res = await axios.post(
    'https://api.africastalking.com/version1/messaging',
    body.toString(),
    {
      headers: {
        apiKey: cfg.at.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  const entry = res.data?.SMSMessageData?.[0];
  // A 200 from the API only means the message was accepted. A rejected recipient
  // comes back inside the body, and reporting that as success would leave the
  // operator believing a member had been told.
  if (entry && /Rejected/i.test(entry.status || '')) {
    return {
      success: false,
      provider: "africa's talking",
      error: entry.status
    };
  }
  return {
    success: true,
    provider: "africa's talking",
    detail: entry?.status || 'submitted'
  };
};

const sendViaTwilioSms = async (phone, message, cfg) => {
  const body = new URLSearchParams({
    To: phone,
    From: cfg.twilio.smsFrom || phone,
    Body: message
  });

  const res = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio.sid}/Messages.json`,
    body.toString(),
    {
      auth: { username: cfg.twilio.sid, password: cfg.twilio.token },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );
  return { success: true, provider: 'twilio', detail: res.data?.status, sid: res.data?.sid };
};

const sendSMS = async (to, message) => {
  const phone = normalisePhone(to);
  if (!phone) return { success: false, error: `Unusable phone number: ${to}` };

  const cfg = await getNotificationConfig();
  if (!cfg.channels.sms.enabled) {
    return { success: false, skipped: true, reason: 'SMS is switched off in Settings' };
  }
  // Checked before the call, not after the error. Firing a request with blank
  // credentials spends a network round trip to be told "401 Unauthorized", which
  // reads as bad credentials rather than as the missing ones not yet entered.
  if (!cfg.channels.sms.configured) {
    return {
      success: false,
      skipped: true,
      reason: 'SMS is not set up yet. Still needed: ' + cfg.channels.sms.missing.join(', ')
    };
  }

  try {
    // Which provider is used is decided once in notificationConfig, so this and
    // the Settings status screen cannot pick different ones.
    if (cfg.channels.sms.provider === 'custom') {
      return await sendViaCustomHttp('sms', phone, message, cfg);
    }
    return cfg.channels.sms.provider === 'twilio'
      ? await sendViaTwilioSms(phone, message, cfg)
      : await sendViaAfricasTalking(phone, message, cfg);
  } catch (error) {
    return {
      success: false,
      provider: cfg.channels.sms.provider === 'twilio' ? 'twilio' : "africa's talking",
      error: error.response?.data?.message || error.message
    };
  }
};

/* ----------------------------------------------------------- WhatsApp --- */

/*
 * Twilio only.
 *
 * WhatsApp is not self-service: Meta has to approve the business and the sender,
 * and Twilio's sandbox only reaches numbers you have verified in the console. That
 * is a real constraint, not an oversight, so the Settings screen says what is
 * missing rather than presenting this as a provider choice between equals.
 */
const sendWhatsApp = async (to, message) => {
  const phone = normalisePhone(to);
  if (!phone) return { success: false, error: `Unusable phone number: ${to}` };

  const cfg = await getNotificationConfig();
  if (!cfg.channels.whatsapp.enabled) {
    return { success: false, skipped: true, reason: 'WhatsApp is switched off in Settings' };
  }
  // Named before the call. Twilio returns 401 for a missing sender just as it
  // does for a wrong one, and the two need different fixes.
  if (!cfg.channels.whatsapp.configured) {
    return {
      success: false,
      skipped: true,
      reason: 'WhatsApp is not set up yet. Still needed: ' + cfg.channels.whatsapp.missing.join(', ')
    };
  }


  if (cfg.channels.whatsapp.provider === 'custom') {
    try {
      return await sendViaCustomHttp('whatsapp', phone, message, cfg);
    } catch (error) {
      return {
        success: false,
        provider: 'custom http',
        error: error.response?.data?.message || error.message
      };
    }
  }

  try {
    const body = new URLSearchParams({
      To: `whatsapp:${phone}`,
      From: cfg.twilio.whatsappFrom,
      Body: message
    });

    const res = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.twilio.sid}/Messages.json`,
      body.toString(),
      {
        auth: { username: cfg.twilio.sid, password: cfg.twilio.token },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    return {
      success: true,
      provider: 'twilio-whatsapp',
      detail: res.data?.status,
      // Twilio's own wording for a message that has not been delivered to a real
      // handset. Surfaced rather than swallowed, because in the sandbox it is the
      // expected result and treating it as a failure is equally misleading.
      sandboxed: res.data?.status === 'accepted'
    };
  } catch (error) {
    return {
      success: false,
      provider: 'twilio-whatsapp',
      error: error.response?.data?.message || error.message
    };
  }
};

/* -------------------------------------------------------------- Email --- */

const sendEmail = async (to, subject, message) => {
  if (!to) return { success: false, skipped: true, reason: 'Member has no email address' };

  const cfg = await getNotificationConfig();
  if (!cfg.channels.email.enabled) {
    return { success: false, skipped: true, reason: 'Email is switched off in Settings' };
  }
  if (!cfg.channels.email.configured) {
    return { success: false, skipped: true, reason: 'SMTP is not configured in Settings' };
  }

  try {
    // Required lazily so the app still boots without email set up.
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: cfg.email.host,
      port: cfg.email.port,
      secure: cfg.email.port === 465,
      auth: { user: cfg.email.user, pass: cfg.email.pass }
    });

    const info = await transporter.sendMail({
      from: cfg.email.from || cfg.email.user,
      to,
      subject,
      text: message
    });
    return { success: true, provider: 'smtp', detail: info.messageId };
  } catch (error) {
    return { success: false, provider: 'smtp', error: error.message };
  }
};

/* ------------------------------------------------------- Custom HTTP --- */

/*
 * Refuses an endpoint that points back at the machine or its network.
 *
 * A custom provider means the app will POST to a URL an operator typed. Without
 * this, anyone holding `system_settings` could aim the sender at
 * http://localhost:5000/... and make the server call its own internal APIs,
 * including ones that take no token because they are meant to be reached only by
 * Safaricom. Not a privilege escalation for the owner, but not something to
 * leave open to a treasurer either.
 *
 * Deliberately coarse. It blocks the ranges no real SMS gateway lives in and
 * leaves a note, rather than attempting to resolve DNS and reason about rebinding.
 */
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?|::1$|metadata\.|.*\.internal$)/i;

const validateCustomEndpoint = (raw) => {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, error: 'The endpoint is not a valid URL.' };
  }

  if (!/^https?:$/.test(url.protocol)) {
    return {
      ok: false,
      error:
        'The endpoint must start with http:// or https://. Got ' + url.protocol.replace(':', '') + '.'
    };
  }

  if (PRIVATE_HOST.test(url.hostname)) {
    return {
      ok: false,
      error:
        'The endpoint points at this machine or a private network address (' +
        url.hostname +
        '), which cannot be a payment gateway. Use the public https address your provider gave you.'
    };
  }

  return { ok: true, url };
};

/** Substitutes the caller's placeholders into the request body template. */
const renderCustomBody = (template, { phone, message, sender }) =>
  String(template || '')
    .replace(/\{\{phone\}\}/g, phone)
    .replace(/\{\{message\}\}/g, message)
    .replace(/\{\{from\}\}/g, sender || '');

/**
 * Sends through whatever HTTP endpoint the operator configured.
 *
 * Returns the provider's own response body on both success and failure. With an
 * unnamed vendor there is no field to check for success, so the response is handed
 * back verbatim and the Test button shows it: a provider that answers
 * `{"status":"failed"}` with HTTP 200 is a real possibility, and hiding the body
 * would make that look like a working send.
 */
const sendViaCustomHttp = async (channel, phone, message, cfg) => {
  const conf = cfg.custom[channel];
  const checked = validateCustomEndpoint(conf.endpoint);

  if (!checked.ok) {
    return { success: false, skipped: true, reason: checked.error };
  }

  // Built with the full international form, then reshaped per the convention the
  // endpoint expects. Daraja wants 2547... with no plus; WhatsApp APIs want +2547...
  const withPlus = phone.startsWith('0') ? '+' + phone.replace(/^0/, '254') : '+' + phone;
  const formatted =
    conf.phone_format === '+254' ? withPlus : withPlus.replace(/^\+/, '');

  const rendered = renderCustomBody(conf.body, {
    phone: formatted,
    message,
    sender: conf.sender
  });

  let parsed;
  try {
    parsed = JSON.parse(rendered);
  } catch (error) {
    return {
      success: false,
      skipped: true,
      reason:
        'The request body template is not valid JSON: ' +
        error.message +
        '. Check it before saving.'
    };
  }

  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  let auth;

  if (conf.auth_type === 'bearer') {
    headers.Authorization = 'Bearer ' + conf.auth_value;
  } else if (conf.auth_type === 'header') {
    headers[conf.auth_header] = conf.auth_value;
  } else if (conf.auth_type === 'basic') {
    auth = { username: conf.username, password: conf.password };
  }

  try {
    const res = await axios.request({
      method: conf.method,
      url: checked.url.toString(),
      headers,
      auth,
      data: parsed,
      timeout: 20000,
      // The endpoint is the operator's own gateway and may use a self-signed
      // certificate on a local test server, but a production endpoint with an
      // invalid certificate must fail rather than be silently trusted.
      validateStatus: () => true
    });

    const body =
      typeof res.data === 'string' ? res.data.slice(0, 600) : JSON.stringify(res.data || {}).slice(0, 600);

    if (res.status >= 200 && res.status < 300) {
      return {
        success: true,
        provider: 'custom http',
        detail: 'HTTP ' + res.status,
        // Kept so the Test button can show what the provider actually said.
        response: body
      };
    }

    return {
      success: false,
      provider: 'custom http',
      error: 'The endpoint answered HTTP ' + res.status + ': ' + body
    };
  } catch (error) {
    return {
      success: false,
      provider: 'custom http',
      error:
        error.response
          ? 'The endpoint answered HTTP ' + error.response.status
          : 'Could not reach the endpoint: ' + error.message
    };
  }
};
/* ----------------------------------------------------------- Dispatch --- */

const dispatch = async (channel, { to, email, subject, message }) => {
  switch (channel) {
    case 'sms':
      return sendSMS(to, message);
    case 'whatsapp':
      return sendWhatsApp(to, message);
    case 'email':
      return sendEmail(email, subject, message);
    case 'in_app':
      return { success: true, provider: 'in_app', detail: 'stored for member to read' };
    default:
      return { success: false, error: `Unknown channel: ${channel}` };
  }
};

module.exports = {
  dispatch,
  sendSMS,
  sendWhatsApp,
  sendEmail,
  sendViaCustomHttp,
  validateCustomEndpoint,
  normalisePhone,
  isPlaceholder
};