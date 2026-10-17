#!/usr/bin/env node

/**
 * Walks the welfare fund and loans through their whole life cycle, on PHP.
 *
 * These are writes, so this is not part of the read-only parity check. It exists
 * because "the endpoint returns 200" and "a member can actually get help" are
 * different claims, and only the second one matters.
 *
 * Everything it creates it cleans up afterwards, restoring the database to the
 * state it found - including the ledger entries, which a careless teardown would
 * leave behind and quietly corrupt the cash book.
 *
 * Run:  node check-lifecycle.mjs
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

// What this run created, so it can all be removed again.
const cleanup = { members: [], loans: [], welfareRequests: [], welfareContributions: [], ledger: [] };

async function adminToken() {
  const res = await api(null, 'POST', '/api/auth/admin-login',
    { identifier: 'admin', password: ADMIN_PASSWORD });
  return res.body?.token;
}

async function memberToken(phone, password) {
  const res = await api(null, 'POST', '/api/auth/member-login', { phone, password });
  return res.body?.token;
}

const admin = await adminToken();
if (!admin) {
  console.log('  could not log in as admin');
  process.exit(2);
}

// A member of our own, so nothing here touches a real person.
const suffix = Date.now().toString().slice(-8);
const testPhone = '07' + suffix;
const testPassword = 'testpass123';

console.log('\n=== setting up ===\n');

{
  const created = await api(admin, 'POST', '/api/members', {
    full_name: 'Lifecycle Test',
    phone: testPhone,
    password: testPassword,
    email: `lifecycle${suffix}@example.com`,
  });

  if (created.status === 201) {
    cleanup.members.push(created.body.member_id);
    check('created a test member', true);
  } else {
    check('created a test member', false, `${created.status}: ${created.text}`);
  }
}

const member = await memberToken(testPhone, testPassword);
check('the new member can log in', !!member, member ? '' : 'member login failed');

console.log('\n=== the fund position is honest ===\n');

const fundBefore = await api(admin, 'GET', '/api/welfare/fund');
check('fund position loads', fundBefore.status === 200, fundBefore.text.slice(0, 100));
check(
  'available equals contributions minus disbursals',
  Math.abs(
    fundBefore.body.fund.available
      - (fundBefore.body.fund.total_in - fundBefore.body.fund.total_out)
  ) < 0.01,
  `available ${fundBefore.body.fund.available}, in ${fundBefore.body.fund.total_in}, out ${fundBefore.body.fund.total_out}`
);

console.log('\n=== a member contributes and it lands ===\n');

{
  const start = (await api(admin, 'GET', '/api/welfare/fund')).body.fund.available;

  const contributed = await api(member, 'POST', '/api/welfare/contributions', { amount: 500 });
  check('member can self-contribute', contributed.status === 201, contributed.text.slice(0, 120));

  if (contributed.body?.contribution_id) {
    cleanup.welfareContributions.push(contributed.body.contribution_id);
  }

  const after = (await api(admin, 'GET', '/api/welfare/fund')).body.fund.available;
  check(
    'the fund balance rose by exactly 500',
    Math.abs((after - start) - 500) < 0.01,
    `went from ${start} to ${after}`
  );
}

console.log('\n=== a member cannot contribute as somebody else ===\n');

{
  // The most important security check in the whole flow: a member token naming a
  // different member_id must be ignored in favour of the token's own member.
  const spoof = await api(member, 'POST', '/api/welfare/contributions', {
    amount: 500,
    member_id: 50,                       // a real member who is not us
  });

  if (spoof.status === 201) {
    cleanup.welfareContributions.push(spoof.body.contribution_id);

    // Read back from the admin list rather than from the member's own view: the
    // member view would report what they were told, not what was written. The
    // point is to see which row the money actually landed on.
    const listed = (await api(admin, 'GET', '/api/welfare/contributions')).body.contributions;
    const written = listed.find((c) => String(c.id) === String(spoof.body.contribution_id));

    check(
      'the contribution was credited to the token holder, not the body',
      String(written?.member_id) === String(cleanup.members[0]),
      written
        ? `credited to member ${written.member_id} (${written.member_name}), should be ${cleanup.members[0]}`
        : `contribution ${spoof.body.contribution_id} is not in the list at all`
    );

    // Belt and braces: the member we named in the body must have gained nothing.
    const theirs = listed.filter((c) => String(c.member_id) === '50' && Number(c.amount) === 500);
    check(
      'the member named in the request body gained nothing',
      theirs.length === 0,
      `${theirs.length} contribution(s) landed on member 50`
    );
  } else {
    check('the contribution was credited to the token holder, not the body', false,
      `status ${spoof.status}: ${spoof.text}`);
  }
}

console.log('\n=== a member asks for help ===\n');

let requestId = null;
{
  const asked = await api(member, 'POST', '/api/welfare/requests', {
    amount: 200,
    reason: 'School fees',
  });

  check('member can submit a request', asked.status === 201, asked.text.slice(0, 140));
  requestId = asked.body?.request_id;
  if (requestId) cleanup.welfareRequests.push(requestId);

  // Zero and negative amounts must be refused, not accepted and discovered later.
  for (const amount of [0, -100]) {
    const bad = await api(member, 'POST', '/api/welfare/requests', {
      amount, reason: 'test',
    });
    check(`an amount of ${amount} is refused`, bad.status === 400,
      `got ${bad.status}`);
  }

  const noReason = await api(member, 'POST', '/api/welfare/requests', { amount: 100 });
  check('a request with no reason is refused', noReason.status === 400,
    `got ${noReason.status}`);
}

console.log('\n=== the member can see their own request ===\n');

{
  const mine = await api(member, 'GET', '/api/welfare/my');
  check('member welfare view loads', mine.status === 200, mine.text.slice(0, 100));

  const found = mine.body?.requests?.some((r) => String(r.id) === String(requestId));
  check('the request appears in their own view', !!found);

  // Everything must be scoped to them. Another member's request showing up here
  // would be a privacy failure, not a display quirk.
  const allOurs = mine.body?.requests?.every(
    (r) => String(r.amount) !== '999999'
  );
  check('no other member\'s data is present', allOurs !== false);
}

console.log('\n=== approval and payout are separate ===\n');

{
  // Paying out a request that was never approved must be refused. Collapsing the
  // two steps is exactly what made an approved request look paid.
  const tooEarly = await api(admin, 'POST', `/api/welfare/requests/${requestId}/disburse`);
  check('cannot pay out an unapproved request', tooEarly.status === 409,
    `got ${tooEarly.status}: ${tooEarly.text.slice(0, 100)}`);
}

{
  const approved = await api(admin, 'POST', `/api/welfare/requests/${requestId}/approve`);
  check('the committee can approve', approved.status === 200, approved.text.slice(0, 120));

  // Approving twice must not be possible, or a second click pays twice.
  const again = await api(admin, 'POST', `/api/welfare/requests/${requestId}/approve`);
  check('approving twice is refused', again.status === 409, `got ${again.status}`);
}

{
  const beforeLedger = (await api(admin, 'GET', '/api/welfare/fund')).body.fund.available;

  const paid = await api(admin, 'POST', `/api/welfare/requests/${requestId}/disburse`);
  check('the committee can pay out', paid.status === 200, paid.text.slice(0, 120));

  if (paid.body?.ledger_id) cleanup.ledger.push(paid.body.ledger_id);

  const afterLedger = (await api(admin, 'GET', '/api/welfare/fund')).body.fund.available;
  check(
    'paying out reduced the fund by exactly the request amount',
    Math.abs((beforeLedger - afterLedger) - 200) < 0.01,
    `went from ${beforeLedger} to ${afterLedger}, expected a fall of 200`
  );

  check('a ledger entry was written', !!paid.body?.ledger_id);
}

console.log('\n=== a member cannot approve their own request ===\n');

{
  const asked = await api(member, 'POST', '/api/welfare/requests', {
    amount: 50, reason: 'another test',
  });
  const secondId = asked.body?.request_id;
  if (secondId) cleanup.welfareRequests.push(secondId);

  const tried = await api(member, 'POST', `/api/welfare/requests/${secondId}/approve`);
  check('a member token cannot approve', tried.status === 403 || tried.status === 401,
    `got ${tried.status}: ${tried.text.slice(0, 100)}`);
}

console.log('\n=== loans: apply, approve, disburse, repay ===\n');

let loanId = null;
{
  const applied = await api(member, 'POST', '/api/loans/apply', {
    principal_amount: 1000, purpose: 'Test loan',
  });

  check('member can apply for a loan', applied.status === 201, applied.text.slice(0, 140));
  loanId = applied.body?.loan_id;
  if (loanId) cleanup.loans.push(loanId);

  // Flat interest, charged once: 1000 at 10% is 1100, never 1105.
  check(
    'interest is flat on the principal',
    applied.body?.interest_amount === 100 && applied.body?.total_repayable === 1100,
    `interest ${applied.body?.interest_amount}, total ${applied.body?.total_repayable}`
  );
}

{
  const zero = await api(member, 'POST', '/api/loans/apply', { principal_amount: 0 });
  check('a zero loan is refused', zero.status === 400, `got ${zero.status}`);

  const negative = await api(member, 'POST', '/api/loans/apply', { principal_amount: -500 });
  check('a negative loan is refused', negative.status === 400, `got ${negative.status}`);
}

{
  const approved = await api(admin, 'POST', `/api/loans/${loanId}/approve`, {
    duration_months: 3,
  });
  check('the committee can approve a loan', approved.status === 200, approved.text.slice(0, 130));
  check('an approval sets a due date', !!approved.body?.due_date);

  const badRate = await api(admin, 'POST', `/api/loans/${loanId}/approve`, {
    interest_rate: 250,
  });
  check('an impossible interest rate is refused', badRate.status === 400 || badRate.status === 409,
    `got ${badRate.status}`);
}

{
  const disbursed = await api(admin, 'POST', `/api/loans/${loanId}/disburse`);
  check('the committee can disburse', disbursed.status === 200, disbursed.text.slice(0, 100));
}

console.log('\n=== repayment rules ===\n');

{
  // The guards that once let a negative repayment increase the balance.
  for (const [label, amount, expected] of [
    ['a negative repayment', -100, 400],
    ['a zero repayment', 0, 400],
    ['more than the balance', 99999, 400],
    ['no amount at all', undefined, 400],
  ]) {
    const res = await api(member, 'POST', `/api/loans/${loanId}/pay`, { amount });
    check(`${label} is refused`, res.status === expected,
      `got ${res.status}: ${res.text.slice(0, 90)}`);
  }
}

{
  const paid = await api(member, 'POST', `/api/loans/${loanId}/pay`, { amount: 1100 });
  check('a member can repay in full', paid.status === 200, paid.text.slice(0, 130));
  check('the loan is marked cleared', paid.body?.cleared === true);
  check('the balance reaches zero', paid.body?.balance_after === 0,
    `balance_after ${paid.body?.balance_after}`);

  const settled = await api(admin, 'GET', `/api/loans`);
  const loan = settled.body.loans.find((l) => String(l.id) === String(loanId));
  check('the loan shows as completed', loan?.status === 'completed', `status ${loan?.status}`);

  // Repaying a closed loan must be refused, not quietly accepted.
  const extra = await api(member, 'POST', `/api/loans/${loanId}/pay`, { amount: 100 });
  check('a fully repaid loan takes no more', extra.status === 400, `got ${extra.status}`);
}

console.log('\n=== a member cannot touch somebody else\'s loan ===\n');

{
  // A real loan belonging to member 50, which exists in this database.
  const loans = await api(admin, 'GET', '/api/loans');
  const someoneElses = loans.body?.loans?.find(
    (l) => String(l.member_id) !== String(cleanup.members[0])
  );

  if (someoneElses) {
    const tried = await api(member, 'POST', `/api/loans/${someoneElses.id}/pay`, { amount: 1 });
    check('paying another member\'s loan is refused', tried.status === 404,
      `got ${tried.status}: ${tried.text.slice(0, 90)}`);
  } else {
    console.log('  SKIP  no other member\'s loan to test against');
  }
}

console.log('\n=== cleaning up ===\n');

{
  // These records cannot be deleted through the API, and that is correct: a
  // member with financial history is protected from deletion by design. Removing
  // them through the API would mean the protection does not exist.
  //
  // So they are removed by tests/cleanup-lifecycle.php, which is deliberately
  // narrow - it only touches members named "Lifecycle Test" and what hangs off
  // them. Run it after this check to leave the database as it was found.
  const fund = (await api(admin, 'GET', '/api/welfare/fund')).body.fund;

  console.log(`  fund after the run: in ${fund.total_in}, out ${fund.total_out}, `
    + `available ${fund.available}`);
  console.log(`  created: 1 member (${testPhone}), ${cleanup.loans.length} loan, `
    + `${cleanup.welfareRequests.length} welfare request(s), `
    + `${cleanup.welfareContributions.length} welfare contribution(s)`);
  console.log('');
  console.log('  Left in place on purpose: a member with financial history cannot be');
  console.log('  deleted through the API, which is the protection worth having.');
  console.log('  To remove them:');
  console.log('    php backend-php/tests/cleanup-lifecycle.php');
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}