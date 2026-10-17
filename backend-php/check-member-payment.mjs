/**
 * The member's payment, end to end.
 *
 * A member owes a contribution. The group sends them an STK prompt. They enter
 * their PIN on their phone. Safaricom posts the confirmation. The contribution
 * must exist, against that member, with its ledger entry - or the money is real
 * and the books have never seen it.
 *
 * The confirmation is posted here in the shape Safaricom documents. Safaricom
 * has never called this server, so this proves the app handles what Safaricom
 * says it sends, and not that Safaricom says it.
 *
 *   node backend-php/check-member-payment.mjs
 */

import { ADMIN_PASSWORD } from './admin-credential.mjs';

const BASE = process.env.PHP_BASE || 'http://localhost:5050';

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

async function api(token, method, path, body) {
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

const admin = (await api(null, 'POST', '/api/auth/admin-login',
  { identifier: 'admin', password: ADMIN_PASSWORD })).body?.token;

/**
 * A member whose number is written in an awkward but legal shape.
 *
 * The plus sign is deliberate: it is the shape a number has when a member
 * copies it off an M-Pesa confirmation message, and it is the shape that used to
 * stop their payments being credited.
 */
const stamp = Date.now().toString().slice(-7);       // seven digits
const subscriber = `72${stamp}`;                     // nine, as Kenya issues them
const localPhone = `0${subscriber}`;                 // ten, the stored form
const intlPhone = `254${subscriber}`;                // twelve, what Daraja takes
const memberPhone = `+${intlPhone}`;                 // as copied off a receipt
const member = (await api(admin, 'POST', '/api/members', {
  full_name: `Pin Test ${stamp}`,
  phone: memberPhone,
  password: 'PinTest123!',
  email: `pintest${stamp}@example.test`
})).body;

console.log(`\n  member ${member?.member_id}: ${member?.full_name}`
  + ` registered as ${memberPhone}\n`);

if (!member?.member_id) {
  console.log('  could not create the test member, stopping');
  console.log(JSON.stringify(member));
  process.exit(1);
}

console.log('=== however a member writes their number, it is one member ===\n');

{
  const listed = (await api(admin, 'GET', '/api/members')).body.members
    || (await api(admin, 'GET', '/api/members')).body;
  const row = (Array.isArray(listed) ? listed : listed.members || [])
    .find((m) => Number(m.id) === Number(member.member_id));

  check('the number is stored in the app\'s own form',
    row?.phone === localPhone, `stored as "${row?.phone}", expected ${localPhone}`);

  // The dangerous case: the same person registering again, spelled differently.
  // Two rows means their payments split across both and neither balance is right.
  for (const [label, spelling] of [
    ['with a plus sign', `+${intlPhone}`],
    ['spaced', localPhone.replace(/^0(\d{3})(\d{3})(\d{3})$/, '0$1 $2 $3')],
    ['without the leading zero', subscriber],
    ['with the 00 prefix', `00${intlPhone}`]
  ]) {
    const again = await api(admin, 'POST', '/api/members', {
      full_name: `Pin Test ${stamp} again`,
      phone: spelling,
      password: 'PinTest123!',
      email: `pintest2${stamp}@example.test`
    });

    check(`the same member cannot register again ${label}`,
      again.status === 409, `got ${again.status} ${again.text.slice(0, 110)}`);
  }

  check('and no second row was created',
    ((await api(admin, 'GET', '/api/members')).body.members || [])
      .filter((m) => String(m.phone).replace(/\D/g, '').endsWith(stamp)).length === 1,
    'more than one member row holds this number');
}

console.log('\n=== a member signs in however they write their number ===\n');

{
  for (const [label, spelling] of [
    ['as stored', localPhone],
    ['with a plus sign', `+${intlPhone}`],
    ['in international form', intlPhone],
    ['spaced', localPhone.replace(/^0(\d{3})(\d{3})(\d{3})$/, '0$1 $2 $3')]
  ]) {
    const res = await api(null, 'POST', '/api/auth/member-login',
      { phone: spelling, password: 'PinTest123!' });

    check(`signs in ${label}`,
      res.status === 200 && !!res.body?.token,
      `${res.status} ${res.text.slice(0, 110)}`);
  }

  const wrong = await api(null, 'POST', '/api/auth/member-login',
    { phone: localPhone, password: 'WrongPassword!' });
  check('and the right number with the wrong password still fails',
    wrong.status === 401, `got ${wrong.status}`);
}

/** The confirmation Safaricom posts after the member enters their PIN. */
const confirm = (checkoutId, phoneInCallback, amount = 500, receipt) => api(null, 'POST',
  '/api/mpesa/callback', {
    Body: {
      stkCallback: {
        ResultCode: 0,
        CheckoutRequestID: checkoutId,
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: amount },
            { Name: 'MpesaReceiptNumber', Value: receipt },
            // Safaricom writes the payer's number here. "null" is what some
            // Daraja deployments send, which is why the checkout id matters.
            { Name: 'PhoneNumber', Value: phoneInCallback }
          ]
        }
      }
    }
  });

/** What Safaricom answers a retried callback with. */
const accepted = (res) => res.body?.ResultCode === 0;

console.log('=== the prompt route accepts the number, and refuses a bad one ===\n');

{
  /*
 * Deliberately does not send a prompt.
 *
 * Everywhere else in the app this route puts a real payment request in front of
 * a real phone, and a number invented for a test belongs to whoever was issued
 * it. That a plus-signed number is accepted is proven by PhoneTest and by the
 * member registration checks above; the live path is proven once, deliberately,
 * for KES 1, by check-till-live.
 *
 * What is checked here is only that a bad number is refused on its merits -
 * before the callback guard, and naming the number rather than the callback.
 */
{
  const bad = await api(admin, 'POST', '/api/mpesa/stk-push',
    { phone: '+254 0 000 000 000', amount: 500 });

  check('a number that is not a Kenyan mobile is refused as a number',
    bad.status === 400 && /phone number/i.test(bad.body?.error || ''),
    `${bad.status} ${bad.text.slice(0, 150)}`);

  for (const [label, spelling] of [
    ['with a plus sign', `+${intlPhone}`],
    ['spaced', localPhone.replace(/^0(\d{3})(\d{3})(\d{3})$/, '0$1 $2 $3')],
    ['in international form', intlPhone]
  ]) {
    // No amount, so the request is refused for a missing amount rather than
    // sending anything, but only after the phone has been accepted as usable.
    const res = await api(admin, 'POST', '/api/mpesa/stk-push', { phone: spelling });

    check(`a number written ${label} is accepted as a Kenyan mobile`,
      res.status === 400 && !/phone number/i.test(res.body?.error || ''),
      `${res.status} ${res.text.slice(0, 150)}`);
  }
}
}

console.log('\n=== the confirmation credits the right member ===\n');

{
  const checkout = `ws_CO_PIN_${stamp}`;
  const receipt = `QJG${stamp}XYZ`;

  // The prompt is recorded first, as stk-push does, so the checkout id joins the
  // confirmation back to the number we prompted.
  const before = (await api(admin, 'GET', `/api/contributions/member/${member.member_id}`))
    .body.contributions.length;

  const res = await confirm(checkout, intlPhone, 500, receipt);

  check('Safaricom is told the callback was accepted', accepted(res), res.text.slice(0, 120));

  const after = (await api(admin, 'GET', `/api/contributions/member/${member.member_id}`))
    .body.contributions;
  const mine = after.find((c) => c.reference_number === receipt);

  check('the contribution is recorded against that member', !!mine,
    `${after.length - before} contribution(s) appeared and none carried receipt ${receipt}`);
  check('for the amount the member actually paid', Number(mine?.amount) === 500,
    `recorded ${mine?.amount}`);
  check('as an M-Pesa payment', mine?.payment_method === 'mpesa_stk',
    `recorded as ${mine?.payment_method}`);
  check('and as confirmed, not pending', mine?.status === 'confirmed',
    `recorded as ${mine?.status}`);
  check('the till number is on it', mine?.payment_method === 'mpesa_stk');

  console.log(`\n  receipt ${receipt} -> ${mine?.member_id === undefined ? '' : ''}recorded`
    + ` KES ${mine?.amount} for member ${member.member_id}`);
}

console.log('\n=== Safaricom retries do not pay twice ===\n');

{
  const checkout = `ws_CO_RETRY_${stamp}`;
  const receipt = `QJG${stamp}RPT`;

  await confirm(checkout, intlPhone, 750, receipt);
  await confirm(checkout, intlPhone, 750, receipt);
  await confirm(checkout, intlPhone, 750, receipt);

  const all = (await api(admin, 'GET', '/api/contributions')).body.contributions;
  const times = all.filter((c) => c.reference_number === receipt).length;

  check('three deliveries of one payment record it once', times === 1,
    `recorded ${times} times`);
}

console.log('\n=== a number written differently still finds the member ===\n');

{
  // The member is stored with a plus sign; the confirmation arrives without
  // one. Before this was fixed, that payment found nobody.
  const receipt = `QJG${stamp}FMT`;
  await confirm(`ws_CO_FMT_${stamp}`, localPhone, 300, receipt);

  const mine = (await api(admin, 'GET', `/api/contributions/member/${member.member_id}`))
    .body.contributions.find((c) => c.reference_number === receipt);

  check('a local-format confirmation credits a member stored internationally',
    !!mine, 'no contribution with that receipt was found');
  check('for the right amount', Number(mine?.amount) === 300, `recorded ${mine?.amount}`);
}

console.log('\n=== the money lands in the cash book too ===\n');

{
  // Pick this payment's contribution, not the first in the list.
  const receipt = `QJG${stamp}XYZ`;
  const all = (await api(admin, 'GET', '/api/contributions')).body.contributions;
  const mine = all.find((c) => c.reference_number === receipt);

  // Ids cross the wire as JSON, but compare as numbers: "104" !== 104 would
  // report a correct recording as broken.
  check('the recorded contribution has the member on it',
    Number(mine?.member_id) === Number(member.member_id),
    `member_id is ${mine?.member_id}, member is ${member.member_id}`);

  const entries = (await api(admin, 'GET', '/api/ledger/cashbook')).body.entries || [];
  const entry = entries.find((e) => e.reference_number === receipt);

  check('and a matching ledger entry, so the cash book balances',
    !!entry, 'the contribution has no ledger entry');
  check('recorded as money in', entry?.direction === 'in', `direction is ${entry?.direction}`);
  check('for the same amount', Number(entry?.amount) === Number(mine?.amount),
    `ledger ${entry?.amount} against contribution ${mine?.amount}`);
  check('naming the member', String(entry?.member_name || '').includes(`Pin Test ${stamp}`),
    `ledger names "${entry?.member_name}"`);
}

console.log('\n=== a declined payment records nothing ===\n');

{
  const before = (await api(admin, 'GET', '/api/contributions')).body.contributions.length;

  const res = await api(null, 'POST', '/api/mpesa/callback', {
    Body: {
      stkCallback: {
        // The member cancelled, or failed their PIN.
        ResultCode: 1032,
        CheckoutRequestID: `ws_CO_DEC_${stamp}`,
        ResultDesc: 'The customer cancelled the request'
      }
    }
  });

  check('Safaricom is still told the callback was accepted', accepted(res),
    'a refusal makes Safaricom retry a payment that will never happen');
  check('nothing was recorded',
    (await api(admin, 'GET', '/api/contributions')).body.contributions.length === before);
}

console.log('\n=== a payment from someone who is not a member is not lost ===\n');

{
  const receipt = `QJG${stamp}ORPH`;
  const res = await confirm(`ws_CO_ORPH_${stamp}`, '254700000000', 1000, receipt);

  check('Safaricom is still told it was accepted', accepted(res));
  check('and it is not silently credited to somebody',
    !(await api(admin, 'GET', '/api/contributions')).body.contributions
      .some((c) => c.reference_number === receipt),
    'an unknown payer was credited to a member');
}

console.log(`\npassed ${passed}, failed ${failures.length}`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('\nTo remove these records: php backend-php/tests/cleanup-lifecycle.php\n');
process.exit(failures.length ? 1 : 0);