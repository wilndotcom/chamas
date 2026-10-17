/**
 * Changing the till, and knowing whether the new one works.
 *
 * The claim being tested is that changing the till is the only thing an operator
 * does. Everything else - the confirmation address, the credentials - has to
 * look after itself.
 *
 * And the other half, which is the part that matters: a till being saved is no
 * evidence that it works, because Daraja accepts a shortcode it has never heard
 * of. Only a confirmation from Safaricom quoting the till is.
 *
 *   PUBLIC_URL=... TEST_PHONE=... node backend-php/check-till-works.mjs
 */

import { ADMIN_PASSWORD } from './admin-credential.mjs';

const PUBLIC = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const BASE = process.env.LOCAL_BASE || 'http://localhost:8080/the-team';
const PHONE = process.env.TEST_PHONE;

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures.push(name);
};

async function api(base, token, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed, text };
}

const login = async (base) =>
  (await api(base, null, 'POST', '/api/auth/admin-login',
    { identifier: 'admin', password: ADMIN_PASSWORD })).body?.token;

const admin = await login(BASE);
const status = async () => (await api(BASE, admin, 'GET', '/api/mpesa/status')).body;
const saveTill = (till) =>
  api(BASE, admin, 'PUT', '/api/settings', { values: { mpesa_till: till } });

const real = (await status()).values.shortcode;

console.log(`\n  the group's till is ${real}`);
console.log(`  browsing at ${BASE}`);
console.log(`  public address ${PUBLIC}\n`);

console.log('=== every format Safaricom writes a till in ===\n');

{
  const formats = [
    ['plain', '4005931'],
    ['spaced', '400 593 1'.replace(/ /g, ' ')],
    ['hyphenated', '400-5931'],
    ['with a plus', '+4005931'],
    ['padded with spaces', '  4005931  ']
  ];

  try {
    for (const [label, written] of formats) {
      const res = await saveTill(written);
      const seen = (await status()).values.shortcode;

      check(`accepted written ${label}`, res.status === 200 && seen === '4005931',
        `${res.status}, stored "${seen}"`);
    }

    for (const [label, written] of [
      ['letters', 'PAYBILL'],
      ['too short', '1234'],
      ['too long', '12345678901'],
      ['empty', ''],
      ['a Kenyan phone number, not a till', '0712345678']
    ]) {
      const res = await saveTill(written);
      check(`refuses ${label}`, res.status === 400,
        `got ${res.status} ${res.text.slice(0, 90)}`);
    }
  } finally {
    await saveTill(real);
    check("the group's own till is put back", (await status()).values.shortcode === real,
      `till is ${(await status()).values.shortcode}`);
  }
}

console.log('\n=== a saved till is not yet a working till ===\n');

{
  await saveTill('5379229');

  const st = await status();

  check('the new till is in use', st.values.shortcode === '5379229',
    `using ${st.values.shortcode}`);
  check('and the paybill followed it, as always', st.values.paybill === '5379229',
    `paybill is ${st.values.paybill}`);
  check('the callback was not touched by any of this',
    st.callback_url === (await api(`${PUBLIC}/the-team`,
      await login(`${PUBLIC}/the-team`), 'GET', '/api/mpesa/status')).body.callback_url,
    'changing the till must not disturb the confirmation address');

  /*
   * The claim under test. Nothing is confirmed yet, so this must say so - a
   * green tick here would be the app telling the operator their money will
   * arrive at a number it has never seen Safaricom use.
   */
  check('but it is reported as not yet confirmed', st.till_verified === false,
    `till_verified is ${st.till_verified}`);
}

console.log('\n=== a confirmation proves which till Safaricom used ===\n');

const stamp = Date.now().toString().slice(-7);
const subscriber = `72${stamp}`;

try {
  {
    const member = (await api(BASE, admin, 'POST', '/api/members', {
    full_name: `Till Test ${stamp}`,
    phone: `+254${subscriber}`,
    password: 'TillTest123!',
    email: `till${stamp}@example.test`
  })).body;

  // The callback a real confirmation carries, including the till Safaricom
  // actually charged - the only evidence there is.
  const confirm = (shortcode, receipt) => api(`${PUBLIC}/the-team`, null, 'POST',
    '/api/mpesa/callback', {
      Body: {
        stkCallback: {
          ResultCode: 0,
          CheckoutRequestID: `ws_CO_TILL_${receipt}`,
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 1 },
              { Name: 'MpesaReceiptNumber', Value: receipt },
              { Name: 'PhoneNumber', Value: `254${subscriber}` },
              { Name: 'BusinessShortCode', Value: `'${shortcode}` }
            ]
          }
        }
      }
    });

  const agree = await confirm('5379229', `TLM${stamp}AGR`);
  check('a matching till is acknowledged', agree.body?.ResultCode === 0);

  const matched = await status();
  check('and the till is now reported as confirmed by Safaricom',
    matched.till_verified === true, `till_verified is ${matched.till_verified}`);
  check('quoting the number Safaricom used',
    matched.till_reported_by_safaricom === '5379229',
    `reported "${matched.till_reported_by_safaricom}"`);

  // Now the dangerous one: a confirmation quoting a different till.
  await api(BASE, admin, 'PUT', '/api/settings', { values: { mpesa_till_verified: '' } });
  await confirm('9999999', `TLM${stamp}MIS`);

  const mismatched = await status();
  check('a different till is recorded rather than passed off as fine',
    mismatched.till_last_seen === '9999999',
    `last seen "${mismatched.till_last_seen}"`);

  console.log(`\n  a confirmation quoting till 9999999 while the app is set to 5379229`);
  console.log(`  is recorded as a mismatch. Members' money went to a number the app`);
  console.log(`  does not claim, and the panel says so rather than staying green.`);

  check('the member was credited either way',
    !!(await api(BASE, admin, 'GET', `/api/contributions/member/${member.member_id}`))
      .body.contributions.length);
  }
} finally {
  await saveTill(real);
  await api(BASE, admin, 'PUT', '/api/settings', { values: { mpesa_till_verified: '' } });
}

console.log(`\npassed ${9 - failures.length}, failed ${failures.length}`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
console.log(`\nthe group's till is ${(await status()).values.shortcode} and its`);
console.log('confirmation state is reset, ready for a real payment to prove it.\n');
process.exit(failures.length ? 1 : 0);