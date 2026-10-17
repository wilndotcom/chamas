/**
 * Changes the till number and proves an STK prompt still works.
 *
 * Also clears any callback saved by an earlier install so the deployed copy
 * falls back to the address it is reached on. Run:
 *   node backend-php/check-till-live.mjs
 */

import { ADMIN_PASSWORD } from './admin-credential.mjs';

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

import { snapshotConfig, restoreConfig } from './config-guard.mjs';

const admin = (await api(null, 'POST', '/api/auth/admin-login',
  { identifier: 'admin', password: ADMIN_PASSWORD })).body?.token;

/*
 * Clears the callback on purpose, to prove the app works one out for itself.
 *
 * That means this suite leaves the live app with nothing saved unless it puts
 * it back - unconditionally, on every way out. A run without a tunnel to hand
 * must not be allowed to leave the group unable to take a payment.
 */
const saved = await snapshotConfig(api, admin);

const before = (await api(admin, 'GET', '/api/mpesa/status')).body;
console.log(`\n  in use now: till ${before.values.shortcode}, callback ${before.callback_url}`);

await api(admin, 'PUT', '/api/settings', { values: { mpesa_callback_url: '' } });

const cleared = (await api(admin, 'GET', '/api/mpesa/status')).body;
console.log(`  worked out: till ${cleared.values.shortcode}, callback ${cleared.callback_url}`
  + ` (${cleared.source.callbackUrl}, reachable ${cleared.callback_reachable})\n`);

if (!TUNNEL) {
  const problems = await restoreConfig(api, admin, saved,
    (p) => console.log(`  WARNING: ${p}`));
  console.log('  set TUNNEL_URL to test a live prompt; configuration restored');
  process.exit(problems.length ? 1 : 0);
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
  { identifier: 'admin', password: ADMIN_PASSWORD })).body?.token;

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

// The live app is put back before the verdict, so a failing run cannot leave
// the group without a confirmation address.
const problems = await restoreConfig(api, admin, saved, (p) => failures.push(p));

if (problems.length) {
  console.log('\n  the live configuration could not be fully restored:');
  for (const p of problems) console.log(`    ${p}`);
}

console.log(`\npassed ${7 - failures.length}, failed ${failures.length}`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);