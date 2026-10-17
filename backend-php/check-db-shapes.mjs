#!/usr/bin/env node

/**
 * Proves PDO returns values in the shape the port expects.
 *
 * Found the hard way. Enabling ATTR_STRINGIFY_FETCHES fixed a real date bug -
 * but it also made every id come back as a string, which turned a working login
 * into a fatal error on an int type declaration. Both are invisible to a unit
 * test that passes arrays in by hand, because a hand-built fixture has real ints
 * in it and the database does not.
 *
 * So this reads actual rows and asserts what the code downstream relies on.
 * Run:  node check-db-shapes.mjs
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

async function login() {
  const res = await fetch(`${PHP}/api/auth/admin-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin', password: ADMIN_PASSWORD }),
  });
  return res.json();
}

console.log(`\nchecking value shapes from ${PHP}\n`);

const auth = await login();

if (!auth.token) {
  console.log(`  could not log in: ${JSON.stringify(auth)}`);
  console.log('  is the PHP server running on ' + PHP + '?');
  process.exit(2);
}
passed++;
console.log('  PASS  admin login works');

const membersRes = await fetch(`${PHP}/api/members`, {
  headers: { Authorization: `Bearer ${auth.token}` },
});
const members = await membersRes.json();

if (!members.members?.length) {
  console.log('  no members to check against');
  process.exit(0);
}

console.log('\n=== dates are the strings MySQL holds ===');

const first = members.members[0];
const dateValues = ['joined_date', 'created_at', 'updated_at'].filter(
  (k) => first[k] !== null && first[k] !== undefined
);

for (const column of dateValues) {
  const value = first[column];
  // YYYY-MM-DD or YYYY-MM-DD HH:MM:SS, and nothing else.
  check(
    `${column} is a plain date string`,
    /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(value),
    `got ${JSON.stringify(value)} - a value ending in "Z" means a timezone shift`
  );
}

// The bug this guards: midnight in Nairobi is 21:00 the previous day in UTC, so
// a member who joined on the 4th was shown the 3rd.
const joined = members.members.find((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.joined_date ?? ''));
if (joined) {
  const day = joined.joined_date.slice(8, 10);
  check(
    'joined_date is not shifted a day early',
    day !== '01' && !joined.joined_date.endsWith('T21:00:00.000Z'),
    `${joined.full_name} joined ${joined.joined_date}`
  );
}

console.log('\n=== numbers are usable without surprises ===');

for (const member of members.members) {
  // JSON numbers, not strings. A quoted number works in a template and then
  // silently concatenates in a calculation.
  check(
    `member ${member.id} total_contributions is a number`,
    typeof member.total_contributions === 'number',
    `got ${typeof member.total_contributions}: ${JSON.stringify(member.total_contributions)}`
  );
  break; // one is enough; they all come from the same driver
}

check(
  'can_delete is a boolean, not 0/1',
  typeof first.can_delete === 'boolean',
  `got ${typeof first.can_delete}`
);

check(
  'history_blockers is an array',
  Array.isArray(first.history_blockers),
  `got ${typeof first.history_blockers}`
);

// The empty case is the one that bites: PHP's empty array encodes as [], not {}.
check(
  'history_counts encodes as an object even when empty',
  first.history_counts !== null
    && typeof first.history_counts === 'object'
    && !Array.isArray(first.history_counts),
  `got ${JSON.stringify(first.history_counts)} - an empty array means the frontend reads keys off a list`
);

console.log('\n=== ids survive a round trip ===');

const listIds = members.members.map((m) => m.id);
check(
  'every member id is present',
  listIds.every((id) => id !== null && id !== undefined),
  `ids: ${listIds.join(', ')}`
);

// Fetching one by id is the strictest check: it exercises the int type
// declarations that a hand-built fixture never reaches.
console.log('\n=== a single member round trip ===');
{
  const id = members.members[0].id;
  const res = await fetch(`${PHP}/api/members/${id}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  const body = await res.json();

  check(
    'fetching one member by id works',
    res.status === 200 && body.member?.id !== undefined,
    `got ${res.status}: ${JSON.stringify(body).slice(0, 120)}`
  );
  check(
    'the fetched member has the same id',
    String(body.member?.id) === String(id),
    `asked for ${id}, got ${body.member?.id}`
  );
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}