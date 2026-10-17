#!/usr/bin/env node

/**
 * Compares the PHP port against the behaviour the Node version guarantees.
 *
 * Every case states the expected status and the exact text expected, because a
 * checker that only prints the response tells you nothing when it regresses.
 * The error strings are the ones the React frontend branches on, so a "helpful"
 * reword in the PHP port would break the portal with no obvious cause - which is
 * exactly the failure this file exists to catch.
 *
 * Run:  node check.mjs
 */

import { ADMIN_PASSWORD } from './admin-credential.mjs';


const BASE = process.env.PHP_BASE || 'http://localhost:5050';

let passed = 0;
let failed = 0;
const failures = [];

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
  return { status: res.status, text, json };
}

async function check(name, expectedStatus, expectedText, method, path, opts) {
  let result;
  try {
    result = await call(method, path, opts);
  } catch (error) {
    failed++;
    failures.push(`${name}: could not reach the server (${error.message})`);
    console.log(`  FAIL  ${name.padEnd(44)} no response`);
    return null;
  }

  const statusOk = result.status === expectedStatus;
  const textOk = !expectedText || result.text.includes(expectedText);

  if (statusOk && textOk) {
    passed++;
    console.log(`  PASS  ${name.padEnd(44)} ${result.status}`);
    return result;
  }

  failed++;
  const why = [];
  if (!statusOk) why.push(`status ${result.status}, wanted ${expectedStatus}`);
  if (!textOk) why.push(`text missing: ${JSON.stringify(expectedText)}`);
  failures.push(`${name}: ${why.join('; ')}`);
  console.log(`  FAIL  ${name.padEnd(44)} ${why.join('; ')}`);
  console.log(`        body: ${result.text.slice(0, 170)}`);
  return result;
}

/*
 * A preflight, because of what a flagged account does to the suites around this
 * one.
 *
 * The shared administrator account starts on a password that is written into the
 * published repository, and is refused everywhere except the change of password
 * until it has been replaced. This file survives that on its own - it signs in
 * and reads a profile, both allowed - but every suite that touches a real
 * endpoint fails at once, with "Your password must be changed before you can
 * continue.". Read on its own that looks like sixteen broken features rather
 * than one account waiting for its owner, so it is detected here and named.
 *
 * This is the file the other suites are run from, so it is where the answer is
 * worth printing.
 */
async function adminIsWaitingForPasswordChange() {
  try {
    const res = await fetch(`${BASE}/api/auth/admin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'admin', password: ADMIN_PASSWORD }),
    });

    if (res.status !== 200) return false;

    const body = await res.json();
    return body?.admin?.must_change_password === true;
  } catch {
    // An unreachable server is the next check's problem, not this one's.
    return false;
  }
}

if (await adminIsWaitingForPasswordChange()) {
  console.log('\nThe administrator account is waiting for its first sign-in password change.');
  console.log('Nothing else will answer until that is done, so the checks cannot run yet.\n');
  console.log('  php tests/reset-admin-passwords.php --apply --unblock   # to run them');
  console.log('  php tests/reset-admin-passwords.php --apply            # to ask again after\n');
  process.exit(1);
}

console.log('\n=== health ===');
await check('health reports ok', 200, '"status":"ok"', 'GET', '/api/health');
await check('health lists mounted and pending', 200, '"pending"', 'GET', '/api/health');

console.log('\n=== admin login: messages must match Node exactly ===');
await check('wrong password', 401, 'Invalid username/email or password.', 'POST',
  '/api/auth/admin-login', { body: { identifier: 'admin', password: 'wrongpass' } });
await check('unknown user is same message', 401, 'Invalid username/email or password.', 'POST',
  '/api/auth/admin-login', { body: { identifier: 'nosuchuser', password: 'whatever' } });
await check('missing fields', 400, 'Enter your username or email', 'POST',
  '/api/auth/admin-login', { body: {} });

const login = await check('correct password', 200, '"success":true', 'POST',
  '/api/auth/admin-login', { body: { identifier: 'admin', password: ADMIN_PASSWORD } });

console.log('\n=== admin login accepts username OR email ===');
// Uses the address the login response actually reported rather than a hardcoded
// guess. Which email an account has is data, not behaviour; what the port owes
// us is that either identifier signs in.
const adminEmail = login?.json?.admin?.email;
if (adminEmail) {
  await check('login by email address', 200, '"success":true', 'POST',
    '/api/auth/admin-login', { body: { identifier: adminEmail, password: ADMIN_PASSWORD } });
} else {
  console.log('  SKIP  email login (login response carried no email)');
}

console.log('\n=== login response carries what the frontend needs ===');
if (login?.json) {
  const admin = login.json.admin;
  const has = admin && admin.id && admin.full_name && admin.role && Array.isArray(admin.permissions);
  if (has) { passed++; console.log('  PASS  login returns id, name, role, permissions'); }
  else {
    failed++;
    failures.push('login response missing fields the frontend reads');
    console.log('  FAIL  login returns id, name, role, permissions');
    console.log(`        got: ${JSON.stringify(admin)}`);
  }
}

console.log('\n=== tokens ===');
const token = login?.json?.token;
if (token) {
  await check('valid token accepted', 200, '"admin"', 'GET', '/api/auth/profile', { token });
  await check('garbage token rejected', 401, 'Invalid or expired token', 'GET',
    '/api/auth/profile', { token: 'not.a.real.token' });
  await check('no token rejected', 401, 'No token provided', 'GET', '/api/auth/profile');

  // A token with an edited payload is rejected on its signature, which is the
  // right answer but proves nothing about the admin/member type boundary - that
  // check happens after the signature passes, and needs a properly signed member
  // token. It lives in check-token-types.mjs, which logs in as a real member.
} else {
  console.log('  SKIP  token tests (login returned no token)');
  failures.push('login returned no token, so token handling is unverified');
}

console.log('\n=== routing ===');
// Nothing is pending any more, so /api/health must say so. The pending list is
// kept in the response rather than removed: it is the one thing that shows a
// future change left part of the port undone, and dropping it would take that
// signal with it.
{
  const res = await fetch(`${BASE}/api/health`);
  const body = await res.json();

  const pending = body.port?.pending ?? [];
  const mounted = body.port?.mounted ?? [];

  // check() above takes an HTTP request; these are plain assertions, so they are
  // made directly rather than through it.
  if (Array.isArray(body.port?.pending) && pending.length === 0) {
    passed++;
    console.log(`  PASS  ${'health reports the port as complete'.padEnd(44)} ${mounted.length} groups`);
  } else {
    failed++;
    failures.push(`port is incomplete: ${pending.join(', ')}`);
    console.log(`  FAIL  ${'health reports the port as complete'.padEnd(44)} pending: ${pending.join(', ')}`);
  }

  if (mounted.length >= 18) {
    passed++;
    console.log(`  PASS  ${'every endpoint group is mounted'.padEnd(44)} ${mounted.length}`);
  } else {
    failed++;
    failures.push(`only ${mounted.length} groups mounted`);
    console.log(`  FAIL  ${'every endpoint group is mounted'.padEnd(44)} only ${mounted.length}`);
  }
}
await check('unknown api GET is 404 JSON', 404, 'Route not found', 'GET', '/api/nonexistent-thing');
await check('unknown api POST is 404, not a misleading 405', 404, 'Route not found',
  'POST', '/api/nonexistent-thing', { body: {} });

console.log('\n=== body parsing matches Express ===');
// Express's json() parser rejects a malformed body with a 400 before the route
// runs. Asserting the status rather than the wording, since the two parsers name
// the problem differently and the frontend only branches on the status.
const malformed = await fetch(`${BASE}/api/auth/admin-login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{ this is not json',
});
const malformedText = await malformed.text();
if (malformed.status === 400) {
  passed++;
  console.log(`  PASS  ${'malformed JSON body is 400'.padEnd(44)} 400`);
} else {
  failed++;
  failures.push(`malformed JSON body returned ${malformed.status}, wanted 400`);
  console.log(`  FAIL  ${'malformed JSON body is 400'.padEnd(44)} ${malformed.status}`);
  console.log(`        body: ${malformedText.slice(0, 160)}`);
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}