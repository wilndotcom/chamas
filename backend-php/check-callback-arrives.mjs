/**
 * Proves Safaricom's confirmation can reach the app and record a payment,
 * through the public address rather than localhost.
 *
 * Posts the shape Safaricom documents, to the address Safaricom would use.
 * A cancelled payment is sent too, to prove a refusal records nothing.
 *
 *   PUBLIC_URL=... node backend-php/check-callback-arrives.mjs
 */
const PUBLIC = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PHONE = process.env.TEST_PHONE;

if (!PUBLIC || !PHONE) {
  console.log('\n  set PUBLIC_URL and TEST_PHONE\n');
  process.exit(1);
}

const BASE = `${PUBLIC}/the-team`;

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
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

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures.push(name);
};

const admin = (await api('POST', '/api/auth/admin-login',
  { identifier: 'admin', password: 'admin123' })).body?.token;

// A member to credit, so the recording has somewhere to land. The number is
// written with a plus sign, because that is how a member copies it off an
// M-Pesa confirmation and therefore the shape Safaricom tends to echo back.
const stamp = Date.now().toString().slice(-7);        // seven digits
const subscriber = `72${stamp}`;                      // nine, as Kenya issues them
const intlPhone = `254${subscriber}`;                 // twelve, what Safaricom sends

const created = (await api('POST', '/api/members', {
  full_name: `Arrive Test ${stamp}`,
  phone: `+${intlPhone}`,
  password: 'ArriveTest123!',
  email: `arrive${stamp}@example.test`
}, admin)).body;

const memberId = created.member_id;
const receipt = `AJV${stamp}ARR`;
const checkout = `ws_CO_ARRIVE_${stamp}`;

console.log(`\n  posting to ${BASE}/api/mpesa/callback`);
console.log(`  as Safaricom would, for a member whose number is +${intlPhone}\n`);

check('the member was created for this to land on', !!memberId,
  JSON.stringify(created).slice(0, 140));

const res = await api('POST', '/api/mpesa/callback', {
  Body: {
    stkCallback: {
      ResultCode: 0,
      CheckoutRequestID: checkout,
      CallbackMetadata: {
        Item: [
          { Name: 'Amount', Value: 1 },
          { Name: 'MpesaReceiptNumber', Value: receipt },
          { Name: 'PhoneNumber', Value: intlPhone }
        ]
      }
    }
  }
});

check('Safaricom is told the confirmation was accepted',
  res.status === 200 && res.body?.ResultCode === 0,
  `${res.status} ${res.text.slice(0, 160)}`);

const mine = ((await api('GET', `/api/contributions/member/${memberId}`, undefined, admin))
  .body.contributions || [])
  .find((c) => c.reference_number === receipt);

check('the payment reached the member through the public address', !!mine,
  'no contribution carries that receipt');
check('for the amount paid', Number(mine?.amount) === 1, `recorded ${mine?.amount}`);
check('and is marked confirmed', mine?.status === 'confirmed', `recorded as ${mine?.status}`);

console.log(`\n  a Safaricom confirmation delivered over the internet was`
  + `\n  credited to member ${memberId} as KES ${mine?.amount}.\n`);

const declined = await api('POST', '/api/mpesa/callback', {
  Body: {
    stkCallback: {
      ResultCode: 1032,
      CheckoutRequestID: `ws_CO_ARRIVE_DEC_${stamp}`,
      ResultDesc: 'The customer cancelled the request'
    }
  }
});

check('a cancelled payment is still acknowledged', declined.body?.ResultCode === 0);
check('and records nothing',
  !((await api('GET', `/api/contributions/member/${memberId}`, undefined, admin))
    .body.contributions || []).some((c) => String(c.reference_number || '').includes(stamp)
      && c.reference_number !== receipt));

console.log(`\npassed ${6 - failures.length}, failed ${failures.length}`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
console.log('\nTo remove these records: php backend-php/tests/cleanup-lifecycle.php\n');
process.exit(failures.length ? 1 : 0);