import React, { useState } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { CreditCard, AlertTriangle, CheckCircle, Loader2, PlugZap } from 'lucide-react';
import { usePaymentGateways } from '../hooks/usePaymentGateways';
import { useI18n } from '../i18n/I18nContext';
import MpesaGatewayAction from './MpesaGatewayAction';

// gateway_key and method value are stable API identifiers that must not change.
// Only the wording an admin reads is localised, and anything not listed keeps the
// server's own text.
/**
 * Display names and descriptions per gateway, so the list reads in the operator's
 * language while the gateway_key stays the stable identifier used by the API and
 * the database. A null display means the stored name is already correct.
 *
 * M-Pesa is listed as two entries because they are chosen separately: one needs
 * the Daraja STK Push endpoint registered, the other needs a callback URL.
 */
const GATEWAY_KEYS = {
  mpesa_stk: { display: 'gateway.displayMpesaStk', desc: 'gateway.desc.mpesaStk' },
  airtel_money: { display: 'gateway.displayAirtel', desc: 'gateway.desc.airtel' },
  bank: { display: 'gateway.displayBank', desc: 'gateway.desc.bank' },
  cash: { display: 'gateway.displayCash', desc: 'gateway.desc.cash' }
};

const METHOD_KEYS = {
  mpesa_stk: 'gateway.methodMpesaStk',
  airtel_money: 'gateway.methodAirtel',
  bank: 'gateway.methodBank',
  cash: 'gateway.methodCash'
};

/**
 * Payment gateway registry, shown in Settings.
 *
 * This is the catalogue of ways the chama accepts money, and where each one is
 * switched on or off. Turning a gateway off removes it from every payment form in
 * both portals — it is not a per-form setting, which is the whole point of having
 * one place for it.
 *
 * Credentials are not edited here. Each gateway's own card below does that, so
 * this list stays a status overview rather than a second edit surface.
 */
const PaymentGatewaysPanel = () => {
  const { gateways, loading, error, fallbackApplied, fallbackNote, suppressedUnwired, reload } =
    usePaymentGateways();
  const { t } = useI18n();
  const [busy, setBusy] = useState(null);

  const toggle = async (gateway) => {
    const next = !gateway.is_enabled;
    setBusy(gateway.gateway_key);
    try {
      const { data } = await axios.put(`/api/payment-gateways/${gateway.gateway_key}`, {
        is_enabled: next
      });
      toast.success(data.message);
      await reload();
    } catch (err) {
      toast.error(err.response?.data?.error || t('gateway.updateFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <h3 className="card-title" style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 9 }}>
        <CreditCard size={18} /> {t('settings.paymentGateways')}
      </h3>
      <p className="card-sub" style={{ marginBottom: 18 }}>
        {t('settings.paymentGatewaysNote')}
      </p>

      {error && (
        <div className="notice-strip" style={{ marginBottom: 16 }}>
          <AlertTriangle size={16} />
          <span>{error} {t('gateway.cashFallback')}</span>
        </div>
      )}

      {/* Without this, switching an unwired gateway on appears to do nothing: it
          shows as enabled, yet no payment form gains the option. */}
      {suppressedUnwired > 0 && (
        <div className="notice-strip" style={{ marginBottom: 16 }}>
          <PlugZap size={16} />
          <span>{t('gateway.suppressedUnwired', { n: suppressedUnwired })}</span>
        </div>
      )}

      {loading && gateways.length === 0 ? (
        <div className="empty-state">
          <Loader2 size={30} className="spin" />
          <p>{t('gateway.loading')}</p>
        </div>
      ) : (
        <div className="gateway-list">
          {gateways.map((g) => {
            // Three distinct states, and conflating them would mislead. "Needs
            // setup" means filling in credentials would fix it. "Not connected"
            // means the payment call itself is not implemented, so credentials
            // alone will not help. Reporting the second as the first sends the
            // operator off to enter keys that can never work.
            const notWired = g.is_wired === false;
            const needsSetup = !notWired && g.requires_config && !g.is_configured;
            const localised = GATEWAY_KEYS[g.gateway_key] || {};
            const displayName = localised.display ? t(localised.display) : g.display_name;
            const description = localised.desc ? t(localised.desc) : g.description;
            return (
              <div
                key={g.gateway_key}
                className={`gateway-row${g.is_enabled ? ' on' : ' off'}`}
              >
                <div className="gateway-row-main">
                  <div className="gateway-row-title">
                    <strong>{displayName}</strong>
                    {notWired ? (
                      <span className="gateway-tag muted">
                        <PlugZap size={11} /> {t('settings.notConnected')}
                      </span>
                    ) : needsSetup ? (
                      <span className="gateway-tag warn">
                        <AlertTriangle size={11} /> {t('settings.needsSetup')}
                      </span>
                    ) : (
                      <span className="gateway-tag ok">
                        <CheckCircle size={11} /> {t('settings.ready')}
                      </span>
                    )}
                    {!g.is_enabled && (
                      <span className="gateway-tag off">{t('settings.hidden')}</span>
                    )}
                  </div>
                  {description && <p className="gateway-row-desc">{description}</p>}
                  {notWired && (
                    <p className="gateway-row-note">
                      <AlertTriangle size={12} /> {t('settings.notConnectedNote')}
                    </p>
                  )}
                  {g.daraja_endpoint && (
                    <p className="gateway-row-endpoint">
                      <span className="gateway-endpoint-label">{t('settings.gatewayEndpoint')}</span>
                      <code>{g.daraja_endpoint}</code>
                    </p>
                  )}
                  <p className="gateway-row-methods">
                    {t('settings.appearsAs')}{' '}
                    {g.methods
                      .map((m) => (METHOD_KEYS[m.value] ? t(METHOD_KEYS[m.value]) : m.label))
                      .join(' · ')}
                  </p>

                  {/* Only for a gateway that is actually usable: offering "register
                      the paybill URLs" on an unconfigured app just produces a
                      confusing rejection. */}
                  {g.is_configured && <MpesaGatewayAction gatewayKey={g.gateway_key} />}
                </div>

                <label
                  className="switch"
                  title={g.is_enabled ? t('gateway.switchOff') : t('gateway.switchOn')}
                >
                  <input
                    type="checkbox"
                    checked={!!g.is_enabled}
                    disabled={busy === g.gateway_key}
                    onChange={() => toggle(g)}
                    aria-label={t('gateway.accept', { name: displayName })}
                  />
                  <span className="switch-track" aria-hidden="true">
                    <span className="switch-thumb" />
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      )}

      {fallbackApplied && (
        <div className="notice-strip" style={{ marginTop: 16 }}>
          <AlertTriangle size={16} />
          <span>{fallbackNote}</span>
        </div>
      )}
    </div>
  );
};

export default PaymentGatewaysPanel;