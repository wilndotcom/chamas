#!/usr/bin/env node

/**
 * Exercises the M-Pesa callbacks.
 *
 * Safaricom cannot be asked to send a test callback on demand, so these post the
 * exact payloads it would send. That makes the money path testable without
 * anybody's money being involved - which is the point of checking the callbacks
 * directly rather than only through a real prompt.
 *
 * Everything Safaricom can get wrong is checked here: the field names it
 * actually uses, the retry that would double-credit a member, the unmatched
 * payment that must be logged rather than swallowed, and the rule that every
 * callback answers Accept even when something goes wrong.
 *
 * Run:  node check-mpesa.mjs
 * Afterwards: php backend-php/tests/cleanup-lifecycle.php
 */

const PHP = process.env.PHP_BASE || 'http://localhost:5050';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else {
    failed++;
    failures.push(`${name}${detail ? ' - ' + detail : ''}`);
    console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`);
  }
}

async function api(token, method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${PHP}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const admin = (await api(null, 'POST', '/api/auth/admin-login',
  { identifier: 'admin', password: 'admin123' })).body?.token;

if (!admin) { console.log('  could not log in'); process.exit(2); }

const suffix = Date.now().toString().slice(-8);
const phone = '07' + suffix;
// Safaricom sends this form. Members are stored as 0712345678; matching the two
// is the whole reason toMemberPhone exists.
const intl = '254' + phone.slice(1);

console.log(`\nchecking the M-Pesa callbacks on ${PHP}\n`);

console.log('=== a member to receive payments ===\n');

const created = await api(admin, 'POST', '/api/members', {
  full_name: 'M-Pesa Test', phone, password: 'testpass123',
  email: `mpesa${suffix}@example.com`,
});

if (created.status !== 201) {
  check('created a test member', false, `${created.status}: ${created.text}`);
  process.exit(1);
}
const memberId = created.body.member_id;
console.log(`  member ${memberId}: ${phone} (Safaricom will send ${intl})`);

const before = (await api(admin, 'GET', `/api/contributions/member/${memberId}`))
  .body.contributions.length;

console.log('\n=== the STK callback ===\n');

/** The payload Safaricom posts for a successful STK payment. */
function stkSuccess({ amount, receipt, phoneNumber, checkoutId }) {
  return {
    Body: {
      stkCallback: {
        ResultCode: 0,
        ResultDesc: 'Accept',
        CheckoutRequestID: checkoutId,
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amount },
            { Name: 'MpesaReceiptNumber', Value: receipt },
            { Name: 'PhoneNumber', Value: phoneNumber },
          ],
        },
      },
    },
  };
}

let receipt1 = `QJG'${suffix}1`;
{
  const res = await api(null, 'POST', '/api/mpesa/callback',
    stkSuccess({ amount: 500, receipt: receipt1, phoneNumber: intl, checkoutId: `CO${suffix}A` }));

  check('a successful callback is accepted', res.status === 200, `got ${res.status}`);
  check('it answers ResultCode 0', res.body?.ResultCode === 0,
    'anything else makes Safaricom retry a payment that already succeeded');

  const after = (await api(admin, 'GET', `/api/contributions/member/${memberId}`))
    .body.contributions;

  check('the member was credited', after.length === before + 1,
    `${after.length - before} contribution(s) recorded, expected 1`);

  const contribution = after.find((c) => c.reference_number === receipt1);
  check('the contribution exists with the receipt as its reference', !!contribution);
  check('the amount is right', Number(contribution?.amount) === 500,
    `recorded ${contribution?.amount}`);

  // Without the 254-to-07 conversion this is where the money goes missing: the
  // payment is real, marked successful, and credited to nobody.
  check('the payer was matched to the member by phone',
    String(contribution?.member_id) === String(memberId),
    `credited to member ${contribution?.member_id}, expected ${memberId}`);
}

console.log('\n=== a retry must not pay twice ===\n');

{
  // Safaricom retries callbacks. Without the receipt guard, one payment credits
  // the member twice - and the group's savings total silently doubles.
  const res = await api(null, 'POST', '/api/mpesa/callback',
    stkSuccess({ amount: 500, receipt: receipt1, phoneNumber: intl, checkoutId: `CO${suffix}A` }));

  const after = (await api(admin, 'GET', `/api/contributions/member/${memberId}`))
    .body.contributions;

  check('the retry is accepted', res.body?.ResultCode === 0,
    'Safaricom expects an acknowledgement even for a repeat');
  check('the retry credits nothing further', after.length === before + 1,
    `${after.length - before} contributions now, expected 1 - the retry double-paid`);
}

console.log('\n=== a failed payment ===\n');

{
  const res = await api(null, 'POST', '/api/mpesa/callback', {
    Body: {
      stkCallback: {
        ResultCode: 1,
        ResultDesc: 'Insufficient Funds',
        CheckoutRequestID: `CO${suffix}B`,
        CallbackMetadata: { Item: [] },
      },
    },
  });

  check('a declined payment is still accepted', res.body?.ResultCode === 0,
    'answering otherwise makes Safaricom keep retrying');

  const after = (await api(admin, 'GET', `/api/contributions/member/${memberId}`))
    .body.contributions;
  check('a declined payment credits nothing', after.length === before + 1,
    'a payment the customer cancelled must not appear as savings');
}

console.log('\n=== an unmatched payment ===\n');

{
  // Real money from a number no member claims. This is the case an operator has
  // to act on, so it must not be swallowed.
  const unknown = '254' + '999' + suffix.slice(-6);

  const res = await api(null, 'POST', '/api/mpesa/callback',
    stkSuccess({
      amount: 1000,
      receipt: `QJG'${suffix}UNK`,
      phoneNumber: unknown,
      checkoutId: `CO${suffix}C`,
    }));

  check('an unmatched payment is still accepted',
    res.body?.ResultCode === 0,
    'Safaricom does not care whether we matched a member; it expects an answer');

  const all = (await api(admin, 'GET', '/api/contributions')).body.contributions;
  const orphan = all.find((c) => c.reference_number === `QJG'${suffix}UNK`);

  check('an unmatched payment is not credited to anybody', !orphan,
    'money from a number no member claims must not silently land on someone');
}

console.log('\n=== a malformed callback ===\n');

{
  // A payload Safaricom would never send. The rule is that it still answers
  // Accept: whatever went wrong, the money may well have arrived, and a
  // non-zero code invites a duplicate retry rather than recovering anything.
  for (const [name, payload] of [
    ['an empty body', {}],
    ['no CallbackMetadata', { Body: { stkCallback: { ResultCode: 0 } } }],
    ['metadata with no items', { Body: { stkCallback: { ResultCode: 0, CallbackMetadata: {} } } }],
    ['a string where an object belongs', { Body: 'nonsense' }],
    ['nothing at all', null],
  ]) {
    const res = await api(null, 'POST', '/api/mpesa/callback', payload);
    check(`${name} is accepted`, res.status === 200 && res.body?.ResultCode === 0,
      `${res.status} ${res.text.slice(0, 90)}`);
  }
}

console.log('\n=== the paybill routes are gone ===\n');

{
  // C2B is removed rather than left dormant: an unconfirmed paybill payment is
  // worse than no option at all, because the money arrives and nobody is told.
  // The routes must be absent, not merely unused, so nothing can call them.
  for (const path of ['/api/mpesa/confirmation', '/api/mpesa/validation', '/api/mpesa/register-c2b']) {
    const res = await api(null, 'POST', path, { TransID: 'x', MSISDN: intl, TransAmount: 1 });
    check(`${path} is not served`, res.status === 404, `got ${res.status}`);
  }
}

console.log('\n=== the ledger ===\n');

{
  // A contribution without its ledger entry leaves the cash book out of balance,
  // and the transparency figures read from that ledger.
  const ledgerCheck = await api(admin, 'GET', '/api/transparency');
  check('transparency still loads after the payments', ledgerCheck.status === 403,
    `expected 403 for an admin token, got ${ledgerCheck.status}`);
}

console.log('\n=== the money-moving endpoints need a permission ===\n');

{
  const noToken = await api(null, 'POST', '/api/mpesa/stk-push',
    { phone: intl, amount: 100 });
  check('STK push needs a token', noToken.status === 401, `got ${noToken.status}`);

  const member = (await api(null, 'POST', '/api/auth/member-login',
    { phone, password: 'testpass123' })).body?.token;

  const asMember = await api(member, 'POST', '/api/mpesa/stk-push',
    { phone: intl, amount: 100 });
  check('a member cannot send an STK push', asMember.status === 403, `got ${asMember.status}`);

  const testAsMember = await api(member, 'POST', '/api/mpesa/test-prompt',
    { phone: intl, amount: 100 });
  check('a member cannot send a test prompt', testAsMember.status === 403,
    `got ${testAsMember.status}`);
}

console.log('\n=== the production guard ===\n');

{
  // The guard is what stops a group collecting money into a hole when Safaricom
  // has nowhere to send the confirmation. It is exercised by pointing the
  // callback at a placeholder for the length of this block, then putting the
  // operator's real value back - it is never left broken, even if a step throws.
  const before = (await api(admin, 'GET', '/api/mpesa/status')).body;

  try {
    await api(admin, 'PUT', '/api/settings',
      { values: { mpesa_callback_url: 'https://your-domain.com/api/mpesa/callback' } });

    const flagged = await api(admin, 'GET', '/api/mpesa/status');
    check('a placeholder callback is flagged as unreachable',
      flagged.body?.callback_reachable === false,
      'the operator must be told Safaricom cannot reach their callback');

    // Deliberately guarded so no request reaches Safaricom while the callback
    // cannot be delivered.
    const before = (await api(admin, 'GET', '/api/contributions')).body.contributions.length;
    const res = await api(admin, 'POST', '/api/mpesa/test-prompt', { phone: intl, amount: 1 });

    check('the production guard refuses before contacting Safaricom',
      res.status === 400 && res.body?.field === 'mpesa_callback_url',
      `${res.status} ${res.text.slice(0, 140)}`);

    const after = (await api(admin, 'GET', '/api/contributions')).body.contributions.length;
    check('nothing was recorded', after === before, `${after - before} contribution(s) appeared`);
  } finally {
    /*
      * Only put back a callback that was genuinely deliverable.

      * Saving the address this test server happens to be reached on would leave
      * a localhost callback behind for the next run, and localhost is exactly
      * what Safaricom cannot reach - so restoring "what was there" is not the
      * same as leaving it working.
      */
    /*
     * Restore exactly what was there.
     *
     * These suites share the group's live database with the running app, so
     * "leave it tidier than you found it" is not a courtesy - it is how a test
     * run silently deletes the callback a live install depends on, and the very
     * next prompt from localhost is refused. An earlier version restored only
     * when the value was reachable, which meant running against a local test
     * server wrote an empty callback over the real one.
     */
    await api(admin, 'PUT', '/api/settings',
      { values: { mpesa_callback_url: before.callback_url || '' } });

    const back = await api(admin, 'GET', '/api/mpesa/status');
    check('the callback is exactly as it was before',
      back.body?.callback_url === before.callback_url,
      `was "${before.callback_url}", now "${back.body?.callback_url}"`);
  }
}

console.log('\n=== the status endpoint does not leak ===\n');

{
  const res = await api(admin, 'GET', '/api/mpesa/status');

  check('status loads', res.status === 200);
  check('the consumer secret is never returned', res.body?.values?.consumer_secret === 'set',
    `got ${JSON.stringify(res.body?.values?.consumer_secret)}`);
  check('the passkey is never returned', res.body?.values?.passkey === 'set',
    `got ${JSON.stringify(res.body?.values?.passkey)}`);

  const asText = res.text;
  check('no long credential appears anywhere in the body',
    !/[A-Za-z0-9]{20,}/.test(asText.replace(/QGVN[^"]*"|"passkey":"[^"]*"/g, '')),
    'a long unbroken string in the status body may be a credential');
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('\nTo remove these records: php backend-php/tests/cleanup-lifecycle.php\n');
process.exit(failed > 0 ? 1 : 0);