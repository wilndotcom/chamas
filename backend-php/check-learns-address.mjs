/**
 * The app works it out for itself.
 *
 * Starts with no callback saved at all, which is how a fresh install looks. The
 * operator's normal browsing is at localhost, where the derived callback is
 * never deliverable. One visit through the public address has to be enough to
 * unstick it, and it has to keep working afterwards.
 *
 *   PUBLIC_URL=... node backend-php/check-learns-address.mjs
 */
const LOCAL = process.env.LOCAL_BASE || 'http://localhost:8080/the-team';
const PUBLIC = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const PHONE = process.env.TEST_PHONE;

if (!PUBLIC) {
  console.log('\n  set PUBLIC_URL to the tunnel or domain address\n');
  process.exit(1);
}

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
    { identifier: 'admin', password: 'admin123' })).body?.token;

const local = await login(LOCAL);
const public_ = await login(`${PUBLIC}/the-team`);

const real = await status();

/*
 * Everything this suite does to the live app, undone at the end whatever
 * happens - including the run where no tunnel is available and the app would
 * otherwise be left with nothing saved.
 */
const restore = async () => {
  if (real.callback_url) {
    await api(LOCAL, local, 'PUT', '/api/settings',
      { values: { mpesa_callback_url: real.callback_url } });
  }

  const now = (await status()).callback_url;
  check("the app's own confirmation address is put back", now === real.callback_url,
    `now "${now}", was "${real.callback_url}"`);
};

console.log(`\n  browsing at    : ${LOCAL}`);
console.log(`  public address : ${PUBLIC}\n`);

console.log('=== starting from nothing ===\n');

// A fresh install: no callback saved, so the app has to work one out.
await api(LOCAL, local, 'PUT', '/api/settings', { values: { mpesa_callback_url: '' } });

const fresh = (await api(LOCAL, local, 'GET', '/api/mpesa/status')).body;
check('with nothing saved, browsing at localhost is refused, as it must be',
  fresh.callback_reachable === false,
  `callback "${fresh.callback_url}" was called reachable`);

console.log('\n=== one visit through the public address ===\n');

// Whatever the operator does there, the address should be learned.
await api(`${PUBLIC}/the-team`, public_, 'GET', '/api/mpesa/status');

const learned = (await api(LOCAL, local, 'GET', '/api/mpesa/status')).body;

check('the app has remembered the public address',
  learned.callback_url === `${PUBLIC}/the-team/api/mpesa/callback`,
  `callback is "${learned.callback_url}"`);
check('and knows Safaricom can reach it', learned.callback_reachable === true);
check('the till is untouched by any of this', /^\d{5,10}$/.test(learned.values?.shortcode || ''),
  `shortcode is "${learned.values?.shortcode}"`);

console.log('\n=== and localhost works afterwards ===\n');

if (!PHONE) {
  await restore();
  console.log('  set TEST_PHONE to also send a real prompt');
  console.log(`\npassed ${5 - failures.length}, failed ${failures.length}`);
  process.exit(failures.length ? 1 : 0);
}

const res = await api(LOCAL, local, 'POST', '/api/mpesa/test-prompt',
  { phone: PHONE, amount: Number(process.env.TEST_AMOUNT || 1) });

const sent = res.status === 200 && /^ws_/.test(res.body?.checkout_request_id || '');

check('a prompt sent from localhost is now accepted', sent,
  `${res.status} ${res.text.slice(0, 180)}`);

if (sent) {
  console.log(`\n  checkout : ${res.body.checkout_request_id}`);
  console.log(`  Safaricom: ${res.body.customer_message}`);
}

await restore();

console.log(`\npassed ${6 - failures.length}, failed ${failures.length}`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);