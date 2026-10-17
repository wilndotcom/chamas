#!/usr/bin/env node

/**
 * Proves the first-sign-in password rule actually holds.
 *
 * Administrator accounts start on one shared password that is written into the
 * published repository, so that getting in the first time needs no generated
 * string read off a screen. That is only safe while it expires, and "expires" has
 * to mean something a caller cannot talk their way around: it is not enough for
 * the interface to ask, because the interface is the part an attacker is free to
 * ignore.
 *
 * So this signs in the way a script would - straight at the API, no browser - and
 * asserts the account gets nothing until it has chosen its own password.
 *
 * It works on the shared administrator account, and it puts it back exactly as it
 * found it: the password hash and the flag are read straight out of the database
 * before anything is touched, and written back at the end, whatever happened in
 * between. An interrupted run would otherwise leave the operator locked out of
 * their own install with no obvious cause.
 *
 * Run:  node check-first-login.mjs
 *
 * Requires the PHP copy to be running: PHP_BASE, default http://localhost:5050
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADMIN_PASSWORD } from './admin-credential.mjs';

const BASE = process.env.PHP_BASE || 'http://localhost:5050';
const IDENTIFIER = process.env.CHECK_IDENTIFIER || 'admin';

let passed = 0;
let failed = 0;
const failures = [];

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

/* ------------------------------------------------------------------ the database

 * Read directly rather than through the API, because the API is the thing under
 * test: a snapshot taken through it could only report what the code believes, and
 * putting a password back is not something any endpoint should be able to do.
 */

function readEnvFile() {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', '.env');
  const out = {};

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) {
      out[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }

  return out;
}

const env = readEnvFile();
const MYSQL = process.env.MYSQL_EXE || 'C:\\xampp\\mysql\\bin\\mysql.exe';

function sql(statement) {
  const args = ['-u', env.DB_USER || 'root', `--host=${env.DB_HOST || 'localhost'}`];
  if (env.DB_PASSWORD) args.push(`-p${env.DB_PASSWORD}`);
  args.push('--batch', '--skip-column-names', env.DB_NAME || 'the_team_chama', '-e', statement);

  return execFileSync(MYSQL, args, { encoding: 'utf8' }).trim();
}

/**
 * The state to put back, and the promise to put it back.
 *
 * Held at module scope rather than passed around, because the case that matters
 * is not the tidy one: a thrown error or an interrupt still has to restore the
 * account, and a handler that only runs on the happy path is not a safety net.
 */
let restore = null;

function snapshot() {
  const [row] = sql(
    `SELECT password_hash, must_change_password FROM admins WHERE username = '${IDENTIFIER}'`
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));

  if (!row || !row[0]) {
    throw new Error(`no administrator named ${IDENTIFIER} in the database`);
  }

  const [hash, flagged] = row;
  const flag = String(flagged) === '1' ? 1 : 0;

  const apply = () =>
    sql(
      `UPDATE admins SET password_hash = '${hash}', must_change_password = ${flag} ` +
        `WHERE username = '${IDENTIFIER}'`
    );

  restore = apply;
  process.on('exit', () => {
    // Only still set when the tidy restore has not run - see the finally below.
    if (restore) {
      try {
        restore();
        console.error('  note: the administrator account was restored on exit');
      } catch (error) {
        console.error(`  WARNING: could not restore the administrator account: ${error.message}`);
        console.error(
          `  UPDATE admins SET password_hash = '${hash}', must_change_password = ${flag} ` +
            `WHERE username = '${IDENTIFIER}';`
        );
      }
    }
  });

  return { hash, flag };
}

/* ------------------------------------------------------------------ requests */

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not every response is JSON */
  }

  return { status: res.status, text, json };
}

const login = (password) =>
  call('POST', '/api/auth/admin-login', { body: { identifier: IDENTIFIER, password } });

/* ------------------------------------------------------------------ the run */

console.log('\n=== first sign-in password rule ===');

let snapshotTaken = false;

try {
  const original = snapshot();
  snapshotTaken = true;

  console.log(`\n  account: ${IDENTIFIER}`);
  console.log(`  started ${original.flag ? 'flagged (waiting for a change)' : 'in normal use'}`);

  // Put the account into the state under test. Flagging alone is enough: the
  // password is already the shared starting one, which is the situation the rule
  // exists for.
  sql(`UPDATE admins SET must_change_password = 1 WHERE username = '${IDENTIFIER}'`);

  console.log('\n=== signing in on the starting password ===');

  const first = await login(ADMIN_PASSWORD);

  check('the starting password still signs in', first.status === 200, `status ${first.status}`);
  check(
    'the login says a change is required',
    first.json?.admin?.must_change_password === true,
    `got ${JSON.stringify(first.json?.admin?.must_change_password)}`
  );

  const token = first.json?.token;

  console.log('\n=== what the account may reach ===');

  const profile = await call('GET', '/api/auth/profile', { token });
  check('its own profile is allowed', profile.status === 200, `status ${profile.status}`);
  check(
    'the profile carries the requirement too, so a reload keeps it',
    profile.json?.admin?.must_change_password === true,
    `got ${JSON.stringify(profile.json?.admin?.must_change_password)}`
  );

  const language = await call('GET', '/api/me/language', { token });
  check('the language preference is allowed', language.status === 200, `status ${language.status}`);

  // The point of the whole thing: a real endpoint, reached the way a script would
  // reach it, with a valid token for a real administrator.
  const blocked = await call('GET', '/api/members', { token });
  check('the member list is refused', blocked.status === 403, `status ${blocked.status}`);
  check(
    'the refusal says why',
    blocked.text.includes('Your password must be changed before you can continue.'),
    blocked.text.slice(0, 120)
  );

  const blockedWrite = await call('POST', '/api/mpesa/stk-push', {
    token,
    body: { phone: '0712345678', amount: 1 }
  });
  check(
    'so is asking for money',
    blockedWrite.status === 403,
    `status ${blockedWrite.status}`
  );

  console.log('\n=== the change itself ===');

  const wrong = await call('PUT', '/api/auth/change-password', {
    token,
    body: { current_password: 'definitely-not-it', new_password: 'a-good-new-password' }
  });
  check('a wrong current password is refused', wrong.status === 401, `status ${wrong.status}`);
  check(
    'with the wording the interface maps',
    wrong.text.includes('Current password is incorrect.'),
    wrong.text.slice(0, 120)
  );

  const same = await call('PUT', '/api/auth/change-password', {
    token,
    body: { current_password: ADMIN_PASSWORD, new_password: ADMIN_PASSWORD }
  });
  check('reusing the same password is refused', same.status === 400, `status ${same.status}`);
  check(
    'and says why, rather than silently accepting it',
    same.text.includes('The new password must be different from your current one.'),
    same.text.slice(0, 120)
  );

  const short = await call('PUT', '/api/auth/change-password', {
    token,
    body: { current_password: ADMIN_PASSWORD, new_password: 'short' }
  });
  check('a short new password is refused', short.status === 400, `status ${short.status}`);

  const temporary = `check-first-login-${Date.now().toString(36)}-Aa1`;

  const changed = await call('PUT', '/api/auth/change-password', {
    token,
    body: { current_password: ADMIN_PASSWORD, new_password: temporary }
  });
  check('choosing a real password is accepted', changed.status === 200, `status ${changed.status}`);
  check(
    'and reports the requirement as cleared',
    changed.json?.must_change_password === false,
    `got ${JSON.stringify(changed.json?.must_change_password)}`
  );

  console.log('\n=== afterwards, it is an ordinary account ===');

  const second = await login(temporary);
  check('the new password signs in', second.status === 200, `status ${second.status}`);
  check(
    'with nothing left to change',
    second.json?.admin?.must_change_password === false,
    `got ${JSON.stringify(second.json?.admin?.must_change_password)}`
  );

  const nowAllowed = await call('GET', '/api/members', { token: second.json?.token });
  check('the member list opens', nowAllowed.status === 200, `status ${nowAllowed.status}`);

  const stale = await login(ADMIN_PASSWORD);
  check('the password it was created with no longer works', stale.status === 401, `status ${stale.status}`);
} catch (error) {
  failed++;
  failures.push(`could not run: ${error.message}`);
  console.log(`  FAIL  the check could not run: ${error.message}`);
  if (error.message.includes('ENOENT')) {
    console.log(`        Looked for the mysql client at ${MYSQL}. Set MYSQL_EXE to override.`);
  }
} finally {
  if (snapshotTaken && restore) {
    try {
      restore();
      restore = null;
      console.log('\n  the administrator account was put back as it was found');
    } catch (error) {
      console.log(`\n  WARNING: could not restore the administrator account: ${error.message}`);
      console.log('  Run: php tests/reset-admin-passwords.php --apply');
    }
  }
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
