import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import {
  Save,
  Send,
  Eye,
  Braces,
  AlertTriangle,
  CheckCircle,

  MessageSquare,
  RefreshCw
} from 'lucide-react';
import { useI18n, dictionaries } from '../i18n/I18nContext';

// Template keys, descriptions and placeholder names all come from the API. The
// key is what identifies the row, so only the words an admin reads are
// translated, and anything not listed here falls back to the server's own text.
const TEMPLATE_DESC_KEYS = {
  tpl_account_created: 'notif.tplDesc.accountCreated',
  tpl_welcome: 'notif.tplDesc.welcome',
  tpl_loan_due: 'notif.tplDesc.loanDue',
  tpl_due_7days: 'notif.tplDesc.due7',
  tpl_due_3days: 'notif.tplDesc.due3',
  tpl_due_1day: 'notif.tplDesc.due1'
};

/**
 * Looks a key up in the merged tables and returns null when it is absent, so a
 * placeholder the server invents later keeps its own English wording instead of
 * printing a raw key.
 */
/**
 * Card heading per template.
 *
 * The server stores a human English name in `label`. Showing that verbatim left
 * the headings in English while everything around them was Kiswahili, so each
 * template points at a key and lookup() falls back to the stored label if a
 * template is ever added without a translation.
 */
const TEMPLATE_LABEL_KEYS = {
  tpl_account_created: 'notif.tplAccountCreated',
  tpl_welcome: 'notif.tplWelcome',
  tpl_loan_due: 'notif.tplLoanDue',
  tpl_due_7days: 'notif.tplDue7',
  tpl_due_3days: 'notif.tplDue3',
  tpl_due_1day: 'notif.tplDue1'
};

const lookup = (t, key) => (key && dictionaries.en[key] !== undefined ? t(key) : null);

// '{{member_name}}' becomes the bare name the API reports.
const barePlaceholderName = (token) => String(token || '').replace(/[{}]/g, '');

/**
 * Notification template editor.
 *
 * Each template has its own box with a live preview, a placeholder reference
 * beside it, and a test button. Templates are stored as plain text in settings
 * so they can be edited without a deployment.
 */
const NotificationTemplates = () => {
  const { t } = useI18n();
  const [meta, setMeta] = useState(null);
  const [bodies, setBodies] = useState({});
  const [saving, setSaving] = useState(null);
  const [showTokens, setShowTokens] = useState(null);
  const [preview, setPreview] = useState(null);
  const [testFor, setTestFor] = useState(null);
  const [testForm, setTestForm] = useState({ channel: 'sms', to: '', email: '' });
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await axios.get('/api/notifications/templates');
      setMeta(data);
      const map = {};
      data.templates.forEach((t) => {
        map[t.key] = t.body;
      });
      setBodies(map);
    } catch (error) {
      toast.error(error.response?.data?.error || t('notif.templatesLoadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (key) => {
    setSaving(key);
    try {
      await axios.put(`/api/settings/${key}`, { value: bodies[key] });
      toast.success(t('notif.templateSaved'));
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || t('err.saveFailed'));
    } finally {
      setSaving(null);
    }
  };

  const reset = async (key, defaultBody) => {
    setBodies((b) => ({ ...b, [key]: defaultBody }));
    toast.success(t('notif.resetDefaultHint'));
  };

  const doPreview = async (key) => {
    try {
      const { data } = await axios.post('/api/notifications/templates/test', {
        template_key: key,
        dry_run: true
      });
      setPreview({ key, ...data });
    } catch (error) {
      toast.error(error.response?.data?.error || t('notif.previewFailed'));
    }
  };

  const openTest = (key) => {
    setTestFor(key);
    setTestResult(null);
    setTestForm({ channel: 'sms', to: '', email: '' });
  };

  const sendTest = async (e) => {
    e.preventDefault();
    setTesting(true);
    setTestResult(null);
    try {
      const { data } = await axios.post('/api/notifications/templates/test', {
        template_key: testFor,
        channel: testForm.channel,
        to: testForm.to,
        email: testForm.email || undefined,
        dry_run: false
      });
      setTestResult(data);

      if (data.delivery?.success) {
        toast.success(t('notif.testSentTo', { to: data.delivery.sent_to }));
      } else if (data.delivery?.skipped) {
        toast.error(t('notif.notSent', { detail: data.delivery.detail }));
      } else {
        toast.error(
          t('notif.failedWith', { detail: data.delivery?.detail || t('notif.unknownError') })
        );
      }
    } catch (error) {
      toast.error(error.response?.data?.error || t('notif.testFailed'));
    } finally {
      setTesting(false);
    }
  };

  const insertToken = (token, key) => {
    setBodies((b) => ({ ...b, [key]: `${b[key] || ''}${token}` }));
  };

  if (loading) {
    return (
      <div className="card">
        <div className="empty-state">
          <MessageSquare size={34} />
          <p>{t('notif.loadingTemplates')}</p>
        </div>
      </div>
    );
  }

  const testing_template = meta.templates.find((tpl) => tpl.key === testFor);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('notif.templates')}</h1>
          <p className="page-sub">{t('notif.templatesSubtitle')}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={load}>
            <RefreshCw size={16} /> {t('notif.reload')}
          </button>
        </div>
      </div>

      <div className="notice-strip" style={{ marginBottom: 22 }}>
        <Braces size={16} />
        <span>
          {t('notif.placeholdersIntro')} <code>{'{{member_name}}'}</code>{' '}
          {t('notif.placeholdersOutro')} {t('notif.placeholdersUse')}{' '}
          <strong>{t('notif.preview')}</strong> {t('notif.placeholdersPreviewRest')}{' '}
          <strong>{t('notif.testSend')}</strong> {t('notif.placeholdersTestRest')}
        </span>
      </div>

      {meta.templates.map((tpl) => (
        <div key={tpl.key} className="card template-card">
          <div className="card-header">
            <div>
              <h3 className="card-title">{lookup(t, TEMPLATE_LABEL_KEYS[tpl.key]) || tpl.label}</h3>
              <p className="card-sub">
                {lookup(t, TEMPLATE_DESC_KEYS[tpl.key]) || tpl.description}
              </p>
            </div>
            <span className="badge badge-neutral">{tpl.key}</span>
          </div>

          <div className="template-body">
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>{t('notif.message')}</label>
              <textarea
                value={bodies[tpl.key] || ''}
                onChange={(e) => setBodies({ ...bodies, [tpl.key]: e.target.value })}
                rows={4}
              />
            </div>

            {/* Placeholder reference sits beside the editor */}
            <aside className="token-panel">
              <button
                className="token-panel-toggle"
                onClick={() => setShowTokens(showTokens === tpl.key ? null : tpl.key)}
              >
                <Braces size={15} />
                {t('notif.placeholdersCount', { n: meta.placeholders.length })}
              </button>

              {showTokens === tpl.key && (
                <div className="token-list">
                  {meta.placeholders.map((p) => (
                    <button
                      key={p.token}
                      className="token-chip"
                      onClick={() => insertToken(p.token, tpl.key)}
                      title={t('notif.insertHint', { example: p.example })}
                    >
                      <code>{p.token}</code>
                      <span>
                        {lookup(t, `notif.ph.${barePlaceholderName(p.token)}`) || p.label}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </aside>
          </div>

          <div className="template-actions">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => doPreview(tpl.key)}
            >
              <Eye size={15} /> {t('notif.preview')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => save(tpl.key)}
              disabled={saving === tpl.key}
            >
              <Save size={15} /> {saving === tpl.key ? t('common.saving') : t('common.save')}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => openTest(tpl.key)}>
              <Send size={15} /> {t('notif.testSend')}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => reset(tpl.key, tpl.body)}
              title={t('notif.restoreDefaultTitle')}
            >
              {t('notif.resetDefault')}
            </button>
          </div>

          {preview?.key === tpl.key && (
            <div className="template-preview">
              <div className="template-preview-head">
                <strong>{t('notif.previewSample')}</strong>
                <button onClick={() => setPreview(null)} aria-label={t('notif.closePreview')}>
                  &times;
                </button>
              </div>
              <div className="phone-bubble">{preview.rendered}</div>
              {preview.unknown_placeholders?.length > 0 && (
                <div className="template-warning">
                  <AlertTriangle size={15} />
                  <span>
                    {t(
                      preview.unknown_placeholders.length === 1
                        ? 'notif.unknownPlaceholder'
                        : 'notif.unknownPlaceholders',
                      { list: preview.unknown_placeholders.join(', ') }
                    )}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {/* ------------------------------------------------------ test modal */}
      {testFor && (
        <div className="modal-overlay" onClick={() => setTestFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('notif.sendTestTitle', { label: (testing_template && lookup(t, TEMPLATE_LABEL_KEYS[testing_template.key])) || testing_template?.label })}</h2>
              <button className="modal-close" onClick={() => setTestFor(null)}>
                &times;
              </button>
            </div>

            <form onSubmit={sendTest}>
              <div className="form-row">
                <div className="form-group">
                  <label>{t('notif.channel')} *</label>
                  <select
                    value={testForm.channel}
                    onChange={(e) =>
                      setTestForm({ ...testForm, channel: e.target.value })
                    }
                  >
                    <option value="sms">SMS</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">{t('common.email')}</option>
                    <option value="in_app">{t('notif.inAppAlwaysWorks')}</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>
                    {testForm.channel === 'email' ? t('notif.emailAddress') : t('common.phone')}
                  </label>
                  <input
                    type={testForm.channel === 'email' ? 'email' : 'tel'}
                    value={testForm.channel === 'email' ? testForm.email : testForm.to}
                    onChange={(e) =>
                      setTestForm({
                        ...testForm,
                        [testForm.channel === 'email' ? 'email' : 'to']: e.target.value
                      })
                    }
                    placeholder={testForm.channel === 'email' ? 'you@example.com' : '0712345678'}
                    required={testForm.channel !== 'in_app'}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>{t('notif.messageToSend')}</label>
                <div className="phone-bubble" style={{ marginTop: 4 }}>
                  {(bodies[testFor] || '')
                    .replace(/\{\{\s*member_name\s*\}\}/g, meta.sample.member_name)
                    .replace(/\{\{\s*chama_name\s*\}\}/g, meta.sample.chama_name)
                    .replace(/\{\{\s*phone\s*\}\}/g, meta.sample.phone)
                    .replace(/\{\{\s*monthly_contribution\s*\}\}/g, meta.sample.monthly_contribution)
                    .replace(/\{\{\s*reminder_day\s*\}\}/g, meta.sample.reminder_day)
                    .replace(/\{\{\s*paybill\s*\}\}/g, meta.sample.paybill)
                    .replace(/\{\{\s*balance\s*\}\}/g, meta.sample.balance)
                    .replace(/\{\{\s*amount_due\s*\}\}/g, meta.sample.amount_due)
                    .replace(/\{\{\s*due_date\s*\}\}/g, meta.sample.due_date)}
                </div>
              </div>

              <button type="submit" className="btn btn-primary btn-block" disabled={testing}>
                {testing ? t('notif.sending') : t('notif.sendTestMessage')}
              </button>
            </form>

            {testResult && (
              <div
                className={`test-result ${testResult.delivery?.success ? 'ok' : 'bad'}`}
              >
                {testResult.delivery?.success ? (
                  <CheckCircle size={17} />
                ) : (
                  <AlertTriangle size={17} />
                )}
                <div>
                  <strong>
                    {testResult.delivery?.success
                      ? t('notif.testSentTo', { to: testResult.delivery.sent_to })
                      : testResult.delivery?.skipped
                        ? t('notif.noProvider')
                        : t('notif.sendFailed')}
                  </strong>
                  <span>
                    {testResult.delivery?.detail ||
                      t('notif.provider', {
                        provider: testResult.delivery?.provider || t('notif.providerNone')
                      })}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationTemplates;
