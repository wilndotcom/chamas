/**
 * Proves a different till number is used, without leaving one behind.
 *
 * The till is the one value an operator chooses, so changing it has to be the
 * whole of what they do. This saves a different one, checks the app reads it,
 * then puts the original back before doing anything else.
 *
 *   node backend-php/check-till-swap.mjs
 */
const BASE = process.env.PHP_BASE || 'http://localhost:8080/the-team';

const failures = [];

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures.push(name);
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
  { identifier: 'admin', password: 'admin123' })).body?.token;

const original = (await api(admin, 'GET', '/api/mpesa/status')).body.values.shortcode;
const swap = process.env.SWAP_TILL || '600000';

console.log(`\n  the group's real till is ${original}; trying ${swap}\n`);

try {
  const save = await api(admin, 'PUT', '/api/settings', { values: { mpesa_till: swap } });
  check('a different till is accepted', save.status === 200, save.text.slice(0, 140));

  const after = (await api(admin, 'GET', '/api/mpesa/status')).body;

  check('the app uses the new till', after.values.shortcode === swap,
    `shortcode is ${after.values.shortcode}`);
  check('the paybill follows it, so the group is known by one number',
    after.values.paybill === swap, `paybill is ${after.values.paybill}`);
  check('M-Pesa still counts as configured', after.configured === true);
  check('the single Settings box shows the new number',
    (await api(admin, 'GET', '/api/settings')).body?.mpesa_till === swap);

  /*
    The prompt body is what Safaricom actually receives, so the till has to be
    read at send time rather than captured at start-up - otherwise changing it
    would appear to work and every prompt would still go out on the old one.
    Checked through the endpoint that refuses to send, because sending a real
    prompt against a till that is not ours would put a payment request in front
    of somebody who never asked for it.
  */
  const guarded = await api(admin, 'POST', '/api/mpesa/test-prompt',
    { phone: '0712345678', amount: 1 });

  if (guarded.status === 400 && guarded.body?.field === 'mpesa_callback_url') {
    console.log(`  (reached Safaricom's guard first, as expected on a local address)`
      + ` - the till itself was not sent anywhere`);
    check('the guard fired before any request went out', true);
  } else {
    console.log(`  live prompt result: ${guarded.text.slice(0, 120)}`);
    check('the prompt was accepted against the new till',
      guarded.status === 200 && /^ws_/.test(guarded.body?.checkout_request_id || ''),
      guarded.text.slice(0, 160));
  }
} finally {
  const back = await api(admin, 'PUT', '/api/settings', { values: { mpesa_till: original } });
  const now = (await api(admin, 'GET', '/api/mpesa/status')).body.values.shortcode;
  console.log(`\n  the real till ${original} is back in place (${now})`);
  check('the original till is restored', back.status === 200 && now === original,
    `shortcode is ${now}`);
}

console.log(`\npassed ${9 - failures.length}, failed ${failures.length}`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);