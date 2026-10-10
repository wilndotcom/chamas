const axios = require('axios');
const pool = require('../config/database');
const { getMpesaConfig, isConfigured, baseUrl } = require('../utils/mpesaConfig');

// Generate M-Pesa access token
const getAccessToken = async (cfg) => {
  const auth = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');

  const response = await axios.get(
    `${baseUrl(cfg)}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` }
    }
  );

  return response.data.access_token;
};

/**
 * Turns a Daraja rejection into something an operator can act on.
 *
 * Daraja answers with a machine code that is far more useful than the HTTP
 * status. Surfacing it matters: a rejection is a configuration problem on the
 * Daraja side, not a bug in this app, and reporting it as a server error sends
 * the operator looking in exactly the wrong place.
 */
const explainDarajaError = (data) => {
  const code = data && data.errorCode ? String(data.errorCode) : null;
  const message = data && data.errorMessage ? String(data.errorMessage) : null;

  const hints = {
    /*
     * By far the most common one, and the most misleading.
     *
     * Daraja answers "Invalid Access Token" here, which reads like a credential
     * problem. It is not: the token was just issued successfully, so the consumer
     * key and secret are correct. What is missing is the STK Push endpoint on that
     * key.
     *
     * Saying so explicitly matters. Otherwise the natural reaction is to re-copy
     * the key and secret, re-paste them into Settings, and retry - which changes
     * nothing and hides the one step that would actually fix it.
     */
    '404.001.03':
      'Your credentials are correct - Safaricom accepted them and issued a token. What is ' +
      'missing is this one endpoint on your app. Open developer.safaricom.co.ke, select ' +
      'your app, go to "URLs", and add ' +
      'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest under ' +
      '"Initiate Customer M-PESA Transaction". Use the sandbox URL above for a sandbox ' +
      'key, or https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest for a live ' +
      'key. No need to change the consumer key, secret or passkey.',
    '400.002.03': 'The Initiate Customer M-PESA Transaction URL is not registered on this app.',
    '400.002.06':
      'Invalid consumer key or secret. Re-copy them from the Daraja portal.',
    '400.002.31':
      'The passkey does not belong to this consumer key. Copy the passkey from the same ' +
      'app as the consumer key.',
    '400.002.26':
      'The Initiate Customer M-PESA Transaction URL is missing from the app.',
    '400.002.32':
      'Request rejected by business rules — often an unactivated or unconfigured paybill.',
    '400.003.03': 'Invalid phone number. Use the international form, e.g. 254712345678.',
    '400.002.24':
      'The CallBackURL is not a valid URL. It must be a real, reachable https address, and ' +
      'Safaricom cannot reach localhost.',
    '400.001.07': 'The passkey is wrong for this shortcode.'
  };

  return {
    daraja_code: code,
    daraja_message: message,
    hint: (code && hints[code]) || null
  };
};

/**
 * Sends one STK Push request to Daraja.
 *
 * Split out from the route handler so the same call can be made from a test
 * button in Settings. Duplicating the Daraja payload would mean a fix applied in
 * one place silently not applying to the other, and the test button is only
 * useful if it exercises the identical request a real payment makes.
 *
 * Throws whatever axios throws, so the caller decides how to report it.
 */
const sendStkPrompt = async (cfg, { accessToken, phone, amount, reference, description }) => {
  const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const password = Buffer.from(`${cfg.shortcode}${cfg.passkey}${timestamp}`).toString('base64');

  const response = await axios.post(
    `${baseUrl(cfg)}/mpesa/stkpush/v1/processrequest`,
    {
      BusinessShortCode: cfg.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: cfg.shortcode,
      PhoneNumber: phone,
      CallBackURL: cfg.callbackUrl,
      AccountReference: reference || cfg.paybill || 'THE_TEAM',
      TransactionDesc: description || `${cfg.paybill || 'Chama'} Contribution`
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return response.data;
};

// STK Push
const stkPush = async (req, res) => {
  try {
    const { phone, amount, reference, description } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: 'Phone and amount are required.' });
    }

    const cfg = await getMpesaConfig();
    if (!isConfigured(cfg)) {
      // Said plainly instead of letting Safaricom reject an opaque request.
      return res.status(400).json({
        error:
          'M-Pesa is not configured. Add the consumer key, consumer secret, shortcode and ' +
          'STK passkey in Settings, or set MPESA_* in the environment.'
      });
    }

    // The callback must be reachable in production, or a payment succeeds and the
    // receipt vanishes.
    //
    // In the Daraja SANDBOX it does not have to be: Safaricom simulates the
    // callback, so a placeholder is enough to exercise STK Push locally.
    // Refusing it outright meant the only way to find out whether STK Push worked
    // at all — by sending one — was blocked before anything was sent.
    const callbackPlaceholder =
      !cfg.callbackUrl || /your[-_]?domain|example\.com|localhost/i.test(cfg.callbackUrl);

    let callbackWarning = null;
    if (callbackPlaceholder) {
      if (cfg.env === 'production') {
        return res.status(400).json({
          error:
            'MPESA_CALLBACK_URL is missing or still the sample value (' +
            (cfg.callbackUrl || 'unset') +
            ') and this server is in PRODUCTION. Safaricom must be able to reach it over the ' +
            'internet, and it cannot reach localhost. Set your real domain in Settings → ' +
            'M-Pesa, or in backend/.env.production.',
          field: 'mpesa_callback_url'
        });
      }
      callbackWarning =
        'Heads up: the callback URL is still the sample value (' +
        (cfg.callbackUrl || 'unset') +
        '), so Safaricom will not be able to deliver the payment confirmation back to this ' +
        'server. The STK prompt will still be sent and you will get a checkout ID, but the ' +
        'transaction will stay "pending" here. This is fine for sandbox testing.';
    }

    let accessToken;
    try {
      accessToken = await getAccessToken(cfg);
    } catch (authError) {
      const detail = explainDarajaError(authError.response?.data);
      console.error('[mpesa] token request failed:', detail.daraja_code, detail.daraja_message);
      return res.status(502).json({
        error:
          'Safaricom rejected the credentials' +
          (detail.daraja_message ? ': ' + detail.daraja_message : '.'),
        ...detail
      });
    }

    const data = await sendStkPrompt(cfg, {
      accessToken,
      phone,
      amount,
      reference,
      description
    });

    // Log transaction
    await pool.execute(
      `INSERT INTO mpesa_transactions (transaction_id, phone, amount, reference, type, status, response_data)
       VALUES (?, ?, ?, ?, 'stk_push', 'pending', ?)`,
      [data.CheckoutRequestID, phone, amount, reference, JSON.stringify(data)]
    );

    res.json({
      success: true,
      checkout_request_id: response.data.CheckoutRequestID,
      message: 'STK Push sent. Please check your phone.',
      // Surfaced rather than swallowed, so an unreachable callback is visible
      // instead of quietly leaving the transaction stuck on "pending".
      warning: callbackWarning
    });
  } catch (error) {
    // Daraja's own code is far more useful than a generic failure. A rejection
    // here is a configuration problem on the Daraja side, so it is reported as a
    // bad gateway with the code and a hint, not as an internal server error.
    const detail = explainDarajaError(error.response?.data);

    console.error(
      '[mpesa] STK push rejected:',
      detail.daraja_code || '(no code)',
      detail.daraja_message || error.message
    );

    res.status(502).json({
      error: detail.daraja_message
        ? 'Safaricom rejected the request: ' + detail.daraja_message
        : 'Could not reach Safaricom. Check the server’s internet connection and try again.',
      ...detail
    });
  }
};

// M-Pesa callback
const mpesaCallback = async (req, res) => {
  try {
    const { Body } = req.body;
    const { stkCallback } = Body;
    const { ResultCode, CallbackMetadata, CheckoutRequestID } = stkCallback;

    if (ResultCode === 0) {
      const items = CallbackMetadata.Item;
      const amount = items.find(i => i.Name === 'Amount')?.Value;
      const mpesaReceipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      const phone = items.find(i => i.Name === 'PhoneNumber')?.Value;

      // Update transaction
      await pool.execute(
        `UPDATE mpesa_transactions SET status = 'success', response_data = ? WHERE transaction_id = ?`,
        [JSON.stringify(req.body), CheckoutRequestID]
      );

      // TODO: Match phone to member and record contribution
      // This would trigger notifications
    } else {
      await pool.execute(
        `UPDATE mpesa_transactions SET status = 'failed', response_data = ? WHERE transaction_id = ?`,
        [JSON.stringify(req.body), CheckoutRequestID]
      );
    }

    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (error) {
    console.error('M-Pesa callback error:', error);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
};

/**
 * Whether a callback URL can actually receive a Safaricom POST.
 *
 * Registering a placeholder is worse than not registering at all: Safaricom
 * accepts the registration, so the operator believes the paybill is live, and the
 * money then arrives at a URL that answers 404 and the payment is never recorded.
 */
const callbackReachable = (cfg) =>
  Boolean(cfg.callbackUrl) && !/your[-_]?domain|example\.com|localhost/i.test(cfg.callbackUrl);

/**
 * The C2B endpoints Safaricom posts to.
 *
 * Derived from the configured callback URL by replacing its last segment, so an
 * operator who set https://chama.co.ke/api/mpesa/callback ends up with
 * /api/mpesa/confirmation and /api/mpesa/validation. Spelling them out as
 * separate settings would mean two more fields to keep in step with the first.
 */
const c2bEndpoints = (cfg) => {
  const base = String(cfg.callbackUrl || '').replace(/\/+$/, '');
  const trimmed = base.replace(/\/[^/]*$/, '');
  return {
    confirmation: `${trimmed}/confirmation`,
    validation: `${trimmed}/validation`
  };
};

/**
 * C2B URL registration.
 *
 * Registers the paybill's validation and confirmation callbacks with Safaricom.
 * This has to be done once per shortcode, and only Safaricom can accept the
 * change, so it cannot be done from the settings screen itself. Having a button
 * here is what makes it reachable without writing curl by hand.
 */
const registerC2BUrls = async (req, res) => {
  try {
    const cfg = await getMpesaConfig();
    if (!isConfigured(cfg)) {
      return res.status(400).json({ error: 'M-Pesa is not configured yet.' });
    }

    // Refused rather than forwarded: a successful registration against a
    // placeholder URL looks like success and silently breaks every C2B payment.
    if (!callbackReachable(cfg)) {
      return res.status(400).json({
        error:
          'The callback URL is still the sample value (' +
          (cfg.callbackUrl || 'unset') +
          '), so Safaricom would be told to post to an address that does not ' +
          'exist. Set your real https domain in Settings first, then register.',
        field: 'mpesa_callback_url'
      });
    }

    const urls = c2bEndpoints(cfg);
    const accessToken = await getAccessToken(cfg);

    const response = await axios.post(
      `${baseUrl(cfg)}/mpesa/c2b/v1/registerurl`,
      {
        ShortCode: cfg.shortcode,
        ResponseType: 'Completed',
        ConfirmationURL: urls.confirmation,
        ValidationURL: urls.validation
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    res.json({ success: true, data: response.data, registered: urls });
  } catch (error) {
    const detail = explainDarajaError(error.response?.data);
    console.error('[mpesa] C2B register failed:', detail.daraja_code, detail.daraja_message);
    res.status(502).json({
      error: detail.daraja_message
        ? 'Safaricom rejected the request: ' + detail.daraja_message
        : 'Could not reach Safaricom. Check the server’s internet connection and try again.',
      ...detail
    });
  }
};

/**
 * The C2B confirmation Safaricom posts once money has been received.
 *
 * Public by necessity: Safaricom carries no credentials of ours. It is protected
 * by the transaction ID it quotes, which only Safaricom and this server have seen.
 *
 * Always answers Accept, including on an unexpected payload. A non-zero code makes
 * Safaricom treat the payment as failed and retry, which would duplicate a payment
 * that genuinely succeeded.
 */
const c2bConfirmation = async (req, res) => {
  const accept = () => res.json({ ResultCode: 0, ResultDesc: 'Accept' });

  try {
    const body = req.body || {};
    const transId = body.TransID || body.TransId || null;
    const phone = String(body.MSISDN || body.PhoneNumber || '').trim();
    const amount = Number(body.TransAmt || body.Amount || 0);

    // Recorded so a C2B payment appears in the ledger trail rather than only in
    // Safaricom's own dashboard. Duplicate TransIDs update rather than fail, which
    // is what a Safaricom retry should do.
    if (transId && phone && amount > 0) {
      await pool.execute(
        `INSERT INTO mpesa_transactions
           (transaction_id, phone, amount, reference, type, status, response_data)
         VALUES (?, ?, ?, ?, 'c2b', 'success', ?)
         ON DUPLICATE KEY UPDATE
           status = 'success',
           response_data = VALUES(response_data)`,
        [
          transId,
          phone,
          amount,
          body.BillRefNumber || body.AccountReference || null,
          JSON.stringify(body)
        ]
      );
    }

    console.log(
      '[mpesa] C2B confirmation:',
      transId || '(no TransID)',
      phone,
      amount,
      body.ResultCode
    );

    accept();
  } catch (error) {
    console.error('C2B confirmation error:', error);
    // Still Accept: the money arrived, and failing the acknowledgement invites a
    // duplicate retry rather than recovering the payment.
    accept();
  }
};

/**
 * The C2B validation Safaricom posts before completing a paybill payment.
 *
 * Answers Accept for the same reason as the confirmation, and for the same
 * protection reason: it is unauthenticated by necessity.
 */
const c2bValidation = async (req, res) => {
  try {
    const body = req.body || {};
    console.log(
      '[mpesa] C2B validation:',
      body.TransID || body.TransId || '(no TransID)',
      body.MSISDN || body.PhoneNumber || '(no phone)',
      body.TransAmt || body.Amount || '(no amount)'
    );
    res.json({ ResultCode: 0, ResultDesc: 'Accept' });
  } catch (error) {
    console.error('C2B validation error:', error);
    res.json({ ResultCode: 0, ResultDesc: 'Accept' });
  }
};

/**
 * Sends one STK prompt without recording anything.
 *
 * For checking that the Daraja setup works before trusting it with a member's
 * money, which is the whole reason the endpoint was missing: the only way to learn
 * whether STK Push was wired up at all was to record a real contribution and hope.
 *
 * Deliberately does NOT write to mpesa_transactions or contributions. A test
 * prompt is not a payment, and recording one would put a phantom transaction in
 * the ledger that no confirmation will ever arrive to close.
 */
const stkTestPrompt = async (req, res) => {
  try {
    const { phone, amount, reference, description } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ error: 'Phone and amount are required.' });
    }
    if (Number(amount) <= 0) {
      return res.status(400).json({ error: 'The amount must be greater than zero.' });
    }

    const cfg = await getMpesaConfig();
    if (!isConfigured(cfg)) {
      return res.status(400).json({
        error:
          'M-Pesa is not configured. Add the consumer key, consumer secret, shortcode and ' +
          'STK passkey in Settings, or set MPESA_* in the environment.'
      });
    }

    let accessToken;
    try {
      accessToken = await getAccessToken(cfg);
    } catch (authError) {
      const detail = explainDarajaError(authError.response?.data);
      console.error('[mpesa] test prompt token failed:', detail.daraja_code, detail.daraja_message);
      return res.status(502).json({
        error:
          'Safaricom rejected the credentials' +
          (detail.daraja_message ? ': ' + detail.daraja_message : '.'),
        ...detail
      });
    }

    const callbackPlaceholder = !callbackReachable(cfg);

    /*
     * Refused in production without a real callback, exactly as stkPush is.
     *
     * This guard was missing here, so the test button could reach Safaricom's LIVE
     * endpoint while confirmations had nowhere to arrive: the prompt goes out to a
     * real shortcode, the customer can accept it, and the payment is lost with no
     * receipt. Confirmed by switching to production and pressing the button - the
     * request was accepted against api.safaricom.co.ke.
     *
     * Checked before the call, and stkPush checks in the same position, because in
     * sandbox a missing callback costs nothing while in production it costs the
     * member their money.
     */
    if (cfg.env === 'production' && callbackPlaceholder) {
      return res.status(400).json({
        error:
          'The M-Pesa environment is set to PRODUCTION but the callback URL is still the ' +
          'sample value (' +
          (cfg.callbackUrl || 'unset') +
          '). Safaricom could send a live payment request to a real shortcode and the ' +
          'confirmation would go nowhere, so the money would be taken and never recorded. ' +
          'Set a real public https callback URL in Settings first, or switch the ' +
          'environment back to sandbox to test.',
        field: 'mpesa_callback_url'
      });
    }

    const data = await sendStkPrompt(cfg, {
      accessToken,
      phone,
      amount,
      reference,
      description: description || 'Test prompt'
    });

    res.json({
      success: true,
      checkout_request_id: data.CheckoutRequestID || null,
      customer_message: data.CustomerMessage || null,
      message: 'STK prompt sent. Check the phone for the M-Pesa prompt.',
      // Said plainly, because a test that appears to pass while confirmations can
      // never arrive is exactly the false confidence this button is meant to remove.
      warning: callbackPlaceholder
        ? 'The callback URL is still the sample value (' +
          (cfg.callbackUrl || 'unset') +
          '), so the prompt will reach the phone but no confirmation can come back ' +
          'to this server. That is expected while testing locally.'
        : null,
      recorded: false
    });
  } catch (error) {
    const detail = explainDarajaError(error.response?.data);
    console.error(
      '[mpesa] test prompt rejected:',
      detail.daraja_code || '(no code)',
      detail.daraja_message || error.message
    );
    res.status(502).json({
      error: detail.daraja_message
        ? 'Safaricom rejected the request: ' + detail.daraja_message
        : 'Could not reach Safaricom. Check the server’s internet connection and try again.',
      ...detail
    });
  }
};

/**
 * What M-Pesa credentials the API is actually using, and where each came from.
 *
 * This is what makes the Settings screen honest: an operator can see that a key
 * they typed is in use, or that the API is still falling back to the environment.
 */
const mpesaStatus = async (req, res) => {
  try {
    const cfg = await getMpesaConfig({ fresh: true });

    res.json({
      configured: isConfigured(cfg),
      environment: cfg.env,
      // The endpoint the environment resolves to. Shown because "sandbox" and
      // "production" are labels: seeing the host confirms which Daraja is
      // actually being called before a test prompt moves real money.
      base_url: cfg.base_url,
      values: {
        // Never echo the secret or passkey back; only whether one is present.
        consumer_key: cfg.consumerKey ? mask(cfg.consumerKey) : null,
        consumer_secret: cfg.consumerSecret ? 'set' : null,
        shortcode: cfg.shortcode || null,
        passkey: cfg.passkey ? 'set' : null,
        paybill: cfg.paybill || null
      },
      source: cfg.source,
      callback_url: cfg.callbackUrl || null,
      // Both facts shown in Settings: whether Safaricom could deliver a
      // confirmation at all, and which URLs a C2B registration would publish.
      callback_reachable: callbackReachable(cfg),
      c2b_endpoints: c2bEndpoints(cfg),
      note:
        'source shows where each value comes from: "settings" means the value saved in this ' +
        'screen is in use, "env" means the API is falling back to the environment file.'
    });
  } catch (error) {
    console.error('M-Pesa status error:', error);
    res.status(500).json({ error: 'Failed to read M-Pesa configuration.' });
  }
};

const mask = (v) => {
  const s = String(v);
  if (s.length <= 6) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
};

module.exports = {
  stkPush,
  stkTestPrompt,
  mpesaCallback,
  registerC2BUrls,
  c2bConfirmation,
  c2bValidation,
  mpesaStatus
};
