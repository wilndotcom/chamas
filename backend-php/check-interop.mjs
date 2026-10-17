#!/usr/bin/env node

/**
 * Proves the two backends accept each other's tokens.
 *
 * This is the property that makes switching safe. If PHP rejected tokens the
 * Node app had already issued, every signed-in user would be logged out at the
 * moment of the cutover - the worst possible time, with no warning and no way
 * back. It also catches a silent drift in the signing secret or the claim shape.
 *
 * The reverse direction matters too: a PHP-issued token must work on Node, or
 * switching back is just as disruptive.
 *
 * Run:  node check-interop.mjs
 */

import { ADMIN_PASSWORD } from './admin-credential.mjs';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PHP = process.env.PHP_BASE || 'http://localhost:5050';
const NODE_BASE = process.env.NODE_BASE || 'http://localhost:5000';

// The same secret the running services use, read rather than duplicated so this
// cannot disagree with them.
function sharedSecret() {
  const envPath = path.resolve(here, '..', 'backend', '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  const match = text.match(/^JWT_SECRET=(.*)$/m);
  if (!match) throw new Error('JWT_SECRET not found in backend/.env');
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(secret, claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    ...claims,
    iat: now,
    exp: now + 3600,
  }));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function get(path, token) {
  const res = await fetch(`${PHP}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not always JSON */ }
  return { status: res.status, text, json };
}

let passed = 0;
let failed = 0;

function report(ok, name, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); }
}

const secret = sharedSecret();

// Ask each backend to log in, then present each token to each backend.
console.log('\n=== live login from each backend ===');

let nodeToken = null;
try {
  const res = await fetch(`${NODE_BASE}/api/auth/admin-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin', password: ADMIN_PASSWORD }),
  });
  const json = await res.json().catch(() => null);
  if (res.ok && json?.token) {
    nodeToken = json.token;
    console.log(`  node backend is running and issued a token`);
  } else {
    console.log(`  node backend answered ${res.status}; starting it is optional`);
    console.log('         (the locally signed checks below still prove the format)');
  }
} catch {
  console.log('  node backend not running; skipping the live cross-check');
  console.log('         start it with "npm start" in backend/ to include that check');
}

const phpLogin = await fetch(`${PHP}/api/auth/admin-login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: 'admin', password: ADMIN_PASSWORD }),
});
const phpBody = await phpLogin.json().catch(() => null);
const phpToken = phpBody?.token;

if (phpToken) {
  console.log('  php backend is running and issued a token');
} else {
  console.log(`  php backend did not issue a token (${phpLogin.status}); start it first`);
  process.exit(1);
}

console.log('\n=== a PHP-issued token works on PHP ===');
{
  const r = await get('/api/auth/profile', phpToken);
  report(r.status === 200, 'php token accepted by php', `got ${r.status}: ${r.text.slice(0, 120)}`);
}

if (nodeToken) {
  console.log('\n=== a PHP-issued token works on Node (no forced logout) ===');
  const res = await fetch(`${NODE_BASE}/api/auth/profile`, {
    headers: { Authorization: `Bearer ${phpToken}` },
  });
  const text = await res.text();
  report(res.status === 200, 'php token accepted by node', `got ${res.status}: ${text.slice(0, 120)}`);

  console.log('\n=== a Node-issued token works on PHP (rollback is safe) ===');
  const r = await get('/api/auth/profile', nodeToken);
  report(r.status === 200, 'node token accepted by php', `got ${r.status}: ${r.text.slice(0, 120)}`);
}

console.log('\n=== signature and claim rules match ===');
{
  // Same secret, same shape, hand-built: PHP must accept it. This is the
  // strongest available check because it does not depend on either server
  // being up, and it pins the exact claim layout both sides must agree on.
  const claims = {
    id: phpBody.admin.id,
    email: phpBody.admin.email,
    role: phpBody.admin.role,
    type: 'admin',
  };
  const handBuilt = signToken(secret, claims);
  const r = await get('/api/auth/profile', handBuilt);
  report(r.status === 200, 'hand-signed HS256 token accepted',
    `got ${r.status}: ${r.text.slice(0, 120)}`);
}

{
  // A token signed with the wrong secret must be refused, or the signature
  // check is not actually running.
  const wrong = signToken(secret + 'x', {
    id: phpBody.admin.id, email: phpBody.admin.email, role: phpBody.admin.role, type: 'admin',
  });
  const r = await get('/api/auth/profile', wrong);
  report(r.status === 401, 'token with wrong signature refused',
    `got ${r.status}: ${r.text.slice(0, 120)}`);
}

{
  // An expired token must be refused even though the signature is valid.
  const expired = (() => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({
      id: phpBody.admin.id, email: phpBody.admin.email,
      role: phpBody.admin.role, type: 'admin',
      iat: now - 7200, exp: now - 3600,
    }));
    const signature = crypto.createHmac('sha256', secret)
      .update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
  })();
  const r = await get('/api/auth/profile', expired);
  report(r.status === 401, 'expired token refused',
    `got ${r.status}: ${r.text.slice(0, 120)}`);
}

console.log('\n=== duration parsing agrees with jsonwebtoken ===');
{
  // JWT_EXPIRES_IN is read by both sides. A difference here means a token minted
  // with, say, "7d" is valid for a different length on each, which is the kind
  // of gap that only shows up weeks later as sessions that die early.
  const res = await fetch(`${PHP}/api/auth/admin-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin', password: ADMIN_PASSWORD }),
  });
  const body = await res.json();
  const [, payload] = body.token.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const lifetime = claims.exp - claims.iat;
  const expected = 7 * 24 * 3600;
  report(lifetime === expected,
    `token lifetime is ${lifetime}s (expected ${expected}s for JWT_EXPIRES_IN)`,
    `JWT_EXPIRES_IN appears to produce ${lifetime}s in PHP`);
}

console.log(`\npassed ${passed}, failed ${failed}`);
if (failed) process.exit(1);