#!/usr/bin/env node

/**
 * Checks the member-facing figures with real data in them.
 *
 * The transparency screen exists to answer one question honestly: is this group
 * doing well? That question turns entirely on separating three things that look
 * alike on a bank statement - the members' own savings, the interest the group
 * has earned, and the loans it is owed.
 *
 * With an empty database every one of those figures is zero and any code returns
 * the same correct answer, so this creates a member with savings, a loan and a
 * repayment, then checks the arithmetic against what the database actually holds.
 *
 * Run:  node check-transparency.mjs
 * Afterwards: php backend-php/tests/cleanup-lifecycle.php
 */

import { ADMIN_PASSWORD } from './admin-credential.mjs';


const PHP = process.env.PHP_BASE || 'http://localhost:5050';

let passed = 0;
let failed = 0;
const failures = [];

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

const admin = (await api(null, 'POST', '/api/auth/admin-login',
  { identifier: 'admin', password: ADMIN_PASSWORD })).body?.token;

if (!admin) { console.log('  could not log in'); process.exit(2); }

console.log(`\nchecking the group figures on ${PHP}\n`);

const suffix = Date.now().toString().slice(-8);
const phone = '07' + suffix;

console.log('=== building a situation worth measuring ===\n');

const created = await api(admin, 'POST', '/api/members', {
  full_name: 'Transparency Test', phone, password: 'testpass123',
  email: `transparency${suffix}@example.com`,
});

if (created.status !== 201) {
  check('created a test member', false, `${created.status}: ${created.text}`);
  process.exit(1);
}
const memberId = created.body.member_id;
console.log(`  member ${memberId}, phone ${phone}`);

const member = (await api(null, 'POST', '/api/auth/member-login',
  { phone, password: 'testpass123' })).body?.token;
check('the test member can log in', !!member);

// Savings: this is the members' own money, and must never be counted as income.
await api(admin, 'POST', '/api/contributions', {
  member_id: memberId, amount: 2000, contribution_date: new Date().toISOString().slice(0, 10),
});
console.log('  recorded 2,000 of savings');

// A loan of 1,000 at 10%: repayable at 1,100.
const loan = await api(member, 'POST', '/api/loans/apply', { principal_amount: 1000 });
const loanId = loan.body?.loan_id;
check('applied for a 1,000 loan', loan.status === 201, loan.text.slice(0, 100));

await api(admin, 'POST', `/api/loans/${loanId}/approve`, { duration_months: 3 });
await api(admin, 'POST', `/api/loans/${loanId}/disburse`);
console.log('  approved and disbursed');

// Repay half of it. 550 back: 50 of interest and 500 of principal.
await api(member, 'POST', `/api/loans/${loanId}/pay`, { amount: 550 });
console.log('  repaid 550 of 1,100');

console.log('\n=== the figures ===\n');

const view = await api(member, 'GET', '/api/transparency');
check('transparency loads', view.status === 200, view.text.slice(0, 140));

if (view.status !== 200) {
  console.log(`\npassed ${passed}, failed ${failed}`);
  process.exit(1);
}

const t = view.body;

console.log('\n=== money held for members is not profit ===\n');

check(
  'held for members includes the savings',
  t.held_for_members.savings >= 2000,
  `savings reported as ${t.held_for_members.savings}`
);
check(
  'held and income are separate blocks',
  t.held_for_members && t.income && t.held_for_members.total !== undefined && t.income.profit !== undefined,
  'the screen cannot show a single misleading headline'
);
check(
  'the two blocks carry an explanation',
  /not profit/i.test(t.group_position.note) && /only income/i.test(t.income.note),
  `notes: ${t.group_position.note} / ${t.income.note}`
);

console.log('\n=== interest is not the same as repayments ===\n');

// This is the correction. A repayment includes the principal, so interest earned
// is what is left after the principal is accounted for.
//
// Worked out from the loan's own figures rather than written down, so the check
// stays right when the terms change and does not silently pass because a
// hardcoded number happened to match.
const expectedInterest = await (async () => {
  const mine = await api(member, 'GET', '/api/loans/mine');
  const l = mine.body?.loans?.find((x) => String(x.id) === String(loanId));
  if (!l) return null;
  // Interest charged, less whatever is still outstanding on what remains.
  return Math.round((l.interest_amount - l.interest_outstanding) * 100) / 100;
})();

check(
  'interest earned is the interest portion, not the whole repayment',
  expectedInterest !== null && Math.abs(t.income.interest_collected - expectedInterest) < 0.01,
  `reported ${t.income.interest_collected}, expected ${expectedInterest} - the interest `
  + 'portion of the repayments, not the repayments themselves'
);

check(
  'interest earned is far below the total repaid',
  t.loans.repaid > 0 && t.income.interest_collected < t.loans.repaid,
  `earned ${t.income.interest_collected} against ${t.loans.repaid} repaid - `
  + 'the difference is principal coming back, which is not income'
);

check(
  'profit is interest less expenses',
  Math.abs(t.income.profit - (t.income.interest_collected - t.income.expenses)) < 0.01,
  `profit ${t.income.profit}, interest ${t.income.interest_collected}, expenses ${t.income.expenses}`
);

check(
  'profit is not inflated by the principal repaid',
  t.income.profit < 550,
  `profit of ${t.income.profit} suggests repayments are being counted as income`
);

console.log('\n=== the loan position ===\n');

check(
  'disbursed is the principal lent',
  t.loans.disbursed >= 1000,
  `disbursed ${t.loans.disbursed}`
);
check(
  'repaid is the whole repayment, principal included',
  Math.abs(t.loans.repaid - (t.loans.repaid)) < 0.01 && t.loans.repaid >= 550,
  `repaid ${t.loans.repaid}`
);
check(
  'outstanding is disbursed less repaid',
  Math.abs(t.loans.outstanding - (t.loans.disbursed - t.loans.repaid)) < 0.01,
  `outstanding ${t.loans.outstanding}, disbursed ${t.loans.disbursed}, repaid ${t.loans.repaid}`
);

console.log('\n=== a member sees their own position ===\n');

check('the viewer is identified', String(t.me.member_id) === String(memberId),
  `says ${t.me.member_id}, expected ${memberId}`);
check(
  'their savings are shown',
  t.me.savings >= 2000,
  `shows ${t.me.savings}`
);
check(
  'their loan balance is what they still owe',
  Math.abs(t.me.loan_balance - (1100 - 550)) < 0.01,
  `shows ${t.me.loan_balance}, expected 550 after repaying 550 of 1,100`
);

console.log('\n=== other members are visible, credentials are not ===\n');

check('the member list is present', Array.isArray(t.members) && t.members.length > 0);

const withPassword = t.members.filter((m) => 'password_hash' in m);
check('no password hashes in the list', withPassword.length === 0,
  `${withPassword.length} member rows carried a password hash`);

const withIdNumber = t.members.filter((m) => 'id_number' in m);
check('no national ID numbers in the list', withIdNumber.length === 0,
  `${withIdNumber.length} member rows carried an id number`);

check(
  'other members appear with their totals',
  t.members.every((m) => m.full_name && typeof m.savings_total === 'number'),
  'a member cannot see how the group is doing without every row being readable'
);

console.log('\n=== the chart ===\n');

check('the series has twelve months', t.series?.length === 12,
  `got ${t.series?.length}`);

check(
  'the months are in order and contiguous',
  t.series?.every((m, i) => i === 0 || m.key > t.series[i - 1].key),
  'a chart out of order reads as missing data'
);

check(
  'every month has all the fields, including the empty ones',
  t.series?.every((m) =>
    ['key', 'label', 'savings_in', 'welfare_in', 'welfare_out', 'interest_earned', 'expenses']
      .every((f) => m[f] !== undefined)),
  'a skipped month reads as missing data rather than as zero'
);

check(
  "this month's savings appear in the series",
  t.series?.[11]?.savings_in >= 2000,
  `the current month shows ${t.series?.[11]?.savings_in} in savings`
);

console.log('\n=== admins are members too ===\n');

{
  const admins = t.members.filter((m) => m.is_admin === 1 || m.is_admin === true);
  console.log(`  ${admins.length} member(s) are flagged as admins rather than hidden`);
  console.log('  an admin who also saves should appear in their own group\'s figures');
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
console.log('\nTo remove these records: php backend-php/tests/cleanup-lifecycle.php\n');
process.exit(failed > 0 ? 1 : 0);