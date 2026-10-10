import React, { useState } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Link2, Send, Loader2, AlertTriangle } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

/**
 * The one action each M-Pesa gateway needs that the app cannot do for itself.
 *
 * Both exist because both used to be impossible from inside the app:
 *
 *   mpesa_c2b   Only Safaricom can register a paybill's confirmation and
 *               validation URLs, and the operator had to do it with curl.
 *   mpesa_stk   There was no way to send a prompt without recording a real
 *               contribution against a member, so the Daraja setup could only
 *               be verified by taking someone's money.
 *
 * Rendered inside its own gateway row rather than as one shared M-Pesa panel,
 * because the two actions belong to different products: registering C2B URLs does
 * nothing for STK Push, and a test prompt proves nothing about the paybill.
 */
const MpesaGatewayAction = ({ gatewayKey }) => {
  const { t } = useI18n();

  if (gatewayKey === 'mpesa_c2b') return <RegisterC2BUrls />;
  if (gatewayKey === 'mpesa_stk') return <TestStkPrompt />;
  return null;
};

/**
 * Publishes the paybill's two callback URLs with Safaricom.
 *
 * Safe to press more than once: registering again overwrites the previous pair
 * with the same values, which is also how an operator fixes a URL that changed.
 */
const RegisterC2BUrls = () => {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [endpoints, setEndpoints] = useState(null);

  const register = async () => {
    setBusy(true);
    try {
      const { data } = await axios.post('/api/mpesa/register-c2b');
      setEndpoints(data.registered || null);
      toast.success(t('mpesa.registeredOk'));
    } catch (err) {
      const body = err.response?.data || {};
      // A refused registration names the setting to fix, so it is worth surfacing
      // on its own rather than buried in a toast that disappears.
      if (body.field === 'mpesa_callback_url') {
        setEndpoints(null);
        toast.error(body.error, { duration: 12000 });
      } else {
        const parts = [];
        if (body.daraja_code) parts.push(t('contrib.safaricomCode', { code: body.daraja_code }));
        parts.push(body.error || t('mpesa.registerFailed'));
        toast.error(parts.join(' - '), { duration: 9000 });
        if (body.hint) toast(body.hint, { duration: 14000, icon: '\u2699' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gateway-action">
      <button
        type="button"
        className="btn btn-sm btn-secondary"
        onClick={register}
        disabled={busy}
      >
        {busy ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />}
        {' '}{busy ? t('mpesa.registering') : t('mpesa.registerC2b')}
      </button>

      {endpoints && (
        <div className="gateway-action-result ok">
          <span className="gateway-endpoint-label">{t('mpesa.registeredUrls')}</span>
          <code>{endpoints.validation}</code>
          <code>{endpoints.confirmation}</code>
        </div>
      )}
    </div>
  );
};

/**
 * Sends one real STK prompt without recording anything.
 *
 * The amount is not free-form advice: it is what will appear on the phone and,
 * if the member accepts it, what will leave the account. The warning is therefore
 * permanent rather than a dismissible notice.
 */
const TestStkPrompt = () => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ phone: '', amount: '' });
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);

  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    setFailure(null);
    try {
      const { data } = await axios.post('/api/mpesa/test-prompt', {
        phone: form.phone.trim(),
        amount: form.amount
      });
      setResult(data);
    } catch (err) {
      const body = err.response?.data || {};
      const parts = [];
      if (body.daraja_code) parts.push(t('contrib.safaricomCode', { code: body.daraja_code }));
      parts.push(body.error || t('mpesa.testFailed'));
      setFailure({ text: parts.join(' - '), hint: body.hint || null });
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setOpen(false);
    setResult(null);
    setFailure(null);
    setForm({ phone: '', amount: '' });
  };

  return (
    <>
      <div className="gateway-action">
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => setOpen(true)}
        >
          <Send size={14} /> {t('mpesa.testPrompt')}
        </button>
      </div>

      {open && (
        <div className="modal-overlay" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('mpesa.testPromptTitle')}</h2>
              <button type="button" className="modal-close" onClick={close} aria-label={t('common.close')}>
                &times;
              </button>
            </div>

            {/* Says what this is, because the prompt is indistinguishable from a
                real payment request on the phone that receives it. */}
            <div className="notice-strip notice-strip--danger" style={{ marginBottom: 18 }}>
              <AlertTriangle size={16} />
              <span>{t('mpesa.testPromptWarning')}</span>
            </div>

            <form onSubmit={send}>
              <div className="form-group">
                <label>{t('mpesa.testPhone')}</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="254712345678"
                  required
                />
                <small className="field-hint">{t('mpesa.testPhoneHint')}</small>
              </div>

              <div className="form-group">
                <label>{t('mpesa.testAmount')}</label>
                <input
                  type="number"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  min="1"
                  step="0.01"
                  required
                />
              </div>

              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy && <Loader2 size={16} className="spin" />}
                {busy ? t('mpesa.testSending') : t('mpesa.testSend')}
              </button>
            </form>

            {result && (
              <div className="gateway-action-result ok" style={{ marginTop: 16 }}>
                <span className="gateway-endpoint-label">{t('mpesa.testSent')}</span>
                <p style={{ margin: '4px 0 0' }}>{result.message}</p>
                {result.checkout_request_id && (
                  <code style={{ marginTop: 8 }}>
                    {t('mpesa.testCheckoutId')}: {result.checkout_request_id}
                  </code>
                )}
                {result.customer_message && (
                  <p style={{ margin: '8px 0 0' }} className="field-hint">
                    {result.customer_message}
                  </p>
                )}
                {result.warning && (
                  <p className="gateway-action-warning">
                    <AlertTriangle size={13} /> {result.warning}
                  </p>
                )}
              </div>
            )}

            {failure && (
              <div className="gateway-action-result bad" style={{ marginTop: 16 }}>
                <p style={{ margin: 0 }}>{failure.text}</p>
                {failure.hint && (
                  <p className="gateway-action-warning">
                    <AlertTriangle size={13} /> {failure.hint}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default MpesaGatewayAction;