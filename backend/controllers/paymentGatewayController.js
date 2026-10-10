const pool = require('../config/database');
const { getMpesaConfig, isConfigured } = require('../utils/mpesaConfig');

/**
 * Payment gateway registry.
 *
 * A gateway is a way of paying (M-Pesa, bank, cash). Turning one off removes it
 * from every payment method list across both portals, which is the point: the
 * choice of accepted methods is configuration rather than something hardcoded
 * in four different dropdowns.
 *
 * Credentials are not stored here. M-Pesa keeps its keys in `settings`; this
 * table is the catalogue.
 */

/**
 * Which stored `payment_method` values each gateway covers.
 *
 * One gateway to one method, so an operator can offer a paybill without also
 * offering STK Push. The enum is finer-grained than the gateway was, which is why
 * the mapping is written out rather than inferred from names.
 *
 * M-Pesa's two products stay in one `payment_method` pair because Daraja's
 * credentials are shared; only the registered endpoint differs, which
 * `needs_endpoint` reports per gateway.
 */
const GATEWAY_METHODS = {
  mpesa_stk: ['mpesa_stk'],
  mpesa_c2b: ['mpesa_c2b'],
  airtel_money: ['airtel_money'],
  bank: ['bank'],
  cash: ['cash']
};

const LABELS = {
  mpesa_stk: 'M-Pesa (STK Push)',
  mpesa_c2b: 'M-Pesa (paybill / C2B)',
  airtel_money: 'Airtel Money',
  bank: 'Bank Transfer',
  cash: 'Cash'
};

/**
 * The Daraja endpoint each M-Pesa gateway needs registered.
 *
 * Surfaced because that is the one thing about M-Pesa that cannot be done from the
 * app, and getting it wrong produces an opaque rejection.
 */
const DARJAJA_ENDPOINTS = {
  mpesa_stk: 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
  mpesa_c2b: 'Callback URL (Safaricom posts the confirmation to your app)'
};

/**
 * Whether a gateway could take money right now.
 *
 * Only M-Pesa is checked in depth, because it is the only one with credentials
 * stored today. Airtel Money is deliberately reported as not configured until its
 * own keys are filled in, rather than being assumed to work: it is listed and
 * selectable, but the payment call is not wired, and the UI says so.
 */
const isGatewayUsable = (key, mpesa) => {
  if (key === 'mpesa_stk' || key === 'mpesa_c2b') return mpesa;
  if (key === 'airtel_money') return false;
  return true; // bank and cash are recorded by hand
};

/**
 * Methods the app can actually collect, as a set for one membership test.
 *
 * Separate from isGatewayUsable because that answers "are the credentials there",
 * while this answers "would choosing this option work". A gateway can be enabled
 * and configured yet still be unwired, and offering it to a member would be worse
 * than not offering it: the payment would never be confirmed.
 */
const WIRED_METHODS = new Set(
  Object.entries(GATEWAY_METHODS)
    .filter(([key]) => key !== 'airtel_money')
    .flatMap(([, methods]) => methods)
);

/** Lists every gateway with its enabled state and configuration status. */
const listGateways = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM payment_gateways ORDER BY sort_order, gateway_key'
    );

    const mpesa = await getMpesaConfig();
    const mpesaReady = isConfigured(mpesa);

    const gateways = rows.map((r) => ({
      gateway_key: r.gateway_key,
      display_name: r.display_name,
      description: r.description,
      is_enabled: !!r.is_enabled,
      requires_config: !!r.requires_config,
      sort_order: r.sort_order,
      // Whether the gateway is wired to take money, which is not the same as
      // whether it is switched on. A gateway can be selected and still report
      // "not ready", and the operator needs to be able to see both facts.
      is_wired: r.gateway_key !== 'airtel_money',
      daraja_endpoint: DARJAJA_ENDPOINTS[r.gateway_key] || null,
      methods: (GATEWAY_METHODS[r.gateway_key] || []).map((m) => ({
        value: m,
        label: LABELS[m] || m
      })),
      is_configured: isGatewayUsable(r.gateway_key, mpesaReady)
    }));

    // Flat list of accepted methods, so a form can build its dropdown in one go.
    let enabledMethods = gateways
      .filter((g) => g.is_enabled)
      .flatMap((g) => g.methods);

    // A gateway that is switched on but not wired still puts its method in front of
    // members, and selecting it would promise a payment the app cannot collect. Drop
    // it here so the operator sees the gateway listed and enabled in Settings, but
    // nobody is offered a way to pay that cannot work. Turning it on again needs the
    // integration built, not just the switch.
    const wiredOnly = enabledMethods.filter(
      (m) => WIRED_METHODS.has(m.value)
    );
    const suppressed = enabledMethods.length - wiredOnly.length;
    if (suppressed > 0) enabledMethods = wiredOnly;

    // Never leave the chama with no way to record a payment. updateGateway refuses
    // to disable the last one, but a database edited by hand could still end up
    // here, so fall back rather than leaving every form with an empty dropdown.
    const fallbackApplied = enabledMethods.length === 0;
    if (fallbackApplied) {
      enabledMethods = (GATEWAY_METHODS.cash || []).map((m) => ({
        value: m,
        label: LABELS[m] || m
      }));
    }

    res.json({
      gateways,
      enabled_methods: enabledMethods,
      // Reported so Settings can explain a method that vanished from the list
      // after being switched on, rather than leaving the operator guessing.
      suppressed_unwired: suppressed,
      fallback_applied: fallbackApplied,
      fallback_note: fallbackApplied
        ? 'Every payment gateway is switched off, so Cash is still being offered. Turn one ' +
          'back on to change this.'
        : null,
      mpesa_callback_placeholder:
        !mpesa.callbackUrl || /your[-_]?domain|example\.com|localhost/i.test(mpesa.callbackUrl)
    });
  } catch (error) {
    console.error('Payment gateway list error:', error);
    res.status(500).json({ error: 'Failed to load payment gateways.' });
  }
};

/** Turns a gateway on or off, and renames it if asked. */
const updateGateway = async (req, res) => {
  try {
    // The route declares this as :key. Reading :gateway_key instead leaves it
    // undefined, which mysql2 rejects as an unbound parameter.
    const gateway_key = req.params.key || req.params.gateway_key;
    const { is_enabled, display_name } = req.body;

    const [rows] = await pool.execute(
      'SELECT * FROM payment_gateways WHERE gateway_key = ?',
      [gateway_key]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: `No payment gateway called ${gateway_key}.` });
    }

    const current = rows[0];
    const nextEnabled =
      is_enabled === undefined ? !!current.is_enabled : !!is_enabled;
    const nextName =
      display_name === undefined || !String(display_name).trim()
        ? current.display_name
        : String(display_name).trim().slice(0, 100);

    // Refuse to leave the chama with no way to take a payment at all.
    if (current.is_enabled && !nextEnabled) {
      const [others] = await pool.execute(
        'SELECT COUNT(*) AS n FROM payment_gateways WHERE is_enabled = 1 AND gateway_key <> ?',
        [gateway_key]
      );
      if (others[0].n === 0) {
        return res.status(400).json({
          error:
            'This is the last enabled payment gateway. Enable another one first, otherwise ' +
            'there is no way to record a payment.'
        });
      }
    }

    await pool.execute(
      'UPDATE payment_gateways SET is_enabled = ?, display_name = ? WHERE gateway_key = ?',
      [nextEnabled ? 1 : 0, nextName, gateway_key]
    );

    res.json({
      success: true,
      gateway_key,
      is_enabled: nextEnabled,
      display_name: nextName,
      message: `${nextName} is now ${nextEnabled ? 'accepted' : 'hidden from payment methods'}.`
    });
  } catch (error) {
    console.error('Payment gateway update error:', error);
    res.status(500).json({ error: 'Failed to update the payment gateway.' });
  }
};

module.exports = { listGateways, updateGateway, GATEWAY_METHODS, LABELS };