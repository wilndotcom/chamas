import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Send, Loader2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

/**
 * The M-Pesa panel inside its gateway row.
 *
 * STK Push is the only M-Pesa product this group uses, so there is nothing to
 * choose between here - the panel is a readiness check and a way to prove the
 * Daraja setup without taking anyone's money.
 *
 * It renders for mpesa_stk only. Anything else has no M-Pesa action worth
 * offering.
 */
const MpesaGatewayAction = ({ gatewayKey }) => {
  if (gatewayKey !== 'mpesa_stk') return null;
  return <StkReadiness />;
};

/**
 * Reads the one thing that decides whether STK works: can Safaricom reach us,
 * and have we been given keys at all.
 *
 * Loaded on mount rather than behind a button. The state it reports does not
 * change until something is saved, and an operator who has to press a button to
 * find out whether a prompt will work will press the prompt instead.
 */
const StkReadiness = () => {
  const { t } = useI18n();
  const [state, setState] = useState(null);

  const check = async () => {
    try {
      const { data } = await axios.get('/api/mpesa/status');
      setState(data);
    } catch {
      setState({ error: true });
    }
  };

  useEffect(() => { check(); }, []);

  const ready = state && state.configured && state.callback_reachable;
  const onLocalhost = state && !state.error
    && /localhost|127\.0\.0\.1/.test(state.callback_url || '');
  const missingKeys = state && !state.error && !state.configured;

  /*
   * "Configured" and "works" are different claims, and only the second one is
   * worth anything to an operator collecting money. Daraja accepts a prompt
   * against a shortcode it has never heard of and answers with a checkout id,
   * so a prompt going out proves nothing about the number - the first payment
   * through it is where a wrong till is discovered, and by then a member is
   * paying into a number nobody is watching.
   *
   * So this says "not confirmed yet" rather than showing green, and says what
   * confirming it takes.
   */
  const tillConfirmed = state && !state.error && state.till_verified;
  const tillMismatch = state && !state.error && state.till_last_seen
    && state.till_last_seen !== state.values?.shortcode;

  return (
    <div className="gateway-action">
      {state && !state.error && (
        <div className="gateway-action-result ok" style={{ marginTop: 8 }}>
          <div className="mpesa-readiness">
            <span className={ready ? 'mpesa-ok' : 'mpesa-bad'}>
              {ready ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            </span>
            <span>{ready ? t('mpesa.readyOk') : t('mpesa.notReady')}</span>
          </div>
          <dl className="mpesa-facts">
            <dt>{t('mpesa.factShortcode')}</dt>
            <dd>
              <code>{state.values?.shortcode || '-'}</code>
              <span className={tillConfirmed ? 'mpesa-ok' : 'mpesa-unproven'}>
                {tillConfirmed
                  ? t('mpesa.tillConfirmed')
                  : t('mpesa.tillUnconfirmed')}
              </span>
            </dd>
            <dt>{t('mpesa.factCallback')}</dt>
            <dd>
              <code>{state.callback_url || t('mpesa.factCallbackMissing')}</code>
              <span className={state.callback_reachable ? 'mpesa-ok' : 'mpesa-bad'}>
                {state.callback_reachable ? t('mpesa.factReachable') : t('mpesa.factUnreachable')}
              </span>
            </dd>
          </dl>

          {tillMismatch && (
            <div className="notice-strip notice-strip--danger" style={{ marginBottom: 10 }}>
              <AlertTriangle size={15} />
              <span>
                {t('mpesa.tillMismatch', { saved: state.values?.shortcode, seen: state.till_last_seen })}
              </span>
            </div>
          )}

          {/*
            Saying "unreachable" is not enough on its own. The usual reason is
            that the operator is looking at the app on localhost, where it works
            perfectly for them and is invisible to Safaricom - so the only way
            to get unstuck is to be told what to do next.
          */}
          {onLocalhost && <p className="mpesa-explain">{t('mpesa.explainLocalhost')}</p>}
          {missingKeys && <p className="mpesa-explain">{t('mpesa.explainMissingKeys')}</p>}
          {ready && !tillConfirmed && (
            <p className="mpesa-explain">{t('mpesa.explainTillUnconfirmed')}</p>
          )}

          <button type="button" className="btn btn-sm btn-secondary" onClick={check}>
            {t('mpesa.checkAgain')}
          </button>
        </div>
      )}

      {state && state.error && (
        <div className="gateway-action-result bad" style={{ marginTop: 8 }}>
          <p style={{ margin: 0 }}>{t('mpesa.readFailed')}</p>
          <button type="button" className="btn btn-sm btn-secondary" onClick={check}>
            {t('mpesa.checkAgain')}
          </button>
        </div>
      )}

      <TestStkPrompt />
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
                  placeholder="0712345678"
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