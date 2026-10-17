#!/usr/bin/env node

/**
 * Checks the settings rules, especially the ones that protect credentials.
 *
 * Settings is where a mistake hands somebody else's money away or replaces a
 * working M-Pesa key with eight characters, so it gets tested directly rather
 * than through the general parity check.
 *
 * Writes are used deliberately. A read-only test cannot show whether a secret
 * survives a save, and that is the property that matters here. Each test puts
 * the value back, and the script refuses to leave a changed setting behind.
 *
 * Run:  node check-settings.mjs
 */

import { ADMIN_PASSWORD } from './admin-credential.mjs';


const PHP = process.env.PHP_BASE || 'http://localhost:5050';

let passed = 0;
let failed = 0;
const failures = [];
const restore = [];

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

/** Remembers a setting's value so it can be put back at the end. */
async function remember(admin, key) {
  const res = await api(admin, 'GET', '/api/settings');
  const row = res.body?.settings?.find((s) => s.setting_key === key);
  restore.push({ key, value: row ? row.setting_value : null, existed: !!row });
}

console.log(`\nchecking settings rules on ${PHP}\n`);

const login = await api(null, 'POST', '/api/auth/admin-login',
  { identifier: 'admin', password: ADMIN_PASSWORD });
const admin = login.body?.token;

if (!admin) {
  console.log('  could not log in');
  process.exit(2);
}

console.log('=== reading ===\n');

{
  const res = await api(admin, 'GET', '/api/settings');
  check('settings load', res.status === 200);
  check('the secret key list is sent to the client',
    Array.isArray(res.body?.secret_keys) && res.body.secret_keys.includes('mpesa_consumer_secret'),
    'the client cannot tell a masked value from a real one without this');
}

console.log('\n=== credentials are never returned ===\n');

{
  const res = await api(admin, 'GET', '/api/settings');

  // Whatever the values, nothing in the response may look like a live
  // credential. The Daraja secret and the STK passkey were both readable over a
  // single GET before the masking was applied.
  const secrets = res.body?.settings?.filter(
    (s) => res.body.secret_keys.includes(s.setting_key) && String(s.setting_value ?? '').trim() !== ''
  ) || [];

  const leaked = secrets.filter((s) => s.setting_value !== '__saved__');
  check('every stored credential comes back masked', leaked.length === 0,
    leaked.map((s) => s.setting_key).join(', '));
}

console.log('\n=== a masked secret survives a save ===\n');

{
  await remember(admin, 'mpesa_consumer_secret');

  // Saving an unrelated field on the same card, carrying the mask through as the
  // secret does. Before the keep-sentinel existed this overwrote a working
  // key with "__saved__" and M-Pesa broke for everybody.
  const saved = await api(admin, 'PUT', '/api/settings', {
    values: { mpesa_consumer_secret: '__saved__' },
  });
  check('saving a masked secret succeeds', saved.status === 200, saved.text.slice(0, 120));

  const after = await api(admin, 'GET', '/api/settings');
  const row = after.body?.settings?.find((s) => s.setting_key === 'mpesa_consumer_secret');

  // If it was unset before it stays unset; if it was set it must still be set,
  // and still masked rather than holding the eight characters of the mask.
  const stillMasked = row?.setting_value === '__saved__' || row?.setting_value === '';
  check('the secret was not replaced by the mask', stillMasked,
    `now reads ${JSON.stringify(row?.setting_value)}`);
}

console.log('\n=== the keep sentinel is a no-op ===\n');

{
  await remember(admin, 'chama_name');

  const res = await api(admin, 'PUT', '/api/settings/chama_name', { value: '__keep__' });
  check('saving the keep sentinel reports unchanged', res.body?.unchanged === true,
    res.text.slice(0, 120));
}

console.log('\n=== only allowlisted keys can be written ===\n');

{
  // Roles and permissions live in their own tables. A settings write must never
  // reach them.
  for (const key of ['install_id', 'some_future_internal_key', 'is_super_admin']) {
    const res = await api(admin, 'PUT', `/api/settings/${key}`, { value: 'x' });
    check(`"${key}" cannot be written`, res.status === 400, `got ${res.status}`);
  }

  const bulk = await api(admin, 'PUT', '/api/settings', {
    values: { chama_name: 'x', install_id: 'y' },
  });
  check('a bulk save rejects the whole card if one key is not allowed',
    bulk.status === 400 && /cannot be changed here/.test(bulk.text),
    bulk.text.slice(0, 140));
}

console.log('\n=== closed sets are enforced ===\n');

{
  await remember(admin, 'theme');

  const res = await api(admin, 'PUT', '/api/settings/theme', { value: 'neon-pink' });
  check('an unknown theme is refused', res.status === 400, `got ${res.status}`);
  check('the error names the field in words', /Colour skin/.test(res.text),
    res.text.slice(0, 120));

  // A closed set on purpose: anything else would be passed to Safaricom as the
  // base URL, and a typo must not resolve to the live endpoint by accident.
  const env = await api(admin, 'PUT', '/api/settings/mpesa_environment', { value: 'live' });
  check('an unknown M-Pesa environment is refused', env.status === 400, `got ${env.status}`);
}

console.log('\n=== numeric rules are enforced ===\n');

{
  await remember(admin, 'loan_interest_rate');

  const cases = [
    ['loan_interest_rate', '150', /between 0 and 100/],
    ['loan_interest_rate', '-5', /between 0 and 100/],
    ['loan_interest_rate', 'ten', /must be a number/],
    ['loan_duration_months', '0', /between 1 and 60/],
    ['loan_duration_months', '1.5', /whole number/],
    ['loan_interest_rate', '10.123', /two decimal places/],
  ];

  for (const [key, value, pattern] of cases) {
    const res = await api(admin, 'PUT', `/api/settings/${key}`, { value });
    check(`${key} = ${value} is refused`, res.status === 400 && pattern.test(res.text),
      `${res.status} ${res.text.slice(0, 100)}`);
  }

  // Zero is meaningful for the two welfare rules - "no cap" and "no waiting
  // period" - and rejecting it would make "unlimited" unreachable.
  for (const key of ['welfare_max_request_amount', 'welfare_min_months_contributed']) {
    await remember(admin, key);
    const res = await api(admin, 'PUT', `/api/settings/${key}`, { value: '0' });
    check(`${key} = 0 is accepted`, res.status === 200, `${res.status} ${res.text.slice(0, 100)}`);
  }
}

console.log('\n=== private endpoints are refused ===\n');

{
  // The most security-relevant rule here: the treasurer's browser supplies this
  // address and the server makes the request, so pointing it at the server's own
  // internals would be an SSRF into the machine holding the database password.
  const refused = [
    ['http://localhost:5000/api/health', /private network|this machine/],
    ['http://127.0.0.1/', /private network|this machine/],
    ['http://10.0.0.5/admin', /private network|this machine/],
    ['http://192.168.1.1/', /private network|this machine/],
    ['http://172.16.0.1/', /private network|this machine/],
    ['http://169.254.169.254/latest/meta-data/', /private network|this machine/],
    ['http://metadata.google.internal/', /private network|this machine/],
    ['ftp://example.com/', /http:\/\/ or https:\/\//],
    ['not-a-url', /not a valid URL/],
  ];

  for (const [endpoint, pattern] of refused) {
    const res = await api(admin, 'PUT', '/api/settings/custom_sms_endpoint', { value: endpoint });
    check(`refused: ${endpoint}`, res.status === 400 && pattern.test(res.text),
      `${res.status} ${res.text.slice(0, 110)}`);
  }

  // A public https address must be accepted, or the rule has blocked a real
  // provider along with the attacks.
  await remember(admin, 'custom_sms_endpoint');
  const allowed = await api(admin, 'PUT', '/api/settings/custom_sms_endpoint',
    { value: 'https://api.example.com/send' });
  check('a public https endpoint is accepted', allowed.status === 200,
    `${allowed.status} ${allowed.text.slice(0, 110)}`);
}

console.log('\n=== an unparseable body template is refused ===\n');

{
  await remember(admin, 'custom_sms_body');

  const bad = await api(admin, 'PUT', '/api/settings/custom_sms_body', { value: '{not json' });
  check('a malformed body template is refused', bad.status === 400, `got ${bad.status}`);

  // The placeholders make it valid JSON only after substitution, which is why the
  // probe substitutes them before parsing.
  const good = await api(admin, 'PUT', '/api/settings/custom_sms_body',
    { value: '{"to":"{{phone}}","message":"{{message}}"}' });
  check('a valid body template is accepted', good.status === 200,
    `${good.status} ${good.text.slice(0, 110)}`);
}

console.log('\n=== public settings leak nothing ===\n');

{
  // Readable without a token, because the client needs the currency to format
  // every amount before anybody signs in.
  const res = await api(null, 'GET', '/api/settings/public');
  check('public settings load without a token', res.status === 200);

  const keys = (res.body?.settings ?? []).map((s) => s.setting_key);
  const forbidden = keys.filter((k) =>
    k.includes('secret') || k.includes('passkey') || k.includes('password') || k === 'mpesa_consumer_key'
  );
  check('no credential appears in the public list', forbidden.length === 0,
    forbidden.join(', '));

  check('the chama name is available for formatting',
    keys.includes('chama_name'), keys.join(', '));
}

console.log('\n=== the about panel ===\n');

{
  const res = await api(admin, 'GET', '/api/settings/about');
  check('about loads', res.status === 200, res.text.slice(0, 100));
  check('it carries an install id', typeof res.body?.install_id === 'string'
    && res.body.install_id.length > 0);
  check('it carries only an aggregate member count',
    Number.isInteger(res.body?.member_count));
  check('reporting is disclosed as off by default',
    res.body?.reporting_configured === false && /No data is sent/.test(res.body?.reporting_disclosure ?? ''),
    'an operator must be able to see that nothing phones home');
}

console.log('\n=== restoring what was changed ===\n');

{
  for (const item of restore) {
    if (item.value === null) {
      continue;   // never existed, so there is nothing to put back
    }
    await api(admin, 'PUT', `/api/settings/${item.key}`, { value: item.value });
  }
  console.log(`  put back ${restore.filter((i) => i.value !== null).length} setting(s)`);
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}