import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { MessageSquare, Send, Save, Loader2, AlertTriangle, CheckCircle, PlugZap } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

/**
 * Notification channel configuration.
 *
 * Lives inside Settings rather than on a page of its own because it is a setting,
 * not a workflow. It sits above the message templates for a reason: templates
 * decide *what* gets said, channels decide *whether it can be delivered*, and a
 * chama whose WhatsApp is not set up needs to discover that before editing a
 * template rather than after.
 *
 * Three things this screen exists to stop:
 *
 *   1. A credential that saves but is never read. The dispatcher used to read
 *      process.env only, so the "SMS API key" field on the old Notifications tab
 *      did nothing at all. Everything here is what the dispatcher consults.
 *   2. Credentials you cannot test. Each channel has a Test button that sends one
 *      real message to a number you type, so a working key is known to work before
 *      it is relied on to reach the whole group.
 *   3. "Configured" and "switched on" being the same thing. They are separate
 *      here, so a channel can hold a working key and still be switched off.
 */

/** Matches the backend sentinel. A field holding this was never really edited. */
const SECRET_MASK = '__saved__';

const CHANNELS = [
  {
    key: 'sms',
    icon: MessageSquare,
    providerKey: 'sms_provider',
    providerOptions: [
      { value: 'africas_talking', label: "Africa's Talking" },
      { value: 'twilio', label: 'Twilio' },
      { value: 'custom', label: 'Custom HTTP' }
    ],
    // The credentials each provider actually needs. Showing all of them at once
    // would ask for a Twilio SID from someone who chose Africa's Talking.
    credentials: {
      africas_talking: ['sms_username', 'sms_api_key', 'sms_sender_id'],
      twilio: ['twilio_account_sid', 'twilio_auth_token', 'twilio_sms_from']
    },
    testField: 'phone'
  },
  {
    key: 'whatsapp',
    icon: MessageSquare,
    providerKey: 'whatsapp_provider',
    providerOptions: [
      { value: 'twilio', label: 'Twilio' },
      { value: 'custom', label: 'Custom HTTP' }
    ],
    credentials: {
      twilio: ['twilio_account_sid', 'twilio_auth_token', 'twilio_whatsapp_number']
    },
    testField: 'phone',
    // Stated rather than discovered: WhatsApp is not self-service. Meta has to
    // approve the business and Twilio's sandbox only reaches numbers verified in
    // their console, so a failure here is usually not a typo.
    caveat: 'whatsapp.caveat'
  },
  {
    key: 'email',
    icon: MessageSquare,
    providerKey: null,
    providerOptions: null,
    credentials: {
      smtp: ['email_host', 'email_port', 'email_user', 'email_pass', 'email_from']
    },
    testField: 'email'
  }
];

const FIELD_LABELS = {
  sms_username: 'notif.fieldUsername',
  sms_api_key: 'notif.fieldApiKey',
  sms_sender_id: 'notif.fieldSenderId',
  twilio_account_sid: 'notif.fieldTwilioSid',
  twilio_auth_token: 'notif.fieldTwilioToken',
  twilio_sms_from: 'notif.fieldTwilioFrom',
  twilio_whatsapp_number: 'notif.fieldWhatsappSender',
  email_host: 'notif.fieldEmailHost',
  email_port: 'notif.fieldEmailPort',
  email_user: 'notif.fieldEmailUser',
  email_pass: 'notif.fieldEmailPass',
  email_from: 'notif.fieldEmailFrom',
  custom_endpoint: 'notif.customEndpoint',
  custom_method: 'notif.customMethod',
  custom_auth_type: 'notif.customAuthType',
  custom_auth_header: 'notif.customAuthHeader',
  custom_auth_value: 'notif.customAuthValue',
  custom_username: 'notif.customUsername',
  custom_password: 'notif.customPassword',
  custom_body: 'notif.customBody',
  custom_phone_format: 'notif.customPhoneFormat',
  custom_sender: 'notif.customSender'
};

/*
 * The custom HTTP provider's fields, for one channel.
 *
 * Built rather than written out per channel, because the same ten settings apply
 * to SMS and WhatsApp and a hand-written pair would drift.
 *
 * `when` is evaluated against the form so only the fields that apply to the
 * chosen auth type are shown: asking for a username when auth is a bearer token
 * implies the token will be used, and it will not be.
 */
const customFields = (channel) => [
  { key: `custom_${channel}_endpoint`, type: 'url' },
  { key: `custom_${channel}_method`, type: 'select', options: ['POST', 'PUT'] },
  {
    key: `custom_${channel}_auth_type`,
    type: 'select',
    options: ['none', 'bearer', 'header', 'basic']
  },
  {
    key: `custom_${channel}_auth_header`,
    when: (f) => f[`custom_${channel}_auth_type`] === 'header'
  },
  {
    key: `custom_${channel}_auth_value`,
    secret: true,
    when: (f) => ['bearer', 'header'].includes(f[`custom_${channel}_auth_type`])
  },
  {
    key: `custom_${channel}_username`,
    when: (f) => f[`custom_${channel}_auth_type`] === 'basic'
  },
  {
    key: `custom_${channel}_password`,
    secret: true,
    when: (f) => f[`custom_${channel}_auth_type`] === 'basic'
  },
  { key: `custom_${channel}_sender` },
  {
    key: `custom_${channel}_phone_format`,
    type: 'select',
    // WhatsApp APIs want the plus, Daraja wants it absent. Two conventions that
    // genuinely disagree, so asked rather than guessed.
    options: channel === 'whatsapp' ? ['+254', '254'] : ['254', '+254']
  },
  { key: `custom_${channel}_body`, type: 'textarea' }
];

// Never echoed to the browser, matching the backend's SECRET_KEYS. Kept here as a
// separate list on purpose: the screen must not type a real password into an input
// it cannot know, and a mismatch would either blank a saved key or display it.
const SECRET_FIELDS = new Set([
  'sms_api_key',
  'twilio_auth_token',
  'twilio_account_sid',
  'email_pass',
  'custom_sms_auth_value',
  'custom_sms_password',
  'custom_whatsapp_auth_value',
  'custom_whatsapp_password'
]);

/** Maps `custom_<channel>_<suffix>` onto its label key. */
const labelFor = (key) => {
  const match = /^custom_(?:sms|whatsapp)_(.+)$/.exec(key);
  return FIELD_LABELS[match ? `custom_${match[1]}` : key] || `notif.${key}`;
};

const NotificationChannels = ({ form, setForm, onSave, saving, saved }) => {
  const { t } = useI18n();
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [testing, setTesting] = useState(null);
  const [testTargets, setTestTargets] = useState({});

  const load = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/notifications/channels');
      setStatus(data);
      setLoadError(null);
    } catch (error) {
      setLoadError(error.response?.data?.error || t('notif.statusFailed'));
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  /**
 * Every key this channel owns, provider choice and credentials included.
 *
 * Email has no provider choice - there is only SMTP - so its keys come from the
 * single credentials map instead. Assuming a selector always exists made the
 * whole Settings screen crash on the Notifications tab, which is the most
 * expensive possible failure for a panel whose job is to explain problems.
 */
const keysFor = (channel) => {
    if (!channel.providerKey) return channel.credentials[Object.keys(channel.credentials)[0]];
    const provider = form[channel.providerKey] || channel.providerOptions[0].value;
    // Custom providers have no entry in the credentials map; their fields are
    // generated. Without this the save button would consider the panel unchanged
    // and stay disabled after editing the endpoint.
    if (provider === 'custom') {
      return [channel.providerKey, ...customFields(channel.key).map((f) => f.key)];
    }
    return [channel.providerKey, ...(channel.credentials[provider] || [])];
  };

  const enabledKey = (key) => `channel_${key}_enabled`;

  /*
   * Which of a channel's fields differ from what the server last sent.
   *
   * Same rule as every other card in Settings: the save button stays disabled
   * until something is actually different, so a click cannot report "saved"
   * without having changed anything. Without it these three buttons looked like
   * the only ones in the screen that were always ready to press.
   */
  const changedIn = (keys) =>
    keys.filter((k) => String(form[k] ?? '') !== String(saved?.[k] ?? ''));

  const test = async (channel) => {
    const target = (testTargets[channel.key] || '').trim();
    if (!target) {
      toast.error(
        channel.testField === 'email'
          ? t('notif.testNeedsEmail')
          : t('notif.testNeedsPhone')
      );
      return;
    }
    setTesting(channel.key);
    try {
      const { data } = await axios.post('/api/notifications/channels/test', {
        channel: channel.key,
        [channel.testField]: target
      });

      if (data.success) {
        toast.success(t('notif.testSentTo', { target: data.sent_to }), { duration: 8000 });
        if (data.detail) toast(data.detail, { duration: 8000, icon: '\u2139' });
      } else {
        // Skipped and failed are different. "Skipped" means the operator has not
        // finished setting the channel up, which is a next step for them rather
        // than a failure of theirs to act on.
        toast.error(data.detail || t('notif.testFailed'), { duration: 12000 });
      }
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || t('notif.testFailed'), { duration: 10000 });
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 className="card-title">
            <Send size={18} /> {t('notif.channelsTitle')}
          </h3>
          <p className="card-sub">{t('notif.channelsSub')}</p>
        </div>
      </div>

      {loadError && (
        <div className="notice-strip notice-strip--danger" style={{ marginBottom: 16 }}>
          <AlertTriangle size={16} /> <span>{loadError}</span>
        </div>
      )}

      <div className="notif-channels">
        {CHANNELS.map((channel) => {
          const Icon = channel.icon;
          const info = status?.channels?.[channel.key];
          const provider = channel.providerKey
            ? form[channel.providerKey] || channel.providerOptions[0].value
            : Object.keys(channel.credentials)[0];
          const keys = keysFor(channel);
          const isOn = form[enabledKey(channel.key)] === '1';

          // Three states worth telling apart: switched off, switched on but not
          // finished, and ready. Reporting the middle as "not configured" is what
          // made the old field impossible to reason about.
          const state = !isOn ? 'off' : info?.configured ? 'ready' : 'incomplete';

          return (
            <section key={channel.key} className={`notif-channel notif-channel--${state}`}>
              <header className="notif-channel-head">
                <span className="notif-channel-icon"><Icon size={17} /></span>
                <div className="notif-channel-title">
                  <strong>{t(`notif.channel_${channel.key}`)}</strong>
                  <span>{t(`notif.channel_${channel.key}Hint`)}</span>
                </div>

                <label className="switch" title={t('notif.channelSwitch')}>
                  <input
                    type="checkbox"
                    checked={isOn}
                    aria-label={t('notif.channelSwitch')}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        [enabledKey(channel.key)]: e.target.checked ? '1' : '0'
                      })
                    }
                  />
                  <span className="switch-track" aria-hidden="true">
                    <span className="switch-thumb" />
                  </span>
                </label>

                {state === 'ready' && (
                  <span className="notif-channel-state ok">
                    <CheckCircle size={12} /> {t('notif.ready')}
                  </span>
                )}
                {state === 'incomplete' && (
                  <span className="notif-channel-state warn">
                    <AlertTriangle size={12} /> {t('notif.stillNeeded')}
                  </span>
                )}
                {state === 'off' && (
                  <span className="notif-channel-state muted">
                    <PlugZap size={12} /> {t('notif.switchedOff')}
                  </span>
                )}
              </header>

              <div className="notif-channel-body">
                {channel.caveat && (
                  <p className="notif-channel-caveat">
                    <AlertTriangle size={13} /> {t(channel.caveat)}
                  </p>
                )}

                <div className="notif-channel-fields">
                  {channel.providerOptions && (
                    <div className="form-group">
                      <label>{t('notif.provider')}</label>
                      <select
                        value={provider}
                        onChange={(e) => setForm({ ...form, [channel.providerKey]: e.target.value })}
                      >
                        {channel.providerOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* The provider's own fields, plus the generated custom set. */}
                  {[
                    ...(channel.credentials[provider] || []).map((key) => ({ key })),
                    ...(provider === 'custom' ? customFields(channel.key) : [])
                  ]
                    // A custom field that does not apply to the chosen auth type is
                    // dropped rather than disabled: a greyed-out box still reads as
                    // something that needs filling in.
                    .filter((f) => !f.when || f.when(form))
                    .map(({ key, type, options, secret }) => {
                    const isSecret = secret || SECRET_FIELDS.has(key);
                    const saved = form[key] === SECRET_MASK;
                    return (
                      <div className="form-group" key={key}>
                        <label>{t(labelFor(key))}</label>
                        {/*
                          A masked credential renders as an empty box with a note,
                          not as asterisks. Asterisks invite the reader to try
                          editing them; an empty box with "already saved" cannot
                          be submitted by accident, and typing replaces it while
                          deleting it back to empty clears the credential on
                          purpose.
                        */}
                        {isSecret ? (
                          <input
                            type="password"
                            autoComplete="new-password"
                            value={saved ? '' : form[key] || ''}
                            placeholder={saved ? t('notif.alreadySaved') : ''}
                            onChange={(e) => {
                              const next = e.target.value;
                              setForm({
                                ...form,
                                // Empty while it was masked means "untouched", so
                                // keep the sentinel and let the backend skip it.
                                [key]: next === '' && saved ? SECRET_MASK : next
                              });
                            }}
                          />
                        ) : type === 'select' ? (
                          <select
                            value={form[key] || options[0]}
                            onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                          >
                            {options.map((o) => (
                              <option key={o} value={o}>{o}</option>
                            ))}
                          </select>
                        ) : type === 'textarea' ? (
                          // A body template is JSON, so it gets room to breathe and
                          // a monospaced face. Wrapping it in an ordinary input box
                          // is how a missing brace goes unnoticed until a send fails.
                          <>
                            <textarea
                              rows={5}
                              spellCheck={false}
                              className="mono"
                              value={form[key] || ''}
                              placeholder='{"to":"{{phone}}","message":"{{message}}"}'
                              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                            />
                            <small className="field-hint">
                              {t('notif.customBodyHint')}
                            </small>
                          </>
                        ) : (
                          <input
                            type={
                              key === 'email_port' ? 'number'
                              : type === 'url' ? 'url'
                              : 'text'
                            }
                            value={form[key] || ''}
                            onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                          />
                        )}
                        {isSecret && saved && (
                          <small className="field-hint">{t('notif.leaveBlankHint')}</small>
                        )}
                        {isSecret && !saved && type !== 'select' && type !== 'textarea' && (
                          <small className="field-hint">{t('notif.customSecretHint')}</small>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="notif-channel-test">
                  <div className="form-group">
                    <label>{t('notif.testTo')}</label>
                    <input
                      type={channel.testField === 'email' ? 'email' : 'tel'}
                      value={testTargets[channel.key] || ''}
                      placeholder={channel.testField === 'email' ? 'you@example.com' : '254712345678'}
                      onChange={(e) =>
                        setTestTargets({ ...testTargets, [channel.key]: e.target.value })
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => test(channel)}
                    disabled={testing === channel.key}
                  >
                    {testing === channel.key ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Send size={14} />
                    )}
                    {t('notif.testSend')}
                  </button>
                </div>

                {info && !info.configured && info.missing?.length > 0 && (
                  <p className="notif-channel-missing">
                    <AlertTriangle size={12} />
                    {t('notif.missingFields', {
                      list: info.missing.map((k) => t(FIELD_LABELS[k] || k)).join(', ')
                    })}
                  </p>
                )}

                {/* Saved here vs falling back to .env. The distinction is the one
                    that explains "I set the key but it still uses the old one". */}
                {info && Object.entries(status.source || {})
                  .filter(([key]) => keys.includes(key))
                  .map(([key, from]) => (
                    <span key={key} className={`notif-source ${from}`}>
                      {key} · {from === 'settings' ? t('notif.savedHere') : t('notif.fromEnv')}
                    </span>
                  ))}
              </div>

              <div className="card-save-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onSave([enabledKey(channel.key), ...keys], t(`notif.channel_${channel.key}`))}
                  disabled={saving === t(`notif.channel_${channel.key}`) || changedIn([enabledKey(channel.key), ...keys]).length === 0}
                >
                  <Save size={18} />{' '}
                  {saving === t(`notif.channel_${channel.key}`)
                    ? t('common.saving')
                    : t('notif.saveChannel')}
                </button>
                <span className={`card-save-hint${changedIn([enabledKey(channel.key), ...keys]).length ? ' dirty' : ''}`}>
                  {changedIn([enabledKey(channel.key), ...keys]).length === 0
                    ? 'No changes yet'
                    : `Unsaved: ${changedIn([enabledKey(channel.key), ...keys])
                        .map((k) => t(FIELD_LABELS[k] || k))
                        .join(', ')}`}
                </span>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};

export default NotificationChannels;