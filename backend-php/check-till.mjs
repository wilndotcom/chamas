/**
 * Proves the M-Pesa settings are now one till number.
 *
 * Run against the PHP server: node backend-php/check-till.mjs
 */
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

const login = await api(null, 'POST', '/api/auth/admin-login',
  { identifier: 'admin', password: 'admin123' });
const admin = login.body?.token;

console.log('\n=== the form is one number ===\n');

{
  const res = await api(admin, 'GET', '/api/settings');

  check('settings load', res.status === 200);
  check('the till is presented as one value', typeof res.body?.mpesa_till === 'string',
    `got ${JSON.stringify(res.body?.mpesa_till)}`);
  check('the current till is shown', /^\d{5,10}$/.test(res.body?.mpesa_till || ''),
    `got "${res.body?.mpesa_till}"`);

  const keys = (res.body?.settings || []).map((s) => s.setting_key);
  check('the stored rows are unchanged underneath', keys.includes('mpesa_shortcode')
    && keys.includes('mpesa_paybill'), 'the two stored keys should still exist');
}

console.log('\n=== a mistyped till is refused here, not by Safaricom ===\n');

{
  const before = (await api(admin, 'GET', '/api/mpesa/status')).body.values.shortcode;

  for (const [what, value] of [
    ['letters in it', 'PAYBILL'],
    ['too short', '123'],
    ['too long', '1234567890123'],
    ['empty', '']
  ]) {
    const res = await api(admin, 'PUT', '/api/settings', { values: { mpesa_till: value } });
    check(`refuses ${what}`, res.status === 400 && /till or shortcode/i.test(res.body?.error || ''),
      `${res.status} ${res.text.slice(0, 110)}`);
  }

  const after = (await api(admin, 'GET', '/api/mpesa/status')).body.values.shortcode;
  check('a refused till leaves the working one alone', before === after,
    `was ${before}, now ${after}`);
}

console.log('\n=== a valid till writes both stored settings together ===\n');

{
  const real = (await api(admin, 'GET', '/api/settings')).body?.mpesa_till;

  try {
    // Deliberately different from the group's real number: writing the real one
    // back afterwards would be a no-op and prove nothing.
    const spaces = '4005 931';

    const res = await api(admin, 'PUT', '/api/settings', { values: { mpesa_till: spaces } });
    check('a till typed with a space is accepted', res.status === 200, res.text.slice(0, 140));

    const st = (await api(admin, 'GET', '/api/mpesa/status')).body;
    check('the spaces are stripped', st.values.shortcode === '4005931',
      `got "${st.values.shortcode}"`);
    check('the paybill follows the shortcode', st.values.paybill === st.values.shortcode,
      `shortcode ${st.values.shortcode}, paybill ${st.values.paybill}`);

    const form = await api(admin, 'GET', '/api/settings');
    check('and the single box shows it back', form.body?.mpesa_till === '4005931',
      `got "${form.body?.mpesa_till}"`);
  } finally {
    /*
      * Put the group's real till back.
      *
      * This block used to leave 4005931 saved whatever the group had chosen,
      * which silently undid a till change and cost a live prompt while it was
      * being investigated. A test that writes real configuration has to restore
      * it, on every path out including a failure.
      */
    if (real) {
      const back = await api(admin, 'PUT', '/api/settings', { values: { mpesa_till: real } });
      const now = (await api(admin, 'GET', '/api/settings')).body?.mpesa_till;

      check("the group's own till is put back", back.status === 200 && now === real,
        `till is now ${now}, was ${real}`);
    }
  }
}

console.log('\n=== the callback is worked out, not typed ===\n');

{
  const real = (await api(admin, 'GET', '/api/mpesa/status')).body;

  try {
    // Clear any callback saved by an earlier install, so this exercises the path
    // an operator is actually on: they never set one at all.
    await api(admin, 'PUT', '/api/settings', { values: { mpesa_callback_url: '' } });

    const st = (await api(admin, 'GET', '/api/mpesa/status')).body;

    check('with nothing saved, the callback is worked out from this address',
      st.callback_url === `${BASE}/api/mpesa/callback`, `got "${st.callback_url}"`);
    check('and it says where it came from', st.source.callbackUrl === 'this server',
      `source is "${st.source.callbackUrl}"`);

    // localhost is not reachable by Safaricom, and saying so is the whole point
    // of deriving the URL: the operator finds out before a member's money moves.
    const derivedIsLocal = BASE.includes('localhost') || BASE.includes('127.0.0.1');
    check('a localhost callback is correctly reported as unreachable to Safaricom',
      st.callback_reachable === !derivedIsLocal,
      `derived "${st.callback_url}", reachable ${st.callback_reachable}`);

    /*
      * A stand-in left behind by an earlier install must not win over the
      * address the app can actually be reached on - otherwise the app tells
      * Safaricom to post somewhere that cannot exist.
      */
    await api(admin, 'PUT', '/api/settings',
      { values: { mpesa_callback_url: 'https://your-domain.com/api/mpesa/callback' } });

    const stale = (await api(admin, 'GET', '/api/mpesa/status')).body;
    check('a placeholder saved earlier does not override the derived address',
      stale.callback_url === `${BASE}/api/mpesa/callback`, `got "${stale.callback_url}"`);
  } finally {
    // Only put back a callback that was genuinely deliverable. Restoring a
    // localhost one would leave the next run with a value Safaricom cannot use.
    if (real.callback_reachable && real.callback_url) {
      await api(admin, 'PUT', '/api/settings', { values: { mpesa_callback_url: real.callback_url } });
    }
  }
}

console.log(`\npassed ${passed}, failed ${failures.length}`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);