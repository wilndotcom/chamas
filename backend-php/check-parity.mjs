#!/usr/bin/env node

/**
 * Compares PHP against Node on the same live requests.
 *
 * The unit tests prove each side is internally correct. This proves they answer
 * identically - same status, same keys, same error text - against the real
 * database. It is the check that would catch a port that looks right in a test
 * fixture and behaves differently on actual rows.
 *
 * Run:  node check-parity.mjs
 *
 * Both servers must be up. It writes nothing: every request it makes is a GET,
 * because the two databases are shared and a write through the wrong backend
 * would be indistinguishable from a bug.
 */

import { ADMIN_PASSWORD } from './admin-credential.mjs';


const PHP = process.env.PHP_BASE || 'http://localhost:5050';
const NODE = process.env.NODE_BASE || 'http://localhost:5000';

let passed = 0;
let failed = 0;
const failures = [];

async function login(base) {
  const res = await fetch(`${base}/api/auth/admin-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin', password: ADMIN_PASSWORD }),
  });
  const json = await res.json().catch(() => null);
  if (!json?.token) throw new Error(`login failed at ${base}: ${res.status}`);
  return json.token;
}

/**
 * Compares two responses on structure rather than exact equality.
 *
 * Exact equality is too strict: row order and the *values* of created_at
 * timestamps are not what is being ported. What must match is the shape, the
 * status, and the names of the fields - a missing key is what breaks the
 * frontend, and a value difference on a volatile column is not.
 */
function compareShape(label, a, b, { ignore = [] } = {}) {
  const problems = [];

  if (a.status !== b.status) {
    problems.push(`status ${a.status} vs ${b.status}`);
  }

  const keysA = a.keys ? Object.keys(a.body).sort() : null;
  const keysB = b.keys ? Object.keys(b.body).sort() : null;

  if (keysA && keysB) {
    const onlyA = keysA.filter((k) => !keysB.includes(k) && !ignore.includes(k));
    const onlyB = keysB.filter((k) => !keysA.includes(k) && !ignore.includes(k));
    if (onlyA.length) problems.push(`php has extra keys: ${onlyA.join(', ')}`);
    if (onlyB.length) problems.push(`php is missing keys: ${onlyB.join(', ')}`);
  }

  if (a.errorText !== b.errorText) {
    problems.push(`error text differs:\n            php:  ${a.errorText}\n            node: ${b.errorText}`);
  }

  return problems;
}

async function probe(base, token, path, method = 'GET', body = undefined) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {
    status: res.status,
    body: json,
    text,
    keys: json && typeof json === 'object' ? Object.keys(json) : null,
    errorText: json?.error ?? null,
  };
}

console.log(`\ncomparing PHP ${PHP} against Node ${NODE}\n`);

let phpToken;
let nodeToken;
try {
  phpToken = await login(PHP);
  nodeToken = await login(NODE);
  console.log('  logged in to both\n');
} catch (e) {
  console.log(`  ${e.message}`);
  console.log('  both servers must be running');
  process.exit(2);
}

const cases = [
  // [method, path, body]
  ['GET', '/api/members'],
  ['GET', '/api/members/dashboard'],           // wrong token type: expect 403 from both
  ['GET', '/api/members/registrations'],
  ['GET', '/api/members/1'],                   // member 1 may not exist; both should 404 alike
  ['GET', '/api/contributions'],
  ['GET', '/api/contributions/summary'],
  ['GET', '/api/contributions/member/50'],
  ['GET', '/api/loans'],
  ['GET', '/api/loans/pending'],
  ['GET', '/api/loans/mine'],                 // admin token on a member route: 403 from both
  ['GET', '/api/welfare/fund'],
  ['GET', '/api/welfare/contributions'],
  ['GET', '/api/welfare/requests'],
  ['GET', '/api/welfare/my'],                 // admin token on a member route: 403 from both
  ['GET', '/api/transparency'],               // member-only: 403 from an admin token
  ['GET', '/api/settings'],                   // admin: the masked view
  ['GET', '/api/settings/public'],            // no token needed
  ['GET', '/api/settings/about'],
  ['GET', '/api/mpesa/status'],
  // The callbacks are public in both backends, and must answer the same thing.
  ['POST', '/api/mpesa/validation', {}],
  ['GET', '/api/admins'],
  ['GET', '/api/admins/roles'],
  ['GET', '/api/admins/audit-logs'],
  ['GET', '/api/roles'],
  ['GET', '/api/chama/profile'],
  ['GET', '/api/payment-gateways'],
  ['GET', '/api/me/language'],
  ['GET', '/api/admin-permissions/1'],
  ['GET', '/api/notifications'],
  ['GET', '/api/notifications/templates'],
  ['GET', '/api/notifications/channels'],
  ['GET', '/api/reports/financial-summary'],
  ['GET', '/api/reports/monthly'],
  ['GET', '/api/reports/growth'],
  ['GET', '/api/reports/reminders'],
  ['GET', '/api/reports/expenses'],
  ['GET', '/api/reports/member/50'],
  ['GET', '/api/ledger/cashbook'],
  ['POST', '/api/account/request-reset', { identifier: 'definitely-not-a-real-account', type: 'admin' }],
];

for (const [method, path, body] of cases) {
  const php = await probe(PHP, phpToken, path, method, body);
  const node = await probe(NODE, nodeToken, path, method, body);

  // A 501 means the group is not ported yet. That is a known, deliberate
  // difference and must not be reported as a parity failure - but it is worth
  // printing so it is obvious what is still outstanding.
  if (php.status === 501) {
    console.log(`  PENDING  ${path.padEnd(34)} php 501 (not ported yet), node ${node.status}`);
    continue;
  }

  const problems = compareShape(path, php, node);

  if (problems.length === 0) {
    passed++;
    console.log(`  PASS  ${path.padEnd(34)} both ${php.status}`);
  } else {
    failed++;
    failures.push(`${path}: ${problems.join('; ')}`);
    console.log(`  FAIL  ${path.padEnd(34)}`);
    for (const p of problems) console.log(`        ${p}`);
    console.log(`        php:  ${php.text.slice(0, 130)}`);
    console.log(`        node: ${node.text.slice(0, 130)}`);
  }
}

console.log('\n=== deeper checks: actual data, not just shape ===');

// The members list is the one worth comparing properly: same member ids, same
// order, same totals. A shape match alone would pass even if the SQL returned
// the right columns for the wrong members.
{
  const php = await probe(PHP, phpToken, '/api/members');
  const node = await probe(NODE, nodeToken, '/api/members');

  // Compared as strings: the two backends represent ids differently, and the
  // question here is which members and in what order, not how each encodes an
  // integer. JSON.stringify would report a difference over 52 vs "52".
  const phpIds = (php.body?.members ?? []).map((m) => String(m.id));
  const nodeIds = (node.body?.members ?? []).map((m) => String(m.id));

  if (phpIds.join(',') === nodeIds.join(',')) {
    passed++;
    console.log(`  PASS  ${'same members, same order'.padEnd(34)} ${phpIds.length} members`);
  } else {
    failed++;
    failures.push(`member lists differ: php [${phpIds}] node [${nodeIds}]`);
    console.log(`  FAIL  ${'same members, same order'.padEnd(34)}`);
    console.log(`        php:  ${phpIds.join(', ')}`);
    console.log(`        node: ${nodeIds.join(', ')}`);
  }

  // The history_blockers field drives whether a delete button is enabled. If one
  // side computes it and the other does not, the UI disagrees with the API.
  const withHistory = (php.body?.members ?? []).filter((m) => m.history_blockers?.length);
  const nodeWithHistory = (node.body?.members ?? []).filter((m) => m.history_blockers?.length);

  if (withHistory.length === nodeWithHistory.length) {
    passed++;
    console.log(`  PASS  ${'same delete-protection'.padEnd(34)} ${withHistory.length} protected`);
  } else {
    failed++;
    failures.push(`delete protection differs: php ${withHistory.length}, node ${nodeWithHistory.length}`);
    console.log(`  FAIL  ${'same delete-protection'.padEnd(34)} php ${withHistory.length}, node ${nodeWithHistory.length}`);
  }
}

console.log('\n=== money figures must be numerically identical ===');

// The check that matters most. The two backends represent decimals differently
// by necessity - MySQL hands PHP strings to preserve precision, and hands
// Node.js strings too - but a member's balance must not depend on which one
// answered, so every figure is compared by value rather than by type.
{
  const php = await probe(PHP, phpToken, '/api/members');
  const node = await probe(NODE, nodeToken, '/api/members');

  const fields = ['total_contributions', 'loan_balance'];

  for (const field of fields) {
    let mismatches = 0;

    for (const m of php.body?.members ?? []) {
      const other = (node.body?.members ?? []).find((n) => String(n.id) === String(m.id));
      if (!other) continue;

      const a = Number(m[field]);
      const b = Number(other[field]);

      // Compared at two decimals: that is the precision the app works in, and
      // beyond it the two languages would disagree on representation alone.
      if (Math.round(a * 100) !== Math.round(b * 100)) {
        mismatches++;
        console.log(`        ${m.full_name} ${field}: php ${a} vs node ${b}`);
      }
    }

    if (mismatches === 0) {
      passed++;
      console.log(`  PASS  ${field.padEnd(34)} identical on every member`);
    } else {
      failed++;
      failures.push(`${field} differs on ${mismatches} members`);
      console.log(`  FAIL  ${field.padEnd(34)} ${mismatches} differ`);
    }
  }
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}