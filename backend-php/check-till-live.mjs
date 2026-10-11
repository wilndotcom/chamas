/**
 * Changes the till number and proves an STK prompt still works.
 *
 * Also clears any callback saved by an earlier install so the deployed copy
 * falls back to the address it is reached on. Run:
 *   node backend-php/check-till-live.mjs
 */
const BASE = process.env.PHP_BASE || 'http://localhost:8080/the-team';
const TUNNEL = process.env.TUNNEL_URL || '';

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

const before = (await api(admin, 'GET', '/api/mpesa/status')).body;
console.log(`\n  in use now: till ${before.values.shortcode}, callback ${before.callback_url}`);

// Clear the callback saved during earlier testing, so the app works it out.
await api(admin, 'PUT', '/api/settings', { values: { mpesa_callback_url: '' } });

const cleared = (await api(admin, 'GET', '/api/mpesa/status')).body;
console.log(`  worked out: till ${cleared.values.shortcode}, callback ${cleared.callback_url}`
  + ` (${cleared.source.callbackUrl}, reachable ${cleared.callback_reachable})\n`);

if (!TUNNEL) {
  console.log('  set TUNNEL_URL to test a live prompt; nothing else to check here');
  process.exit(0);
}

const via = async (path, body, token) => {
  const res = await fetch(`${TUNNEL}/the-team${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed, text };
};

const tun = (await via('/api/auth/admin-login',
  { identifier: 'admin', password: 'admin123' })).body?.token;

const remote = (await via('/api/mpesa/status', null, tun)).body;
console.log(`  reached over the tunnel, the app works out: ${remote.callback_url}`
  + ` (${remote.source.callbackUrl}, reachable ${remote.callback_reachable})\n`);

check('the callback follows the address the app is reached on',
  remote.callback_url === `${TUNNEL}/the-team/api/mpesa/callback`, `got "${remote.callback_url}"`);
check('and Safaricom can reach it', remote.callback_reachable === true);

console.log('\n=== the prompt that goes out uses that till ===\n');

const res = await via('/api/mpesa/test-prompt', { phone: '0712345678', amount: 1 }, tun);

check('Safaricom accepts a KES 1 prompt', res.status === 200 && !!res.body?.checkout_request_id,
  `${res.status} ${res.text.slice(0, 160)}`);
check('with a real checkout id from Safaricom',
  /^ws_/.test(res.body?.checkout_request_id || ''), res.body?.checkout_request_id);
check('and nothing was recorded', res.body?.recorded === false);
check('no Safaricom error', !res.body?.error && !res.body?.daraja_code, res.text.slice(0, 160));

console.log(`\n  checkout: ${res.body?.checkout_request_id}`);
console.log(`  till used: ${cleared.values.shortcode}`);

console.log(`\npassed ${7 - failures.length}, failed ${failures.length}`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);