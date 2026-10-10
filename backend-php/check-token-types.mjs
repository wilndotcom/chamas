#!/usr/bin/env node

/**
 * Checks the token type boundary with a genuinely issued member token.
 *
 * The earlier check forged one by editing the payload, which is answered at the
 * signature - correctly, but it proves nothing about the type check. This logs
 * in as a real member so the token is properly signed and the 403 comes from
 * where it should.
 */
const BASE = process.env.PHP_BASE || 'http://localhost:5050';

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not always JSON */ }
  return { status: res.status, text, json };
}

const phone = process.env.MEMBER_PHONE;
const password = process.env.MEMBER_PASSWORD;

if (!phone || !password) {
  console.log('Set MEMBER_PHONE and MEMBER_PASSWORD to run this check.');
  console.log('It needs a real member login so the token is properly signed - a');
  console.log('forged token is rejected on its signature and never reaches the');
  console.log('type check, so it cannot demonstrate that boundary.');
  process.exit(2);
}

const login = await call('POST', '/api/auth/member-login', { body: { phone, password } });

if (login.status !== 200) {
  console.log(`member login failed: ${login.status} ${login.text}`);
  console.log('Wrong credentials, or the member is not active.');
  process.exit(1);
}

const memberToken = login.json.token;
console.log(`  logged in as member: ${login.json.member.full_name}`);

// A member token against an admin route must be refused by type, not accepted.
const onAdminRoute = await call('GET', '/api/auth/profile', { token: memberToken });
if (onAdminRoute.status === 403) {
  console.log(`  PASS  member token refused on admin route      403  ${onAdminRoute.text}`);
} else {
  console.log(`  FAIL  member token on admin route got ${onAdminRoute.status}, wanted 403`);
  console.log(`        ${onAdminRoute.text}`);
  process.exit(1);
}

// And it must still work on a member route.
const onMemberRoute = await call('GET', '/api/auth/member-profile', { token: memberToken });
if (onMemberRoute.status === 200) {
  console.log(`  PASS  member token accepted on member route   200`);
} else {
  console.log(`  FAIL  member token on member route got ${onMemberRoute.status}, wanted 200`);
  console.log(`        ${onMemberRoute.text}`);
  process.exit(1);
}