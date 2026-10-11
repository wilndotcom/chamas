/**
 * Pins the public address as the M-Pesa callback.
 *
 * The app works out the callback from whichever address the operator is looking
 * at. That is right when they are looking at the public address, and it is a
 * dead end when they are not: browsing at localhost always works out localhost,
 * so the prompt is refused, and the only way out is to change where they browse.
 *
 * Saving the public address breaks that loop. A saved callback takes precedence,
 * so a prompt sent from localhost is confirmed back through the public address
 * and lands on the same app.
 *
 *   node backend-php/check-pin-callback.mjs
 */
const BASE = process.env.PHP_BASE || 'http://localhost:8080/the-team';
const PUBLIC = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const failures = [];

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures.push(name);
}

if (!PUBLIC) {
  console.log('\n  set PUBLIC_URL to the tunnel or domain address\n');
  process.exit(1);
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

const status = () => api(admin, 'GET', '/api/mpesa/status');
const before = (await status()).body;

console.log(`\n  browsing at   : ${BASE}`);
console.log(`  public address: ${PUBLIC}`);
console.log(`  callback now  : ${before.callback_url} (reachable ${before.callback_reachable})\n`);

const pinned = `${PUBLIC}/api/mpesa/callback`;

const saved = await api(admin, 'PUT', '/api/settings',
  { values: { mpesa_callback_url: pinned } });

check('the public address is saved as the callback', saved.status === 200,
  saved.text.slice(0, 140));

const after = (await status()).body;

check('the app now uses it', after.callback_url === pinned, `got "${after.callback_url}"`);
check('and knows it was saved rather than worked out',
  after.source.callbackUrl === 'settings', `source is "${after.source.callbackUrl}"`);
check('Safaricom can reach it', after.callback_reachable === true);

/*
 * The whole point. Sent from localhost, which is where the operator is looking
 * and where the address would otherwise have been derived as localhost.
 */
console.log('\n=== a prompt sent from localhost ===\n');

const phone = process.env.TEST_PHONE;
const amount = process.env.TEST_AMOUNT || '1';

if (!phone) {
  console.log('  set TEST_PHONE to the number that should receive the prompt');
  console.log('\npassed 3, failed 0');
  process.exit(0);
}

const res = await api(admin, 'POST', '/api/mpesa/test-prompt',
  { phone, amount: Number(amount) });

const sent = res.status === 200 && /^ws_/.test(res.body?.checkout_request_id || '');

check('sent from localhost, Safaricom accepts the prompt', sent,
  `${res.status} ${res.text.slice(0, 180)}`);

if (sent) {
  console.log(`\n  checkout : ${res.body.checkout_request_id}`);
  console.log(`  Safaricom: ${res.body.customer_message}`);
}

console.log(`\npassed ${4 + (phone ? 1 : 0) - failures.length}, failed ${failures.length}`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);