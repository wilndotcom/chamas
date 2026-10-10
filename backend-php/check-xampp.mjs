#!/usr/bin/env node

/**
 * Checks the installed XAMPP copy behaves correctly.
 *
 * Point it at the running server:
 *     node check-xampp.mjs                      (defaults to localhost/the-team)
 *     PHP_BASE=http://localhost:8080 node check-xampp.mjs
 *
 * The most important checks are the last group. An install that serves the app
 * but hands out its .env is worse than one that does not install at all: the
 * file contains the database password and the signing secret, and anyone who
 * reads the secret can sign a token for any administrator.
 */

const BASE = (process.env.PHP_BASE || 'http://localhost/the-team').replace(/\/$/, '');

let passed = 0;
let failed = 0;
const failures = [];

async function probe(path, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = raw ? '' : await res.text();
  let json = null;
  if (!raw) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
  return { status: res.status, text, json, type: res.headers.get('content-type') || '' };
}

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ' - ' + detail : ''}`);
    console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`);
  }
}

console.log(`\nchecking ${BASE}\n`);

console.log('=== the app is served ===');
{
  const root = await probe('/');
  check('app root returns the app', root.status === 200 && root.text.includes('<div id="root"') || root.text.includes('<!doctype html'),
    `got ${root.status}, looks like ${root.text.includes('Welcome to XAMPP') ? 'the XAMPP page' : 'something else'}`);

  // A deep link has no file behind it, so the rewrite must send it to
  // index.html. If this 404s, every shared or bookmarked link is broken.
  const admin = await probe('/admin');
  check('deep link /admin works', admin.status === 200,
    `got ${admin.status} - refresh on any app page would fail`);

  const member = await probe('/member');
  check('deep link /member works', member.status === 200, `got ${member.status}`);
}

console.log('\n=== assets resolve under the prefix ===');
{
  const root = await probe('/');
  // Absolute /assets/... would load from another app on the same server, and
  // the page would come up blank with no error worth reading.
  const absolute = root.text.match(/(?:src|href)="\/assets\//);
  check('assets are not absolute', !absolute,
    absolute ? 'assets point at /assets/ and will resolve to another app' : '');

  const asset = root.text.match(/(?:src|href)="(?:\/the-team\/|\.\/)?(assets\/[^"]+\.js)"/);
  if (asset) {
    const res = await probe('/' + asset[1]);
    check('a hashed asset loads', res.status === 200, `${asset[1]} returned ${res.status}`);
  } else {
    check('a hashed asset loads', false, 'no asset reference found in index.html');
  }
}

console.log('\n=== the API answers JSON, not HTML ===');
{
  const health = await probe('/api/health');
  check('health returns JSON', health.status === 200 && health.json !== null,
    `got ${health.status} ${health.type} - if this is text/html the rewrite rule is wrong`);

  if (health.json) {
    check('health reports what is ported',
      Array.isArray(health.json.port?.mounted) && Array.isArray(health.json.port?.pending),
      'no port status - cannot tell a finished port from a partial one');
    if (health.json.port?.pending?.length) {
      console.log(`        mounted: ${health.json.port.mounted.join(', ') || '(none)'}`);
      console.log(`        pending: ${health.json.port.pending.length} groups`);
    }
  }
}

console.log('\n=== it still logs in ===');
{
  const login = await probe('/api/auth/admin-login', {
    method: 'POST', body: { identifier: 'admin', password: 'admin123' },
  });

  check('admin login works', login.status === 200 && login.json?.token,
    `got ${login.status}: ${(login.json?.error || login.text).slice(0, 100)}`);

  if (login.json?.token) {
    const profile = await probe('/api/auth/profile', { token: login.json.token });
    check('the token works on the next request', profile.status === 200,
      `got ${profile.status}`);
  }
}

console.log('\n=== secrets must NOT be readable ===');
{
  // These are the checks that matter most. A served .env exposes the database
  // password and JWT_SECRET, and anyone holding the secret can mint a token for
  // any administrator - which is not a compromise of one account but of all.
  const guarded = [
    ['/backend/.env', 'the database password and signing secret'],
    ['/backend/composer.json', 'dependency detail'],
    ['/backend/app/Auth.php', 'the source of the authentication code'],
    ['/backend/app/Database.php', 'the source of the database layer'],
    ['/backend/routes/api.php', 'the route table'],
    ['/backend/vendor/autoload.php', 'the dependency autoloader'],
  ];

  for (const [path, what] of guarded) {
    const res = await probe(path);
    const leaked = res.status === 200 && !res.text.trimStart().startsWith('<');
    // 403 and 404 are both fine: 403 from a deny rule, 404 from the rewrite
    // never reaching it. Only 200 with readable content is a leak.
    check(`blocked: ${path}`, res.status !== 200 || res.text.includes('<!doctype'),
      res.status === 200 && !res.text.trimStart().startsWith('<')
        ? `served ${what} as plain text`
        : '');
  }
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}